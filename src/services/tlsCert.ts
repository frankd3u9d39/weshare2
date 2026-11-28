import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

// selfsigned's bundled types pull in node-forge's types, which aren't installed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const selfsigned: {
  generate: (attrs: { name: string; value: string }[], opts: Record<string, unknown>) => { private: string; cert: string };
} = require('selfsigned');

export interface TlsMaterial {
  key: string;
  cert: string;
  /** Node-style SHA-256 fingerprint, e.g. "AB:CD:...". Used to pin this host. */
  fingerprint256: string;
}

const KEY_FILE = 'weshare-tls-key.pem';
const CERT_FILE = 'weshare-tls-cert.pem';
const VALID_DAYS = 825;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function localIPv4s(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

function generate(): { key: string; cert: string } {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...localIPv4s().map((ip) => ({ type: 7, ip }))
  ];
  const result = selfsigned.generate([{ name: 'commonName', value: `Weshare ${os.hostname()}` }], {
    days: VALID_DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  });
  return { key: result.private, cert: result.cert };
}

/**
 * Loads this install's HTTPS certificate from `dir`, creating one on first run
 * (or when it is about to expire). The same certificate is reused across restarts
 * so other WeShare computers see a stable fingerprint.
 */
export function loadOrCreateTls(dir: string): TlsMaterial {
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, KEY_FILE);
  const certPath = path.join(dir, CERT_FILE);

  let key = '';
  let cert = '';
  try {
    key = fs.readFileSync(keyPath, 'utf-8');
    cert = fs.readFileSync(certPath, 'utf-8');
    const x509 = new crypto.X509Certificate(cert);
    if (new Date(x509.validTo).getTime() - Date.now() < RENEW_BEFORE_MS || !x509.checkPrivateKey(crypto.createPrivateKey(key))) {
      key = '';
    }
  } catch (e) {
    key = '';
  }

  if (!key) {
    ({ key, cert } = generate());
    fs.writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(certPath, cert, { encoding: 'utf-8' });
    console.log('[TLS] Generated a new self-signed certificate.');
  }

  return { key, cert, fingerprint256: new crypto.X509Certificate(cert).fingerprint256 };
}
