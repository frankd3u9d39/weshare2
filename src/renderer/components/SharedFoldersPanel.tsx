import React, { useEffect, useState } from 'react';
import { FileArchive, FolderOpen, FolderPlus, Lock, Trash2 } from 'lucide-react';
import type { SharedFolderInfo } from '../electron.d';

const sectionLabel: React.CSSProperties = { fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 };
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 10px',
  borderRadius: '8px',
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid var(--glass-border)'
};
const smallBtn: React.CSSProperties = { fontSize: '11.5px', padding: '4px 10px', minWidth: 'unset' };

/** Host-only settings section: folders remembered devices can browse and download from. */
export const SharedFoldersPanel: React.FC = () => {
  const [shares, setShares] = useState<SharedFolderInfo[]>([]);
  const [unpackZips, setUnpackZips] = useState(true);
  const [encrypt, setEncrypt] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    window.electronAPI?.listShares?.().then(setShares).catch(() => {});
    window.electronAPI?.getAppSettings?.().then((s) => {
      setUnpackZips(s.unpackZips);
      setEncrypt(!!s.encryptConnections);
    }).catch(() => {});
  }, []);

  // Changing this restarts the server in the other mode; the window reloads and connected
  // devices are dropped, so phones scan the QR code again.
  const toggleEncrypt = async (enabled: boolean) => {
    setSwitching(true);
    setEncrypt(enabled);
    try {
      const saved = await window.electronAPI.updateAppSettings({ encryptConnections: enabled });
      setEncrypt(!!saved.encryptConnections);
    } finally {
      setSwitching(false);
    }
  };

  const toggleUnpack = async (enabled: boolean) => {
    setUnpackZips(enabled);
    const saved = await window.electronAPI.updateAppSettings({ unpackZips: enabled });
    setUnpackZips(saved.unpackZips);
  };

  const add = async () => setShares(await window.electronAPI.addShare());
  const remove = async (id: string) => setShares(await window.electronAPI.removeShare(id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', textAlign: 'left' }}>
      <span style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: '6px' }}>
        <FolderOpen size={13} /> SHARED FOLDERS
      </span>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.45 }}>
        Remembered devices can browse these folders and download from them whenever they're connected, without you accepting each file.
      </p>

      {shares.length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nothing shared yet.</span>}

      {shares.map((s) => (
        <div key={s.id} style={row}>
          <FolderOpen size={15} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600 }}>{s.name}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.path}>
              {s.path}
            </div>
          </div>
          <button
            type="button"
            className="interactive-btn"
            onClick={() => remove(s.id)}
            style={{ ...smallBtn, color: 'var(--error)' }}
            title={`Stop sharing ${s.name}`}
            aria-label={`Stop sharing ${s.name}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      <button type="button" className="interactive-btn" onClick={add} style={{ ...smallBtn, alignSelf: 'flex-start', padding: '6px 12px' }}>
        <FolderPlus size={13} /> Share a folder
      </button>

      <span style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
        <FileArchive size={13} /> RECEIVED ZIP FILES
      </span>
      <label style={{ ...row, cursor: 'pointer', alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={unpackZips}
          onChange={(e) => toggleUnpack(e.target.checked)}
          style={{ marginTop: '2px' }}
        />
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Unpack zip files into folders.</strong> Phones often can't send folders, so
          zip the folder on the phone and send the zip; it arrives here as the folder. The zip is kept if it can't be unpacked.
        </span>
      </label>

      <span style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
        <Lock size={13} /> CONNECTIONS
      </span>
      <label style={{ ...row, cursor: switching ? 'wait' : 'pointer', alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={encrypt}
          disabled={switching}
          onChange={(e) => toggleEncrypt(e.target.checked)}
          style={{ marginTop: '2px' }}
        />
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Encrypt connections.</strong> Recommended on shared Wi-Fi (school,
          office, café). Files and the PIN are encrypted, but phones show a one-time "connection is not private" warning:
          tap <em>Advanced</em> and then <em>Proceed</em>. Changing this disconnects devices; scan the QR code again.
        </span>
      </label>
    </div>
  );
};
