import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

export interface TransferInfo {
  id: string;
  fileId?: string; // key for offered file lookup
  name: string;
  size: number;
  type: 'send' | 'receive';
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'paused';
  progress: number; // 0 to 100
  speed: number; // in bytes per second
  filePath?: string; // local path on desktop
  bytesTransferred: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  device?: string; // name of remote device
  deviceOS?: string; // OS of remote device
  isFolder?: boolean;
  peerId?: string; // device id of the remote (non-host) party; limits who sees this transfer
}

export class TransferEngine {
  private static instance: TransferEngine;
  private transfers: Map<string, TransferInfo> = new Map();
  // Map of fileId -> actual filePath on disk for offered files
  private offeredFiles: Map<string, string> = new Map();

  private defaultDownloadsFolder: string;

  private constructor() {
    this.defaultDownloadsFolder = path.join(os.homedir(), 'Downloads', 'Weshare');
    if (!fs.existsSync(this.defaultDownloadsFolder)) {
      try {
        fs.mkdirSync(this.defaultDownloadsFolder, { recursive: true });
      } catch (err) {
        console.error('Failed to create default downloads folder, using temporary folder', err);
        this.defaultDownloadsFolder = os.tmpdir();
      }
    }
  }

  public static getInstance(): TransferEngine {
    if (!TransferEngine.instance) {
      TransferEngine.instance = new TransferEngine();
    }
    return TransferEngine.instance;
  }

  public getDownloadsFolder(): string {
    return this.defaultDownloadsFolder;
  }

  public setDownloadsFolder(folderPath: string) {
    this.defaultDownloadsFolder = folderPath;
    if (!fs.existsSync(this.defaultDownloadsFolder)) {
      fs.mkdirSync(this.defaultDownloadsFolder, { recursive: true });
    }
  }

  public offerFile(filePath: string): string {
    // Unguessable id: knowing a fileId is part of what authorises a download.
    const fileId = crypto.randomBytes(16).toString('hex');
    this.offeredFiles.set(fileId, filePath);
    return fileId;
  }

  public getOfferedFilePath(fileId: string): string | undefined {
    return this.offeredFiles.get(fileId);
  }

  public registerUploadedFile(fileId: string, filePath: string) {
    this.offeredFiles.set(fileId, filePath);
  }


  public registerTransfer(transfer: TransferInfo) {
    this.transfers.set(transfer.id, transfer);
  }

  public updateProgress(id: string, bytesTransferred: number, speed: number) {
    const tx = this.transfers.get(id);
    if (tx && tx.status === 'transferring') {
      tx.bytesTransferred = bytesTransferred;
      tx.progress = tx.size > 0 ? Math.min(100, Math.round((bytesTransferred / tx.size) * 100)) : 100;
      tx.speed = speed;
    }
  }

  public completeTransfer(id: string) {
    const tx = this.transfers.get(id);
    if (tx) {
      tx.status = 'completed';
      tx.progress = 100;
      tx.speed = 0;
      tx.completedAt = new Date();
      this.reportTelemetry(tx);
    }
  }

  public failTransfer(id: string, errorMsg: string) {
    const tx = this.transfers.get(id);
    if (tx) {
      tx.status = 'failed';
      tx.speed = 0;
      tx.error = errorMsg;
      tx.completedAt = new Date();
      this.reportTelemetry(tx);
    }
  }

  private reportTelemetry(tx: TransferInfo) {
    try {
      const ext = path.extname(tx.name).toLowerCase();
      const { TelemetryQueue } = require('./telemetryQueue');

      const localOS = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

      const duration = tx.startedAt && tx.completedAt 
        ? (tx.completedAt.getTime() - tx.startedAt.getTime()) / 1000 
        : 0;

      // Anonymous: no file names or device names leave this computer.
      TelemetryQueue.getInstance().queueItem({
        transfer_id: tx.id,
        file_size: tx.size,
        file_type: ext || 'unknown',
        sender_os: tx.type === 'send' ? localOS : (tx.deviceOS || 'Unknown Mobile'),
        receiver_os: tx.type === 'receive' ? localOS : (tx.deviceOS || 'Unknown Mobile'),
        status: tx.status === 'completed' ? 'completed' : 'failed',
        speed_bytes_sec: tx.status === 'completed' && duration > 0 ? tx.size / duration : 0,
        duration_sec: duration,
        error_message: tx.error || ''
      });
    } catch (err) {
      console.error('[Telemetry] Error reporting transfer stats:', err);
    }
  }

  public getTransfer(id: string): TransferInfo | undefined {
    return this.transfers.get(id);
  }

  public getTransfers(): TransferInfo[] {
    return Array.from(this.transfers.values()).sort(
      (a, b) => (b.startedAt?.getTime() || 0) - (a.startedAt?.getTime() || 0)
    );
  }
}
