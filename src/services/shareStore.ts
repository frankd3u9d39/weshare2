import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sanitizeRelativePath } from './pathSafety';

/*
 * Folders the host has chosen to share. Remembered devices can browse these folders
 * and download from them without the host accepting each file. Nothing outside a
 * shared folder can be reached: every requested path is cleaned, joined under the
 * folder, then resolved through symlinks and checked again.
 */

export interface SharedFolder {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface ShareEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

export class ShareError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class ShareStore {
  private static instance: ShareStore;
  private filePath: string | null = null;
  private shares = new Map<string, SharedFolder>();

  public static getInstance(): ShareStore {
    if (!ShareStore.instance) ShareStore.instance = new ShareStore();
    return ShareStore.instance;
  }

  public init(filePath: string) {
    this.filePath = filePath;
    this.shares.clear();
    try {
      const list: SharedFolder[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const s of list) {
        if (s && typeof s.id === 'string' && typeof s.path === 'string') this.shares.set(s.id, s);
      }
    } catch (e) {
      // first run or unreadable file: nothing shared
    }
  }

  private save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify([...this.shares.values()], null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {
      console.error('[ShareStore] Could not save shared folders:', e);
    }
  }

  public list(): SharedFolder[] {
    return [...this.shares.values()];
  }

  public add(folderPath: string): SharedFolder {
    const resolved = fs.realpathSync(path.resolve(folderPath));
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Not a folder');
    const existing = this.list().find((s) => s.path === resolved);
    if (existing) return existing;
    const share: SharedFolder = {
      id: crypto.randomBytes(8).toString('hex'),
      name: path.basename(resolved) || resolved,
      path: resolved,
      addedAt: new Date().toISOString()
    };
    this.shares.set(share.id, share);
    this.save();
    return share;
  }

  public remove(id: string): boolean {
    const removed = this.shares.delete(id);
    if (removed) this.save();
    return removed;
  }

  /** Resolves a path inside a share to a real location, refusing anything that escapes it. */
  public resolve(id: string, relPath: string): { share: SharedFolder; fullPath: string; segments: string[] } {
    const share = this.shares.get(id);
    if (!share) throw new ShareError(404, 'Shared folder not found');
    let root: string;
    try {
      root = fs.realpathSync(share.path);
    } catch (e) {
      throw new ShareError(404, 'Shared folder is no longer available');
    }
    let segments: string[];
    try {
      segments = sanitizeRelativePath(String(relPath || ''));
    } catch (e) {
      throw new ShareError(400, 'Invalid path');
    }
    // Reject paths that were changed by cleaning (e.g. "..") rather than quietly using another one.
    const requested = String(relPath || '').split('/').filter((s) => s && s !== '.');
    if (requested.length !== segments.length || requested.some((s, i) => s !== segments[i])) {
      throw new ShareError(400, 'Invalid path');
    }
    const joined = path.join(root, ...segments);
    let real: string;
    try {
      real = fs.realpathSync(joined);
    } catch (e) {
      throw new ShareError(404, 'Not found');
    }
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ShareError(403, 'Outside the shared folder');
    return { share, fullPath: real, segments };
  }

  public listDir(id: string, relPath: string): ShareEntry[] {
    const { fullPath } = this.resolve(id, relPath);
    if (!fs.statSync(fullPath).isDirectory()) throw new ShareError(400, 'Not a folder');
    const entries: ShareEntry[] = [];
    for (const dirent of fs.readdirSync(fullPath, { withFileTypes: true })) {
      if (dirent.isSymbolicLink() || (!dirent.isFile() && !dirent.isDirectory())) continue;
      try {
        const stat = fs.statSync(path.join(fullPath, dirent.name));
        entries.push({
          name: dirent.name,
          isDir: dirent.isDirectory(),
          size: dirent.isDirectory() ? 0 : stat.size,
          modified: stat.mtime.toISOString()
        });
      } catch (e) {
        // unreadable entry: leave it out
      }
    }
    return entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }
}
