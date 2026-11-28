import fs from 'fs';
import path from 'path';

/* Small host-side preferences that the server needs (it runs in the main process). */

export interface AppSettings {
  /** Unpack .zip files that other devices send, so a zipped folder arrives as a folder. */
  unpackZips: boolean;
  /** Serve phones and other computers over HTTPS/WSS instead of plain HTTP/WS. Off by default:
   *  browsers warn about this install's self-made certificate, which confuses people. */
  encryptConnections: boolean;
}

const DEFAULTS: AppSettings = { unpackZips: true, encryptConnections: false };

let filePath: string | null = null;
let current: AppSettings = { ...DEFAULTS };

export function initAppSettings(file: string) {
  filePath = file;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    current = {
      unpackZips: saved && typeof saved.unpackZips === 'boolean' ? saved.unpackZips : DEFAULTS.unpackZips,
      encryptConnections: !!(saved && saved.encryptConnections)
    };
  } catch (e) {
    current = { ...DEFAULTS };
  }
}

export function getAppSettings(): AppSettings {
  return { ...current };
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  if (typeof patch.unpackZips === 'boolean') current.unpackZips = patch.unpackZips;
  if (typeof patch.encryptConnections === 'boolean') current.encryptConnections = patch.encryptConnections;
  if (filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Settings] Could not save settings:', e);
    }
  }
  return getAppSettings();
}
