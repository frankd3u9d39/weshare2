// Shared formatting helpers. Previously duplicated verbatim across App, HistoryList,
// SendScreen and AdminDashboard.

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatSpeed(bytesPerSec: number): string {
  return formatSize(bytesPerSec) + '/s';
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

// Normalizes a telemetry file_type into a bare lowercase extension.
// Telemetry writes path.extname() output, which keeps the leading dot ('.mkv'),
// so anything comparing against bare extensions has to strip it first.
export function normalizeExt(fileType?: string): string {
  const raw = (fileType || '').trim().toLowerCase();
  if (!raw || raw === 'unknown') return 'unknown';
  return raw.startsWith('.') ? raw.slice(1) : raw;
}

// Spreadsheet apps treat a leading =, +, -, @ (or tab/CR) as the start of a formula.
// Audit exports contain remote-supplied file and device names, so every field is
// prefixed with a quote before quoting to keep them inert on open.
export function csvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  const needsGuard = /^[=+\-@\t\r]/.test(str);
  const guarded = needsGuard ? `'${str}` : str;
  return `"${guarded.replace(/"/g, '""')}"`;
}
