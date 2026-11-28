import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import https from 'https';
import os from 'os';
import crypto from 'crypto';

// Set only after a download finishes AND its SHA-256 matches the published checksum.
let verifiedInstallerPath = '';

// Updates come from this GitHub repository's releases. Only the repo owner can publish
// there, and GitHub records each uploaded file's SHA-256 itself, so nobody else can
// point the app at a different installer.
const GITHUB_OWNER = 'frankd3u9d39';
const GITHUB_REPO = 'Weshare2';
const INSTALLER_ASSETS: Record<string, string> = { win32: 'Weshare-Setup.exe' };

interface PendingUpdate {
  version: string;
  downloadUrl: string;
  sha256: string;
  notes: string;
}

// The release found by the last check. Downloads only ever use this, never a URL from the page.
let pendingUpdate: PendingUpdate | null = null;

const MAX_REDIRECTS = 5;
const SHA256_RE = /^[a-f0-9]{64}$/i;

// Updates may only be downloaded from GitHub release hosts.
function getAllowedHosts(): string[] {
  return ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
}

export function isVersionGreater(v1: string, v2: string): boolean {
  const a = String(v1).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(v2).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function getCurrentVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')).version;
  } catch (e) {
    return app.getVersion();
  }
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Weshare-Updater', Accept: 'application/vnd.github+json' },
      timeout: 15000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub answered ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Update check timed out')));
    req.on('error', reject);
  });
}

// Reads the latest (non-draft, non-prerelease) GitHub release and returns it if it is newer.
export async function checkGitHubForUpdate(currentVersion: string, platform: string = process.platform): Promise<PendingUpdate | null> {
  const assetName = INSTALLER_ASSETS[platform];
  if (!assetName) return null;
  const release = await fetchJson(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (!version || !isVersionGreater(version, currentVersion)) return null;
  const asset = (release.assets || []).find((a: any) => a && a.name === assetName);
  const digest = asset && typeof asset.digest === 'string' ? asset.digest : '';
  const sha256 = digest.toLowerCase().startsWith('sha256:') ? digest.slice(7) : '';
  if (!asset || !SHA256_RE.test(sha256) || !isAllowedUpdateUrl(asset.browser_download_url, getAllowedHosts())) {
    console.warn(`[Updater] Release ${version} has no usable ${assetName} with a checksum; ignoring it.`);
    return null;
  }
  return { version, downloadUrl: asset.browser_download_url, sha256: sha256.toLowerCase(), notes: String(release.body || '') };
}

export function isAllowedUpdateUrl(rawUrl: string, allowedHosts: string[]): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && allowedHosts.includes(url.hostname.toLowerCase());
  } catch (e) {
    return false;
  }
}

function downloadFile(
  url: string,
  destPath: string,
  allowedHosts: string[],
  getMainWindow: () => BrowserWindow | null,
  redirectsLeft = MAX_REDIRECTS
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!isAllowedUpdateUrl(url, allowedHosts)) {
      reject(new Error(`Update URL is not on an allowed https host: ${url}`));
      return;
    }

    https.get(url, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        downloadFile(next, destPath, allowedHosts, getMainWindow, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed: status code ${status}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const hash = crypto.createHash('sha256');
      const fileStream = fs.createWriteStream(destPath);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        hash.update(chunk);
        if (totalSize > 0) {
          getMainWindow()?.webContents.send('update-progress', Math.round((downloadedBytes / totalSize) * 100));
        }
      });

      response.on('error', reject);
      fileStream.on('error', reject);
      fileStream.on('finish', () => resolve(hash.digest('hex')));
      response.pipe(fileStream);
    }).on('error', reject);
  });
}

export function registerUpdaterHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle('get-app-version', () => getCurrentVersion());

  ipcMain.handle('check-for-update', async () => {
    try {
      pendingUpdate = await checkGitHubForUpdate(getCurrentVersion());
      if (pendingUpdate) console.log(`[Updater] Update available: ${pendingUpdate.version}`);
      return pendingUpdate ? { version: pendingUpdate.version, notes: pendingUpdate.notes } : null;
    } catch (err: any) {
      console.warn('[Updater] Update check failed:', err?.message || err);
      return null;
    }
  });

  ipcMain.handle('start-update-download', async () => {
    verifiedInstallerPath = '';
    if (!pendingUpdate) {
      console.error('[Updater] No update has been found to download.');
      return false;
    }
    const { downloadUrl, sha256: expectedSha256 } = pendingUpdate;

    if (typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)) {
      console.error('[Updater] Refusing update: release has no valid SHA-256 checksum.');
      return false;
    }

    let ext = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.zip';
    try {
      ext = path.extname(new URL(downloadUrl).pathname) || ext;
    } catch (e) {}
    const destPath = path.join(os.tmpdir(), `WeshareSetup${ext}`);
    try { fs.unlinkSync(destPath); } catch (e) {}

    try {
      const actual = await downloadFile(downloadUrl, destPath, getAllowedHosts(), getMainWindow);
      if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
        console.error(`[Updater] Checksum mismatch. Expected ${expectedSha256}, got ${actual}. Deleting download.`);
        try { fs.unlinkSync(destPath); } catch (e) {}
        return false;
      }
      verifiedInstallerPath = destPath;
      return true;
    } catch (err) {
      console.error('[Updater] Download failed:', err);
      try { fs.unlinkSync(destPath); } catch (e) {}
      return false;
    }
  });

  ipcMain.handle('install-update', async () => {
    if (!verifiedInstallerPath || !fs.existsSync(verifiedInstallerPath)) {
      console.error('[Updater] No verified installer to run.');
      return false;
    }

    try {
      console.log('[Updater] Launching verified installer:', verifiedInstallerPath);
      if (process.platform === 'win32') {
        // Install quietly over the current copy, then start the new version.
        const child = spawn(verifiedInstallerPath, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
        child.on('error', (e) => console.error('[Updater] Installer failed to start:', e));
        child.unref();
      } else {
        const errMsg = await shell.openPath(verifiedInstallerPath);
        if (errMsg) {
          console.error('[Updater] Error opening installer path:', errMsg);
          return false;
        }
      }

      setTimeout(() => {
        app.quit();
      }, 1500);

      return true;
    } catch (err) {
      console.error('[Updater] Error executing setup installer:', err);
      return false;
    }
  });
}
