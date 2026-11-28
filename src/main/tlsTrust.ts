import https from 'https';
import tls from 'tls';
import net from 'net';
import crypto from 'crypto';
import type { App, Session } from 'electron';

/*
 * WeShare computers use self-signed certificates, so normal certificate checks
 * would reject them. Instead we pin fingerprints:
 *  - our own server's certificate is always trusted;
 *  - another computer's fingerprint is remembered the first time we see it
 *    (from LAN discovery or the first connection) and must match afterwards.
 * Only private/LAN addresses get this treatment; public sites keep normal checks.
 */

let ownFingerprint = '';
const pinnedByHost = new Map<string, string>();

export function setOwnFingerprint(fp: string) {
  ownFingerprint = fp.toUpperCase();
}

export function rememberDiscoveredFingerprint(host: string, fp: unknown) {
  if (typeof fp === 'string' && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fp) && !pinnedByHost.has(host)) {
    pinnedByHost.set(host, fp.toUpperCase());
  }
}

const FP_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i;

/** Sets the expected certificate for a remembered host, overriding any first-use pin. */
export function pinHostFingerprint(host: string, fp: string): boolean {
  if (!host || !FP_RE.test(fp) || !isPrivateHost(host)) return false;
  pinnedByHost.set(host, fp.toUpperCase());
  return true;
}

export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  if (!net.isIPv4(h)) return false;
  const [a, b] = h.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** Returns true if `fp` is an acceptable certificate for `host`, pinning it on first use. */
export function checkPeerFingerprint(host: string, fp: string): boolean {
  const upper = fp.toUpperCase();
  if (ownFingerprint && upper === ownFingerprint) return true;
  if (!isPrivateHost(host)) return false;

  const pinned = pinnedByHost.get(host);
  if (pinned) {
    if (pinned !== upper) {
      console.warn(`[TLS] Certificate for ${host} changed (expected ${pinned}, got ${upper}). Refusing connection.`);
      return false;
    }
    return true;
  }
  pinnedByHost.set(host, upper);
  console.log(`[TLS] Trusting ${host} on first use: ${upper}`);
  return true;
}

/**
 * Chromium side, via the app's `certificate-error` event: when a page's https/wss
 * request hits a certificate Chromium can't verify (our self-signed ones), accept it
 * only if it passes the pinning rules. This runs in the main process, so unlike a
 * network-service verify proc it keeps working if the network service restarts.
 */
export function installCertificateErrorHandler(electronApp: App) {
  electronApp.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    try {
      const host = new URL(url).hostname;
      const fp = new crypto.X509Certificate(certificate.data).fingerprint256;
      if (checkPeerFingerprint(host, fp)) {
        event.preventDefault();
        callback(true);
        return;
      }
    } catch (e) {}
    callback(false);
  });
}

/** Chromium side: applies the pinning rules to the app window's https/wss requests. */
export function installCertificateVerifier(ses: Session) {
  ses.setCertificateVerifyProc((request, callback) => {
    if (request.verificationResult === 'net::OK') {
      callback(-3); // a normally valid certificate: use Chromium's own decision
      return;
    }
    try {
      const fp = new crypto.X509Certificate(request.certificate.data).fingerprint256;
      callback(checkPeerFingerprint(request.hostname, fp) ? 0 : -2);
    } catch (e) {
      callback(-2);
    }
  });
}

/**
 * Node side: an https agent for the main process's own transfers. The request is only
 * handed the socket (and so only sends the PIN) after the fingerprint has been checked.
 */
export const pinnedAgent = new https.Agent({ keepAlive: false });
(pinnedAgent as any).createConnection = (options: any, cb: (err: Error | null, socket?: net.Socket) => void) => {
  const host: string = options.host || options.hostname || 'localhost';
  const connectOptions = { ...options, rejectUnauthorized: false };
  if (!connectOptions.servername || net.isIP(connectOptions.servername)) delete connectOptions.servername;

  let settled = false;
  const socket = tls.connect(connectOptions);
  socket.once('secureConnect', () => {
    if (settled) return;
    settled = true;
    const fp = socket.getPeerCertificate()?.fingerprint256;
    if (fp && checkPeerFingerprint(host, fp)) {
      cb(null, socket);
    } else {
      socket.destroy();
      cb(new Error(`Untrusted certificate for ${host}`));
    }
  });
  socket.once('error', (err) => {
    if (settled) return;
    settled = true;
    cb(err);
  });
  return undefined;
};
