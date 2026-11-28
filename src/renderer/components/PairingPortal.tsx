import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Smartphone, Laptop, RefreshCw, QrCode, LogOut } from 'lucide-react';

const QR_OPTIONS = { width: 256, margin: 1, color: { dark: '#0f0a20', light: '#ffffff' } };

export interface ServerInfo {
  ips: string[];
  port: number;
  token: string;
  deviceName: string;
  fingerprint?: string;
  secure?: boolean;
}

interface PairingPortalProps {
  serverInfo: ServerInfo | null;
  onRegenerateToken: () => void;
  /** Show this computer's address and PIN on the Computer tab (the Send screen does; Receive doesn't). */
  showOwnDetails?: boolean;
  /** Connects this computer to another computer running Weshare (its address and PIN). */
  onConnectToRemote?: (address: string, pin: string, fingerprint?: string) => Promise<'connected' | 'need-pin'>;
}

export const PairingPortal: React.FC<PairingPortalProps> = ({ serverInfo, onRegenerateToken, onConnectToRemote, showOwnDetails = true }) => {
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [activeIpIndex, setActiveIpIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'mobile' | 'laptop'>('mobile');

  const activeIp = serverInfo?.ips[activeIpIndex] || '127.0.0.1';
  const connectionUrl = serverInfo
    ? `${serverInfo.secure ? 'https' : 'http'}://${activeIp}:${serverInfo.port}/?token=${serverInfo.token}`
    : '';

  useEffect(() => {
    if (connectionUrl) {
      QRCode.toDataURL(connectionUrl, QR_OPTIONS)
        .then(url => setQrCodeUrl(url))
        .catch(err => console.error('QR code generation failed', err));
    }
  }, [connectionUrl]);

  // "Done": when a customer is finished, disconnect every phone and computer and change the PIN,
  // so the next person can't reuse the old code.
  const canEndSessions = !!window.electronAPI?.endGuestSessions;
  const [doneMessage, setDoneMessage] = useState('');

  const finishSession = async () => {
    let disconnected = 0;
    try {
      disconnected = (await window.electronAPI?.endGuestSessions?.())?.disconnected || 0;
    } catch (e) {}
    onRegenerateToken();
    setDoneMessage(`${disconnected === 1 ? '1 device' : `${disconnected} devices`} disconnected. New PIN made.`);
    setTimeout(() => setDoneMessage(''), 6000);
  };

  // ---- Connect to another computer (Computer tab) ----
  const [remoteAddress, setRemoteAddress] = useState('');
  const [remotePin, setRemotePin] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const addressOk = /^\d{1,3}(\.\d{1,3}){3}(:\d{2,5})?$/.test(remoteAddress.trim());
  const ownAddresses = (serverInfo?.ips || []).flatMap((ip) => [ip, `${ip}:${serverInfo?.port}`]);

  const connectToComputer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onConnectToRemote || !addressOk || remotePin.length !== 6 || connecting) return;
    const address = remoteAddress.trim();
    if (ownAddresses.includes(address) || address.startsWith('127.')) {
      setConnectError('That is this computer. Type the address shown on the other computer.');
      return;
    }
    setConnecting(true);
    setConnectError('');
    try {
      const result = await onConnectToRemote(address, remotePin);
      if (result === 'need-pin') setConnectError('The PIN was not accepted. Check it on the other computer.');
    } catch (err) {
      setConnectError('Could not reach that computer. Check the address and that both are on the same Wi-Fi.');
    } finally {
      setConnecting(false);
    }
  };

  if (!serverInfo) {
    return (
      <div className="glass-panel receive-container" style={{ minHeight: '400px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
        <RefreshCw className="active-pulse-neon" style={{ animation: 'ring-spin 2s linear infinite', color: 'var(--primary-light)', marginBottom: '16px' }} size={32} />
        <p style={{ color: 'var(--text-secondary)' }}>Initializing secure offline server...</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', width: '100%', animation: 'fadeIn 0.3s ease-out' }}>
      
      {/* Phone / computer switch */}
      <div style={{
        display: 'flex',
        border: '1px solid var(--line-2)',
        width: '100%',
        maxWidth: '360px'
      }}>
        <button
          onClick={() => setActiveTab('mobile')}
          className={`seg-tab${activeTab === 'mobile' ? ' active' : ''}`}
        >
          <Smartphone size={14} />
          Phone
        </button>
        <button
          onClick={() => setActiveTab('laptop')}
          className={`seg-tab${activeTab === 'laptop' ? ' active' : ''}`}
        >
          <Laptop size={14} />
          Computer
        </button>
      </div>

      {/* Main Glowing Glass Card */}
      <div className="glass-panel pairing-glow-card">
        <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--primary-light)', marginBottom: '16px' }}>
          <QrCode size={40} className="floating-icon" />
        </div>
        
        <h3 style={{ fontSize: '20px', fontFamily: 'var(--font-title)', fontWeight: 700, marginBottom: '6px' }}>
          Pair a device
        </h3>
        
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '24px' }}>
          {activeTab !== 'mobile' ? 'Connect another computer with the PIN' : 'Scan with the phone camera'}
        </p>

        {activeTab === 'mobile' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'center', width: '100%' }}>
            {/* QR Wrapper Container */}
            <div className="qr-wrapper" style={{
              padding: '16px',
              background: '#ffffff',
              borderRadius: '20px',
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {qrCodeUrl ? (
                <img
                  src={qrCodeUrl}
                  alt="Pairing QR Code"
                  style={{ width: '180px', height: '180px', borderRadius: '12px', display: 'block' }}
                />
              ) : (
                <div style={{ width: '180px', height: '180px', background: '#0b0a12', borderRadius: '12px' }} />
              )}
            </div>
            {serverInfo.secure && <p style={{ color: 'var(--text-muted)', fontSize: '11.5px', lineHeight: '1.5', maxWidth: '300px', margin: 0 }}>
              The connection is encrypted. The first time, your phone will say it isn't private
              because this computer made its own certificate. Tap <strong>Advanced</strong> and then <strong>Proceed</strong>.
              {serverInfo.fingerprint && (
                <>
                  {' '}To be sure it's this computer, check that the certificate's SHA-256 starts with{' '}
                  <strong style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {serverInfo.fingerprint.split(':').slice(0, 4).join(':')}
                  </strong>.
                </>
              )}
            </p>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', alignItems: 'center' }}>
            {/* This computer's details, for the other computer to type in */}
            {showOwnDetails && <div style={{ width: '100%', textAlign: 'left' }}>
              <span className="mono-label">This computer</span>
              <div style={{ border: '1px solid var(--line-2)', marginTop: '8px', display: 'flex' }}>
                <div style={{ flex: 1, padding: '12px 14px', borderRight: '1px solid var(--line-2)' }}>
                  <span className="mono-label" style={{ fontSize: '10px' }}>Address</span>
                  <div className="mono" style={{ fontSize: '15px', color: 'var(--text-primary)', textTransform: 'none', letterSpacing: 0, marginTop: '4px' }}>
                    {serverInfo.port === 5003 ? activeIp : `${activeIp}:${serverInfo.port}`}
                  </div>
                </div>
                <div style={{ flex: 1, padding: '12px 14px' }}>
                  <span className="mono-label" style={{ fontSize: '10px' }}>PIN</span>
                  <div className="mono" style={{ fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '0.12em', marginTop: '4px' }}>
                    {serverInfo.token}
                  </div>
                </div>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '11.5px', lineHeight: 1.5, margin: '8px 0 0' }}>
                {onConnectToRemote
                  ? 'Type these on the other computer, or type its details below. Either way works.'
                  : 'On the other computer, open Weshare and type these under Receive files → Computer.'}
              </p>
            </div>}

            {/* Connect to another computer */}
            {onConnectToRemote && (
              <form onSubmit={connectToComputer} style={{ width: '100%', textAlign: 'left', borderTop: showOwnDetails ? '1px solid var(--line)' : 0, paddingTop: showOwnDetails ? '18px' : 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="mono-label">Connect to another computer</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    value={remoteAddress}
                    onChange={(e) => { setRemoteAddress(e.target.value.replace(/[^\d.:]/g, '')); setConnectError(''); }}
                    placeholder="Its address, e.g. 192.168.1.20"
                    aria-label="Other computer's address"
                    inputMode="decimal"
                    style={{ flex: 3, minWidth: 0, padding: '10px 12px', fontSize: '13px', fontFamily: 'var(--font-mono)' }}
                  />
                  <input
                    value={remotePin}
                    onChange={(e) => { setRemotePin(e.target.value.replace(/\D/g, '').slice(0, 6)); setConnectError(''); }}
                    placeholder="PIN"
                    aria-label="Other computer's PIN"
                    inputMode="numeric"
                    maxLength={6}
                    style={{ flex: 2, minWidth: 0, padding: '10px 12px', fontSize: '13px', fontFamily: 'var(--font-mono)', letterSpacing: '0.15em' }}
                  />
                </div>
                <button
                  type="submit"
                  className="interactive-btn primary"
                  disabled={!addressOk || remotePin.length !== 6 || connecting}
                  style={{ padding: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                >
                  <Laptop size={14} />
                  {connecting ? 'Connecting…' : 'Connect'}
                </button>
                {connectError && (
                  <span role="alert" style={{ fontSize: '11.5px', color: 'var(--error)', lineHeight: 1.45 }}>{connectError}</span>
                )}
              </form>
            )}
          </div>
        )}

        {/* Network picker, when this computer is on more than one network */}
        {serverInfo.ips.length > 1 && <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', borderTop: '1px solid var(--glass-border)', paddingTop: '20px' }}>
          
          {/* IP Interface Selector if multiple interfaces exist */}
          {serverInfo.ips.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', textAlign: 'left' }}>
              <label style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>
                SELECT LAN INTERFACE
              </label>
              <select
                value={activeIpIndex}
                onChange={(e) => setActiveIpIndex(Number(e.target.value))}
                style={{
                  background: 'rgba(0,0,0,0.2)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  outline: 'none',
                  cursor: 'pointer',
                  width: '100%',
                  fontSize: '12px'
                }}
              >
                {serverInfo.ips.map((ip, idx) => (
                  <option key={ip} value={idx} style={{ background: '#0b0a12' }}>
                    {ip} (Local Network)
                  </option>
                ))}
              </select>
            </div>
          )}

        </div>}
      </div>

      {/* Footer Network Wait State */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '11px',
        color: 'var(--text-muted)',
        marginTop: '8px'
      }}>
        <span className="pulse-indicator cyan" style={{ width: '6px', height: '6px' }}></span>
        <span>Awaiting local peer...</span>
        <button
          onClick={onRegenerateToken}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--primary-light)',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '11px',
            marginLeft: '6px',
            outline: 'none'
          }}
        >
          Reset Session
        </button>
      </div>

      {canEndSessions && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <button
            className="interactive-btn"
            onClick={finishSession}
            title="Disconnect every phone and computer and change the PIN, ready for the next person"
            style={{ padding: '9px 14px', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <LogOut size={13} />
            Done · disconnect phones
          </button>
          {doneMessage && (
            <span role="status" style={{ fontSize: '11.5px', color: 'var(--success)' }}>{doneMessage}</span>
          )}
        </div>
      )}

    </div>
  );
};
