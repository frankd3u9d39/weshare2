import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { FIREBASE_CONFIG, TELEMETRY_COLLECTION, firestoreDocumentsUrl, isFirebaseConfigured } from './firebaseConfig';

/*
 * Anonymous transfer stats. Each finished transfer is queued in a local JSON file and sent
 * to Firestore when the computer is online. No file names or device names are sent: only
 * sizes, file type, speed, OS and whether it worked. Firestore rules only allow adding
 * records of exactly this shape.
 */

export interface TelemetryItem {
  transfer_id: string;
  file_size: number;
  file_type: string;
  sender_os: string;
  receiver_os: string;
  status: 'completed' | 'failed';
  speed_bytes_sec: number;
  duration_sec: number;
  error_message: string;
  app_version: string;
  created_at: string;
}

const MAX_QUEUE = 1000;
const SEND_PER_ROUND = 50;
const SYNC_INTERVAL_MS = 60_000;

const short = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

// Firestore document ids can't contain '/', and must be short.
const docId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || `t_${Date.now()}`;

function toFirestoreFields(item: TelemetryItem) {
  return {
    transfer_id: { stringValue: item.transfer_id },
    file_size: { integerValue: String(Math.round(item.file_size)) },
    file_type: { stringValue: item.file_type },
    sender_os: { stringValue: item.sender_os },
    receiver_os: { stringValue: item.receiver_os },
    status: { stringValue: item.status },
    speed_bytes_sec: { doubleValue: item.speed_bytes_sec },
    duration_sec: { doubleValue: item.duration_sec },
    error_message: { stringValue: item.error_message },
    app_version: { stringValue: item.app_version },
    created_at: { timestampValue: item.created_at }
  };
}

export class TelemetryQueue {
  private static instance: TelemetryQueue;
  private queueFile: string;
  private queue: TelemetryItem[] = [];
  private isProcessing = false;

  private constructor() {
    let baseDir = '';
    try {
      baseDir = app.getPath('userData');
    } catch (e) {
      baseDir = path.join(os.homedir(), '.weshare');
    }
    fs.mkdirSync(baseDir, { recursive: true });

    this.queueFile = path.join(baseDir, 'telemetry-queue.json');
    this.loadQueue();

    // The old Supabase settings file is no longer used.
    try {
      fs.rmSync(path.join(baseDir, 'weshare-config.json'), { force: true });
    } catch (e) {}

    setInterval(() => this.processQueue(), SYNC_INTERVAL_MS);
  }

  public static getInstance(): TelemetryQueue {
    if (!TelemetryQueue.instance) {
      TelemetryQueue.instance = new TelemetryQueue();
    }
    return TelemetryQueue.instance;
  }

  private loadQueue() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.queueFile, 'utf-8'));
      // Records queued by older versions held device and file names; keep only the safe fields.
      this.queue = (Array.isArray(saved) ? saved : []).map((r: any) => this.clean(r)).filter(Boolean) as TelemetryItem[];
      // Rewrite the file now so names from older versions don't stay on disk.
      if (JSON.stringify(saved) !== JSON.stringify(this.queue)) this.saveQueue();
    } catch (e) {
      this.queue = [];
    }
  }

  private saveQueue() {
    try {
      fs.writeFileSync(this.queueFile, JSON.stringify(this.queue, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Telemetry] Failed to write queue file:', e);
    }
  }

  private clean(r: any): TelemetryItem | null {
    if (!r || typeof r.transfer_id !== 'string') return null;
    const created = new Date(r.created_at);
    return {
      transfer_id: short(r.transfer_id, 120),
      file_size: num(r.file_size),
      file_type: short(r.file_type || 'unknown', 20),
      sender_os: short(r.sender_os || 'Unknown', 40),
      receiver_os: short(r.receiver_os || 'Unknown', 40),
      status: r.status === 'completed' ? 'completed' : 'failed',
      speed_bytes_sec: num(r.speed_bytes_sec),
      duration_sec: num(r.duration_sec),
      error_message: short(r.error_message, 300),
      app_version: short(r.app_version || app.getVersion?.() || '', 20),
      created_at: (isNaN(created.getTime()) ? new Date() : created).toISOString()
    };
  }

  public queueItem(item: Omit<TelemetryItem, 'created_at' | 'app_version'>) {
    const full = this.clean({ ...item, app_version: app.getVersion(), created_at: new Date().toISOString() });
    if (!full) return;
    this.queue.push(full);
    this.queue = this.queue.slice(-MAX_QUEUE);
    this.saveQueue();
    this.processQueue();
  }

  public async processQueue() {
    if (this.isProcessing || this.queue.length === 0 || !isFirebaseConfigured()) return;
    this.isProcessing = true;

    const batch = this.queue.slice(0, SEND_PER_ROUND);
    const sent = new Set<string>();
    try {
      for (const item of batch) {
        const url =
          `${firestoreDocumentsUrl()}/${TELEMETRY_COLLECTION}` +
          `?documentId=${encodeURIComponent(docId(item.transfer_id))}&key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: toFirestoreFields(item) }),
          signal: AbortSignal.timeout(15000)
        });
        // 409: already sent earlier (the reply got lost). 400/403: the record will never be
        // accepted (bad shape or rules), so drop it rather than retry it forever.
        if (res.ok || res.status === 409 || res.status === 400 || res.status === 403) {
          if (!res.ok && res.status !== 409) {
            console.warn(`[Telemetry] Firestore refused a record (${res.status}); dropping it.`);
          }
          sent.add(item.transfer_id);
        } else {
          console.warn(`[Telemetry] Firestore answered ${res.status}; will retry later.`);
          break;
        }
      }
    } catch (err: any) {
      // Offline or Firestore unreachable: keep everything for the next round.
    } finally {
      if (sent.size > 0) {
        this.queue = this.queue.filter((q) => !sent.has(q.transfer_id));
        this.saveQueue();
        console.log(`[Telemetry] Sent ${sent.size} record(s); ${this.queue.length} waiting.`);
      }
      this.isProcessing = false;
    }
  }
}
