import React, { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Download, File, FolderOpen, HardDrive, Loader2, RefreshCw } from 'lucide-react';
import { formatSize } from '../utils/format';

interface Share {
  id: string;
  name: string;
}

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface Props {
  /** e.g. "https://192.168.1.20:5003" */
  baseUrl: string;
  /** This device's own key from the computer (shared folders need it, not the PIN). */
  token: string | null;
  hostName: string;
  /** Starts a download of the given URL; `isFolder` means it's a zip to unpack. */
  onDownload: (url: string, name: string, size: number, isFolder: boolean) => void;
}

/** Lets a remembered device look through the folders its computer shares. */
export const BrowseScreen: React.FC<Props> = ({ baseUrl, token, hostName, onDownload }) => {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  const [segments, setSegments] = useState<string[]>([]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const api = useCallback(
    (route: string, relPath?: string) => {
      const params = new URLSearchParams({ token: token || '' });
      if (relPath !== undefined) params.set('path', relPath);
      return `${baseUrl}${route}?${params.toString()}`;
    },
    [baseUrl, token]
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      if (!share) {
        const res = await fetch(api('/api/shares'));
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
        setShares(body.shares);
        setEntries(null);
      } else {
        const res = await fetch(api(`/api/shares/${share.id}/list`, segments.join('/')));
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
        setEntries(body.entries);
      }
    } catch (err: any) {
      setError(err.message || 'Could not reach the computer');
    } finally {
      setLoading(false);
    }
  }, [api, share, segments, token]);

  useEffect(() => {
    load();
  }, [load]);

  const openShare = (s: Share) => {
    setShare(s);
    setSegments([]);
  };
  const goTo = (depth: number) => {
    if (depth < 0) {
      setShare(null);
      setSegments([]);
    } else {
      setSegments((prev) => prev.slice(0, depth));
    }
  };

  const downloadEntry = (entry: Entry) => {
    if (!share) return;
    const relPath = [...segments, entry.name].join('/');
    if (entry.isDir) {
      onDownload(api(`/api/shares/${share.id}/zip`, relPath), entry.name, 0, true);
    } else {
      onDownload(api(`/api/shares/${share.id}/file`, relPath), entry.name, entry.size, false);
    }
  };

  if (!token) {
    return (
      <div className="glass-panel" style={{ padding: '28px', textAlign: 'center' }}>
        <HardDrive size={32} style={{ color: 'var(--primary-light)', marginBottom: '10px' }} />
        <h3 style={{ fontSize: '15px', marginBottom: '6px' }}>Browse {hostName}</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: '340px', margin: '0 auto' }}>
          Only remembered devices can browse shared folders. On the computer, open Settings and press
          <strong> Remember</strong> next to this device, then come back here.
        </p>
      </div>
    );
  }

  const crumbStyle: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--primary-light)', cursor: 'pointer', padding: 0, fontSize: '13px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', animation: 'fadeIn 0.3s ease-out' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Browse {hostName}</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Folders this computer shares with you</p>
        </div>
        <button className="interactive-btn" onClick={load} style={{ padding: '6px 10px' }} aria-label="Refresh" title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Breadcrumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', fontSize: '13px' }}>
        <button style={crumbStyle} onClick={() => goTo(-1)}>Shared folders</button>
        {share && (
          <>
            <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />
            <button style={crumbStyle} onClick={() => goTo(0)}>{share.name}</button>
          </>
        )}
        {segments.map((seg, i) => (
          <React.Fragment key={i}>
            <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />
            <button style={crumbStyle} onClick={() => goTo(i + 1)}>{seg}</button>
          </React.Fragment>
        ))}
      </div>

      {error && <div style={{ color: 'var(--error)', fontSize: '13px' }}>{error}</div>}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '13px' }}>
          <Loader2 size={14} style={{ animation: 'ring-spin 1.2s linear infinite' }} /> Loading…
        </div>
      )}

      <div className="selected-files-list" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {!share && shares && shares.length === 0 && !loading && (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {hostName} isn't sharing any folders. On the computer, open Settings → Shared folders.
          </span>
        )}
        {!share &&
          shares?.map((s) => (
            <button key={s.id} className="selected-file-card" onClick={() => openShare(s)} style={{ padding: '10px 12px', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
              <div className="selected-file-info">
                <FolderOpen size={15} style={{ color: 'var(--primary-light)', flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{s.name}</span>
              </div>
              <ChevronRight size={14} />
            </button>
          ))}

        {share && entries && entries.length === 0 && !loading && (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>This folder is empty.</span>
        )}
        {share &&
          entries?.map((entry) => (
            <div key={entry.name} className="selected-file-card" style={{ padding: '8px 12px' }}>
              <div
                className="selected-file-info"
                style={{ flex: 1, minWidth: 0, cursor: entry.isDir ? 'pointer' : 'default' }}
                onClick={() => entry.isDir && setSegments((prev) => [...prev, entry.name])}
              >
                {entry.isDir ? (
                  <FolderOpen size={14} style={{ color: 'var(--primary-light)', flexShrink: 0 }} />
                ) : (
                  <File size={14} style={{ color: 'var(--primary-light)', flexShrink: 0 }} />
                )}
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.name}>
                  {entry.name}
                </span>
                {!entry.isDir && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px', flexShrink: 0 }}>({formatSize(entry.size)})</span>
                )}
              </div>
              <button
                className="interactive-btn"
                onClick={() => downloadEntry(entry)}
                style={{ padding: '4px 10px', fontSize: '11.5px', minWidth: 'unset' }}
                title={entry.isDir ? `Download ${entry.name} as a folder` : `Download ${entry.name}`}
                aria-label={`Download ${entry.name}`}
              >
                <Download size={13} />
              </button>
            </div>
          ))}
      </div>
    </div>
  );
};
