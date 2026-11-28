import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/*
 * Devices the host has chosen to remember. A trusted device reconnects with a
 * personal key instead of the pairing PIN. Only a SHA-256 hash of each key is
 * stored, so reading this file doesn't let anyone impersonate a device.
 *
 * Device tokens look like "t.<deviceId>.<secret>" and are used wherever the PIN
 * would be (WebSocket URL, ?token= on uploads/downloads).
 */

export interface TrustedDevice {
  id: string;
  name: string;
  os: string;
  type: 'phone' | 'desktop';
  autoAccept: boolean;
  createdAt: string;
  lastSeen: string;
}

interface StoredDevice extends TrustedDevice {
  keyHash: string;
}

const TOKEN_RE = /^t\.([A-Za-z0-9_-]{1,128})\.([a-f0-9]{64})$/;

const hashKey = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');

export class TrustStore {
  private static instance: TrustStore;
  private filePath: string | null = null;
  private devices = new Map<string, StoredDevice>();

  public static getInstance(): TrustStore {
    if (!TrustStore.instance) TrustStore.instance = new TrustStore();
    return TrustStore.instance;
  }

  /** Point the store at its JSON file and load it. Without this it stays in memory only. */
  public init(filePath: string) {
    this.filePath = filePath;
    this.devices.clear();
    try {
      const list: StoredDevice[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const d of list) {
        if (d && typeof d.id === 'string' && typeof d.keyHash === 'string') this.devices.set(d.id, d);
      }
    } catch (e) {
      // first run or unreadable file: start empty
    }
  }

  private save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify([...this.devices.values()], null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {
      console.error('[Trust] Failed to save trusted devices:', e);
    }
  }

  public list(): TrustedDevice[] {
    return [...this.devices.values()].map(({ keyHash, ...rest }) => rest);
  }

  public get(id: string): TrustedDevice | undefined {
    const d = this.devices.get(id);
    if (!d) return undefined;
    const { keyHash, ...rest } = d;
    return rest;
  }

  public has(id: string): boolean {
    return this.devices.has(id);
  }

  /** Trusts a device (or issues it a fresh key) and returns the token to hand to it. */
  public add(device: { id: string; name: string; os: string; type: 'phone' | 'desktop' }): string {
    const secret = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const existing = this.devices.get(device.id);
    this.devices.set(device.id, {
      id: device.id,
      name: device.name,
      os: device.os,
      type: device.type,
      autoAccept: existing?.autoAccept ?? false,
      createdAt: existing?.createdAt ?? now,
      lastSeen: now,
      keyHash: hashKey(secret)
    });
    this.save();
    return `t.${device.id}.${secret}`;
  }

  public remove(id: string): boolean {
    const removed = this.devices.delete(id);
    if (removed) this.save();
    return removed;
  }

  public setAutoAccept(id: string, enabled: boolean): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    d.autoAccept = enabled;
    this.save();
    return true;
  }

  public touch(id: string, name?: string) {
    const d = this.devices.get(id);
    if (!d) return;
    d.lastSeen = new Date().toISOString();
    if (name) d.name = name;
    this.save();
  }

  public static isDeviceToken(token: unknown): token is string {
    return typeof token === 'string' && token.startsWith('t.');
  }

  /** Returns the device id a token belongs to, or null if it isn't valid. */
  public verifyToken(token: string): string | null {
    const m = TOKEN_RE.exec(token);
    if (!m) return null;
    const d = this.devices.get(m[1]);
    if (!d) return null;
    const a = Buffer.from(hashKey(m[2]), 'hex');
    const b = Buffer.from(d.keyHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? d.id : null;
  }
}
