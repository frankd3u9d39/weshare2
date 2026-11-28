import React, { useEffect } from 'react';
import { CheckCircle, ShieldAlert, X } from 'lucide-react';

export interface ToastState {
  message: string;
  tone: 'success' | 'error';
}

interface ToastProps {
  toast: ToastState | null;
  onDismiss: () => void;
  durationMs?: number;
}

export const Toast: React.FC<ToastProps> = ({ toast, onDismiss, durationMs = 3200 }) => {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [toast, durationMs, onDismiss]);

  if (!toast) return null;

  const isError = toast.tone === 'error';

  return (
    <div
      role="status"
      aria-live="polite"
      className="weshare-toast"
      style={{
        borderColor: isError ? 'rgba(244, 63, 94, 0.35)' : 'rgba(47, 217, 244, 0.35)',
        color: isError ? 'var(--error)' : 'var(--tertiary)'
      }}
    >
      {isError ? <ShieldAlert size={15} /> : <CheckCircle size={15} />}
      <span style={{ flex: 1 }}>{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', padding: 0 }}
      >
        <X size={13} />
      </button>
    </div>
  );
};
