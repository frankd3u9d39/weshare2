import React from 'react';
import { PairingPortal, ServerInfo } from './PairingPortal';

interface ReceiveScreenProps {
  serverInfo: ServerInfo | null;
  onRegenerateToken: () => void;
  onConnectToRemote?: (address: string, pin: string, fingerprint?: string) => Promise<'connected' | 'need-pin'>;
}

export const ReceiveScreen: React.FC<ReceiveScreenProps> = ({ serverInfo, onRegenerateToken, onConnectToRemote }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', animation: 'fadeIn 0.3s ease-out' }}>
      
      {/* Title Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Receive Files</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Scan the QR code or use the PIN to connect to this device</p>
        </div>
      </div>

      <PairingPortal serverInfo={serverInfo} onRegenerateToken={onRegenerateToken} onConnectToRemote={onConnectToRemote} showOwnDetails={false} />
    </div>
  );
};
