import React from 'react';
import { Smartphone, Laptop, Tablet, Wifi, Loader2, Signal, Send, QrCode } from 'lucide-react';

interface Peer {
  id: string;
  name: string;
  ip: string;
  type: 'phone' | 'desktop';
  os: string;
}

interface DashboardProps {
  peers: Peer[];
  discoveredDevices?: any[];
  deviceName: string;
  ips: string[];
  port: number;
  isElectron: boolean;
  isHost: boolean;
  token?: string;
  onNavigate: (screen: 'send' | 'receive' | 'dashboard') => void;
  onConnectToRemote?: (ip: string, pin: string, fingerprint?: string) => Promise<'connected' | 'need-pin'>;
  onDisconnectFromRemote?: () => void;
  /** True when this device holds a saved key for that computer (it remembered us). */
  hasSavedKey?: (address: string, fingerprint?: string) => boolean;
}

interface DisplayDevice {
  id: string;
  name: string;
  type: 'phone' | 'desktop' | 'tablet';
  os: string;
  ip: string;
  isConnected: boolean;
  port?: number;
  fingerprint?: string;
}

export const Dashboard: React.FC<DashboardProps> = ({
  peers,
  discoveredDevices = [],
  deviceName,
  ips,
  port,
  onNavigate,
  onConnectToRemote,
  hasSavedKey
}) => {
  // 1. Get connected peers
  const connectedDisplayDevices: DisplayDevice[] = peers.map(p => {
    const osLower = (p.os || '').toLowerCase();
    let deviceType: 'phone' | 'desktop' | 'tablet' = p.type === 'phone' ? 'phone' : 'desktop';
    if (osLower.includes('tablet') || osLower.includes('ipad')) {
      deviceType = 'tablet';
    }
    return {
      id: p.id,
      name: p.name,
      type: deviceType,
      os: p.os || 'Unknown OS',
      ip: p.ip || '',
      isConnected: true
    };
  });

  // 2. Get discovered devices that are not connected
  const discoveredDisplayDevices: DisplayDevice[] = (discoveredDevices || [])
    .filter(d => !peers.some(p => p.ip === d.ip || p.id === d.id))
    .map(d => {
      const osLower = (d.os || '').toLowerCase();
      let deviceType: 'phone' | 'desktop' | 'tablet' = 'desktop';
      if (osLower.includes('phone') || osLower.includes('android') || osLower.includes('ios')) {
        deviceType = osLower.includes('ipad') || osLower.includes('tablet') ? 'tablet' : 'phone';
      }
      return {
        id: d.id,
        name: d.name,
        type: deviceType,
        os: d.os || 'Unknown OS',
        ip: d.ip,
        isConnected: false,
        port: d.port,
        fingerprint: d.fingerprint
      };
    });

  // Combine them (connected first, limit to 4 total)
  const allDisplayDevices = [...connectedDisplayDevices, ...discoveredDisplayDevices].slice(0, 4);

  // Discovery no longer shares the PIN, so ask the user to type the one shown on the other screen.
  const [pinDevice, setPinDevice] = React.useState<DisplayDevice | null>(null);
  const [pinValue, setPinValue] = React.useState('');

  const handleConnect = async (device: DisplayDevice) => {
    if (!device.ip || !device.port) return;
    const address = `${device.ip}:${device.port}`;
    // A computer that remembers us lets us straight in; ask for the PIN only if that fails.
    if (hasSavedKey?.(address, device.fingerprint)) {
      const result = await onConnectToRemote?.(address, '', device.fingerprint);
      if (result === 'connected') return;
    }
    setPinValue('');
    setPinDevice(device);
  };

  const submitPin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinDevice || !/^\d{6}$/.test(pinValue)) return;
    onConnectToRemote?.(`${pinDevice.ip}:${pinDevice.port}`, pinValue, pinDevice.fingerprint);
    setPinDevice(null);
  };

  const getDeviceIcon = (type: string) => {
    switch (type) {
      case 'desktop':
        return <Laptop size={18} />;
      case 'tablet':
        return <Tablet size={18} />;
      default:
        return <Smartphone size={18} />;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, justifyContent: 'space-between', animation: 'fadeIn 0.3s ease-out' }}>
      
      {/* Top Node Status Panel */}
      <div
        className="glass-panel"
        style={{
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px'
        }}
      >
        <div>
          <span className="mono-label">This computer</span>
          <h2 style={{ fontSize: '22px', fontFamily: 'var(--font-title)', fontWeight: 700, marginTop: '4px' }}>
            {deviceName}
          </h2>
        </div>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <div>
            <span className="mono-label" style={{ display: 'block', textAlign: 'right' }}>
              Port
            </span>
            <span className="mono" style={{ color: 'var(--text-primary)', fontSize: '13px', display: 'block', textAlign: 'right', marginTop: '4px' }}>
              {port}
            </span>
          </div>
          {ips.length > 0 && (
            <div>
              <span className="mono-label" style={{ display: 'block', textAlign: 'right' }}>
                IP address
              </span>
              <span className="mono" style={{ color: 'var(--text-primary)', fontSize: '13px', display: 'block', textAlign: 'right', marginTop: '4px' }}>
                {ips[0]}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Centered Nearby Devices Radar Area */}
      <div className="radar-discovery-container">
        
        {/* Radar Scanner Core */}
        <div className="radar-scanner-area">
          <div className="radar-wave-circle radar-wave-1"></div>
          <div className="radar-wave-circle radar-wave-2"></div>
          <div className="radar-wave-circle radar-wave-3"></div>
          <div className="radar-sweep-indicator"></div>
          
          <div className="radar-center-pulse">
            <Wifi size={24} style={{ transform: 'rotate(45deg)' }} />
          </div>
        </div>

        {/* Floating Device Cards around the Scanner */}
        {allDisplayDevices.map((device, index) => {
          const positionClass = `float-pos-${(index % 4) + 1}`;
          return (
            <div
              key={device.id}
              className={`glass-panel floating-device-card ${positionClass}`}
              style={{
                borderColor: device.isConnected ? 'var(--success)' : undefined,
                borderImage: device.isConnected ? 'none' : undefined
              }}
            >
              <div className={`device-card-avatar ${device.type}`}>
                {getDeviceIcon(device.type)}
              </div>
              <div className="device-card-content">
                <div className="device-card-name" title={device.name}>
                  {device.name}
                </div>
                <div className="device-card-signal" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {device.isConnected ? (
                    <>
                      <span className="pulse-indicator" style={{ width: '6px', height: '6px', background: 'var(--success)', margin: 0 }} />
                      <span style={{ color: 'var(--success)', fontWeight: 600 }}>Connected</span>
                    </>
                  ) : (
                    <>
                      <Signal size={12} style={{ color: 'var(--accent-light)' }} />
                      <span>LAN Active</span>
                    </>
                  )}
                </div>
              </div>
              {device.isConnected ? (
                <button
                  onClick={() => onNavigate('send')}
                  className="interactive-btn primary"
                  style={{ padding: '5px 10px', minWidth: 'unset' }}
                >
                  Send
                </button>
              ) : (
                <button
                  onClick={() => handleConnect(device)}
                  className="interactive-btn"
                  style={{ padding: '5px 10px', minWidth: 'unset' }}
                >
                  Connect
                </button>
              )}
            </div>
          );
        })}

        {/* Status text */}
        <div className="radar-info-text" style={{ marginBottom: '16px' }}>
          <h3>Nearby Devices</h3>
          <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            {peers.length > 0 ? (
              <>
                <span className="pulse-indicator" style={{ width: '8px', height: '8px', background: 'var(--success)', margin: 0 }} />
                <span style={{ color: 'var(--success)', fontWeight: 600 }}>{peers.length} device(s) connected</span>
              </>
            ) : (
              <>
                <Loader2 size={14} className="active-pulse-neon" style={{ animation: 'ring-spin 2s linear infinite', color: 'var(--primary-light)' }} />
                <span>
                  {discoveredDisplayDevices.length > 0 
                    ? `Discovered ${discoveredDisplayDevices.length} network peer(s)`
                    : 'Searching for nearby devices...'}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Bottom Main Action Buttons (Xender style Send/Receive shortcuts) */}
      <div style={{
        display: 'flex',
        gap: '16px',
        padding: '0 24px 16px 24px',
        justifyContent: 'center',
        width: '100%',
        maxWidth: '480px',
        margin: '0 auto'
      }}>
        <button
          onClick={() => onNavigate('send')}
          className="interactive-btn primary"
          style={{
            flex: 1,
            height: '46px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}
        >
          <Send size={15} />
          Send files
        </button>
        <button
          onClick={() => onNavigate('receive')}
          className="interactive-btn accent"
          style={{
            flex: 1,
            height: '46px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}
        >
          <QrCode size={15} />
          Receive files
        </button>
      </div>

      {pinDevice && (
        <div className="dialog-overlay" style={{ zIndex: 10001 }} onClick={() => setPinDevice(null)}>
          <form
            className="glass-panel dialog-content"
            onSubmit={submitPin}
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1)' }}
          >
            <div>
              <h4 style={{ fontSize: '18px', marginBottom: '6px', fontFamily: 'var(--font-title)' }}>
                Connect to {pinDevice.name}
              </h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: '1.5' }}>
                Enter the 6-digit PIN shown on that device's pairing screen.
              </p>
            </div>
            <input
              autoFocus
              inputMode="numeric"
              maxLength={6}
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              aria-label="Pairing PIN"
              style={{
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid var(--glass-border)',
                borderRadius: '10px',
                padding: '12px',
                color: 'var(--text-primary)',
                fontSize: '22px',
                letterSpacing: '8px',
                textAlign: 'center',
                fontFamily: 'monospace'
              }}
            />
            <div className="dialog-actions">
              <button
                type="button"
                className="interactive-btn"
                onClick={() => setPinDevice(null)}
                style={{ flex: 1, color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="interactive-btn primary"
                disabled={pinValue.length !== 6}
                style={{ flex: 1 }}
              >
                Connect
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
