import React from 'react';
import { Check } from 'lucide-react';

interface SessionEndedProps {
  onConnectAgain: () => void;
}

/* Shown on a phone after the computer pressed Done. */
export const SessionEnded: React.FC<SessionEndedProps> = ({ onConnectAgain }) => (
  <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--bg-base)' }}>
    <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div className="icon-tile" style={{ width: '44px', height: '44px' }}>
        <Check size={20} />
      </div>
      <div>
        <span className="mono-label">Session ended</span>
        <h2 style={{ fontSize: '24px', marginTop: '6px' }}>You're done</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: 1.55, marginTop: '8px' }}>
          The computer disconnected this phone. Files you received are still in your downloads.
        </p>
      </div>

      <button className="interactive-btn" onClick={onConnectAgain} style={{ padding: '11px' }}>
        Connect again
      </button>
    </div>
  </div>
);
