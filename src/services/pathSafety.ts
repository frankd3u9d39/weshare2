import path from 'path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// Strips directory components, replaces characters Windows can't store (names from phones
// and Macs may contain them), and rejects empty/dot-only names.
export function sanitizeFileName(name: string): string {
  let base = path.basename(String(name ?? '').replace(/\\/g, '/')).trim();
  base = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  if (base.length > 200) {
    const ext = path.extname(base).slice(0, 20);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  if (!base || base === '.' || base === '..') {
    throw new Error('Invalid file name');
  }
  return base;
}

// Turns a sender-supplied relative path like "Photos/2024/a.jpg" into safe path segments,
// dropping anything that would climb out of the destination folder.
export function sanitizeRelativePath(relPath: string): string[] {
  return String(relPath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => sanitizeFileName(s))
    .slice(0, 32);
}

// Content-Disposition value that keeps non-ASCII names intact in every browser.
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// Joins segments onto baseDir and throws if the resolved result would escape baseDir.
export function safeJoin(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, ...segments);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw new Error('Resolved path escapes base directory');
  }
  return target;
}

// Allowlist for identifiers (transferIds, chunk indices) used to build file names on disk.
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID_RE.test(id);
}
