import React from 'react';
import { ShieldCheck, Smartphone, Laptop, Trash2 } from 'lucide-react';

export interface TrustedDeviceView {
  id: string;
  name: string;
  os: string;
  type: 'phone' | 'desktop';
  autoAccept: boolean;
  lastSeen: string;
  connected: boolean;
}

interface ConnectedPeer {
  id: string;
  name: string;
  os: string;
  type: 'phone' | 'desktop';
  trusted?: boolean;
}

interface Props {
  peers: ConnectedPeer[];
  trustedDevices: TrustedDeviceView[];
  onTrust: (deviceId: string) => void;
  onForget: (deviceId: string) => void;
  onSetAutoAccept: (deviceId: string, enabled: boolean) => void;
}

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

const DeviceIcon = ({ type }: { type: string }) => (type === 'desktop' ? <Laptop size={15} /> : <Smartphone size={15} />);

const formatLastSeen = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Host-only settings section: remember connected devices, toggle auto-accept, forget them. */
export const TrustedDevicesPanel: React.FC<Props> = ({ peers, trustedDevices, onTrust, onForget, onSetAutoAccept }) => {
  const untrustedPeers = peers.filter((p) => !p.trusted && p.id !== 'desktop-main');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', textAlign: 'left' }}>
      <span style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: '6px' }}>
        <ShieldCheck size={13} /> REMEMBERED DEVICES
      </span>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.45 }}>
        Remembered devices reconnect without the PIN. Turn on auto-accept to receive their files without being asked.
      </p>

      {trustedDevices.length === 0 && (
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No remembered devices yet.</span>
      )}

      {trustedDevices.map((d) => (
        <div key={d.id} style={row}>
          <DeviceIcon type={d.type} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>
              {d.name}
            </div>
            <div style={{ fontSize: '11px', color: d.connected ? 'var(--success)' : 'var(--text-muted)' }}>
              {d.connected ? 'Connected' : `Last seen ${formatLastSeen(d.lastSeen)}`} · {d.os}
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={d.autoAccept}
              onChange={(e) => onSetAutoAccept(d.id, e.target.checked)}
            />
            Auto-accept
          </label>
          <button
            type="button"
            className="interactive-btn"
            onClick={() => onForget(d.id)}
            style={{ ...smallBtn, color: 'var(--error)' }}
            title={`Forget ${d.name}`}
            aria-label={`Forget ${d.name}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      {untrustedPeers.length > 0 && (
        <>
          <span style={{ ...sectionLabel, marginTop: '4px' }}>CONNECTED NOW</span>
          {untrustedPeers.map((p) => (
            <div key={p.id} style={row}>
              <DeviceIcon type={p.type} />
              <div style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </div>
              <button type="button" className="interactive-btn primary" onClick={() => onTrust(p.id)} style={smallBtn}>
                Remember
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
};
