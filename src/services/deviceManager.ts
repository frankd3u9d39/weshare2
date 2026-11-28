import os from 'os';
import crypto from 'crypto';
import { TrustStore } from './trustStore';

export interface PeerDevice {
  id: string;
  name: string;
  ip: string;
  type: 'phone' | 'desktop';
  os: string;
  connectedAt: Date;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

interface AttemptRecord {
  count: number;
  lockedUntil: number;
}

export class DeviceManager {
  private static instance: DeviceManager;
  private currentToken: string = '';
  private connectedPeers: Map<string, PeerDevice> = new Map();
  private failedAttempts: Map<string, AttemptRecord> = new Map();

  private constructor() {
    this.regenerateToken();
  }

  public static getInstance(): DeviceManager {
    if (!DeviceManager.instance) {
      DeviceManager.instance = new DeviceManager();
    }
    return DeviceManager.instance;
  }

  public getLocalIPs(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const interfaceName of Object.keys(interfaces)) {
      const netInterfaces = interfaces[interfaceName];
      if (!netInterfaces) continue;
      for (const netInterface of netInterfaces) {
        // Skip loopback and non-IPv4 addresses
        if (netInterface.family === 'IPv4' && !netInterface.internal) {
          ips.push(netInterface.address);
        }
      }
    }
    // Fallback to localhost if no active interface
    if (ips.length === 0) {
      ips.push('127.0.0.1');
    }
    return ips;
  }

  public getSessionToken(): string {
    return this.currentToken;
  }

  public regenerateToken(): string {
    const pin = crypto.randomInt(100000, 1000000).toString();
    this.currentToken = pin;
    return this.currentToken;
  }

  public validateToken(token: string, remoteIp?: string): boolean {
    return this.authenticate(token, remoteIp).ok;
  }

  /**
   * Accepts either the current pairing PIN or a trusted device's personal token.
   * `trustedDeviceId` is set when a device token was used, so the caller can bind
   * the connection to that device. Wrong attempts of either kind count toward lockout.
   */
  public authenticate(token: string, remoteIp?: string): { ok: boolean; trustedDeviceId?: string } {
    const key = remoteIp || '';
    if (key) {
      const record = this.failedAttempts.get(key);
      if (record && record.lockedUntil > Date.now()) {
        return { ok: false };
      }
    }

    let trustedDeviceId: string | undefined;
    if (TrustStore.isDeviceToken(token)) {
      trustedDeviceId = TrustStore.getInstance().verifyToken(token) ?? undefined;
    }
    const isValid = !!trustedDeviceId || (!!token && token === this.currentToken);

    if (key) {
      if (isValid) {
        this.failedAttempts.delete(key);
      } else {
        const record = this.failedAttempts.get(key) || { count: 0, lockedUntil: 0 };
        record.count += 1;
        if (record.count >= MAX_FAILED_ATTEMPTS) {
          record.lockedUntil = Date.now() + LOCKOUT_MS;
          record.count = 0;
        }
        this.failedAttempts.set(key, record);
      }
    }

    return { ok: isValid, trustedDeviceId };
  }

  public registerPeer(peer: PeerDevice) {
    this.connectedPeers.set(peer.id, peer);
  }

  public removePeer(peerId: string) {
    this.connectedPeers.delete(peerId);
  }

  public getPeers(): PeerDevice[] {
    return Array.from(this.connectedPeers.values());
  }

  public getDeviceName(): string {
    return os.hostname() || 'Weshare Desktop';
  }
}
