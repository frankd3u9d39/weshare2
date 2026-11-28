import React, { useState } from 'react';
import { History, FileText, FolderOpen, AlertCircle, ArrowUpRight, ArrowDownLeft, CheckCircle2, XCircle, Clock, Printer, Pencil } from 'lucide-react';
import { formatSize } from '../utils/format';

export interface TransferInfo {
  id: string;
  fileId?: string;
  name: string;
  size: number;
  type: 'send' | 'receive';
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'paused';
  progress: number;
  speed: number;
  filePath?: string;
  bytesTransferred: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  device?: string;
  isFolder?: boolean;
}

interface HistoryListProps {
  transfers: TransferInfo[];
  isElectron: boolean;
  isHost: boolean;
  onOpenFolder: (path?: string) => void;
  onAcceptTransfer?: (transferId: string, fileId?: string) => void;
  onRejectTransfer?: (transferId: string) => void;
  isFullPage?: boolean; // Prop to support responsive layouts
}

// Files that can be printed: pictures and PDFs (Weshare's own print screen) and documents
// (sent to Word, Excel, Notepad...). Videos, music, zips and apps get no Print button.
const PRINTABLE_TYPES = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'bmp', 'webp', 'avif', 'svg', 'ico',
  'pdf',
  'doc', 'docx', 'rtf', 'odt', 'txt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'xps'
]);
const canPrint = (fileName: string) => PRINTABLE_TYPES.has((fileName.split('.').pop() || '').toLowerCase());

export const HistoryList: React.FC<HistoryListProps> = ({ 
  transfers, 
  isElectron, 
  isHost,
  onOpenFolder,
  onAcceptTransfer,
  onRejectTransfer
}) => {
  // A short message under a row after Print or Edit (a tip, or why it didn't work).
  const [fileActionError, setFileActionError] = useState<{ id: string; message: string; tip?: boolean } | null>(null);

  const runFileAction = async (txId: string, action: () => Promise<{ ok: boolean; error?: string; note?: string }> | undefined) => {
    setFileActionError(null);
    try {
      const result = await action();
      if (result && !result.ok) setFileActionError({ id: txId, message: result.error || 'That did not work.' });
      if (result?.ok && result.note === 'pdf-viewer') {
        setFileActionError({ id: txId, tip: true, message: 'The PDF opened in a new window. Press its printer button (top right) or Ctrl+P to print.' });
      }
    } catch (e) {
      setFileActionError({ id: txId, message: 'That did not work.' });
    }
  };

  const rowButton: React.CSSProperties = {
    padding: '6px 12px',
    fontSize: '11.5px',
    borderRadius: '8px',
    height: '32px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px'
  };

  
  const formatSpeed = (bytesPerSec: number): string => {
    if (bytesPerSec <= 0) return '';
    const mbs = bytesPerSec / (1024 * 1024);
    if (mbs < 0.1) {
      return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    }
    return `${mbs.toFixed(1)} MB/s`;
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'completed': return 'Completed';
      case 'transferring': return 'Transferring';
      case 'paused': return 'Paused';
      case 'pending': return 'Pending';
      case 'failed': return 'Failed';
      default: return status;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', minHeight: 0, animation: 'fadeIn 0.3s ease-out' }}>
      
      {/* History Header section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div className="icon-tile" style={{ padding: '8px' }}>
            <History size={20} />
          </div>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Transfer History</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Activity log of all sent and received files</p>
          </div>
        </div>
        
        {isElectron && (
          <button
            onClick={() => onOpenFolder()}
            className="interactive-btn"
            style={{
              padding: '8px 14px',
              fontSize: '12.5px',
              height: '36px'
            }}
          >
            <FolderOpen size={14} style={{ color: 'var(--accent-light)' }} />
            Downloads Folder
          </button>
        )}
      </div>

      {/* Main List */}
      {transfers.length === 0 ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', minHeight: '300px' }}>
          <FileText className="empty-state-icon" style={{ fontSize: '48px', color: 'var(--text-muted)', marginBottom: '16px', opacity: 0.3 }} />
          <h4 style={{ color: 'var(--text-primary)', marginBottom: '6px', fontSize: '15px' }}>No transfers recorded yet</h4>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '280px', textAlign: 'center', lineHeight: '1.4' }}>
            Files you share or receive on your local network will be logged here.
          </p>
        </div>
      ) : (
        <div style={{ overflowY: 'auto', flex: 1, paddingRight: '4px' }}>
          <div className="history-activity-grid">
            {transfers.map((tx) => (
              <div key={tx.id} className="glass-panel activity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', minWidth: 0, gap: '16px' }}>
                  <div className="activity-card-left">
                    {/* Sent/Received Icon Indicator */}
                    <div className={`activity-card-icon ${tx.type}`}>
                      {tx.type === 'send' ? <ArrowUpRight size={18} /> : <ArrowDownLeft size={18} />}
                    </div>

                    <div className="activity-card-info">
                      <div className="activity-card-title" title={tx.name}>
                        {tx.name}
                      </div>
                      <div className="activity-card-meta">
                        <span style={{ color: tx.type === 'send' ? 'var(--primary-light)' : 'var(--accent-light)', fontWeight: 500 }}>
                          {tx.type === 'send' ? 'Sent' : 'Received'}
                        </span>
                        {' • '}
                        <span>{tx.device || 'Remote Device'}</span>
                        {' • '}
                        <span>{formatSize(tx.size)}</span>
                        {tx.speed > 0 && tx.status === 'completed' && (
                          <>
                            {' • '}
                            <span style={{ color: 'var(--success)' }}>Avg: {formatSpeed(tx.speed)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right actions and status */}
                  <div className="activity-card-right">
                    
                    {/* Status Indicator */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                      <span className={`history-item-status ${
                        tx.status === 'completed' ? 'status-completed' :
                        tx.status === 'transferring' ? 'status-transferring' :
                        tx.status === 'paused' ? 'status-pending' :
                        tx.status === 'pending' ? 'status-pending' : 'status-failed'
                      }`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        {tx.status === 'completed' && <CheckCircle2 size={10} />}
                        {tx.status === 'failed' && <XCircle size={10} />}
                        {tx.status === 'transferring' && <Clock size={10} style={{ animation: 'ring-spin 2s linear infinite' }} />}
                        {tx.status === 'paused' && <Clock size={10} />}
                        {getStatusLabel(tx.status)}
                      </span>
                      {(tx.status === 'transferring' || tx.status === 'paused') && (
                        <span style={{ fontSize: '10.5px', color: 'var(--accent-light)', fontWeight: 600 }}>
                          {tx.progress}% {tx.status === 'paused' ? '(Paused)' : `(${formatSpeed(tx.speed)})`}
                        </span>
                      )}
                    </div>

                    {/* Open File / Actions */}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {isElectron && tx.status === 'completed' && tx.filePath && !tx.isFolder && (
                        <>
                          <button
                            onClick={() => runFileAction(tx.id, () => window.electronAPI?.openFileWith?.(tx.filePath!))}
                            className="interactive-btn"
                            title="Choose which app to open and edit this file with"
                            style={rowButton}
                          >
                            <Pencil size={12} />
                            Edit
                          </button>
                          {canPrint(tx.filePath!) && <button
                            onClick={() => runFileAction(tx.id, () => window.electronAPI?.printFile?.(tx.filePath!))}
                            className="interactive-btn"
                            title="Print this file"
                            style={rowButton}
                          >
                            <Printer size={12} />
                            Print
                          </button>}
                        </>
                      )}
                      {isElectron && tx.status === 'completed' && tx.filePath && (
                        <button
                          onClick={() => onOpenFolder(tx.filePath)}
                          className="interactive-btn"
                          title="Show the file in its folder"
                          style={rowButton}
                        >
                          Reveal
                        </button>
                      )}

                      {/* Accept/Decline actions for pending incoming transfers */}
                      {tx.status === 'pending' && ((isHost && tx.type === 'receive') || (!isHost && tx.type === 'send')) && onAcceptTransfer && onRejectTransfer && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className="interactive-btn primary"
                            onClick={() => onAcceptTransfer(tx.id, tx.fileId)}
                            style={{ padding: '6px 12px', fontSize: '11.5px', borderRadius: '8px', height: '32px' }}
                          >
                            Accept
                          </button>
                          <button
                            className="interactive-btn"
                            onClick={() => onRejectTransfer(tx.id)}
                            style={{ padding: '6px 12px', fontSize: '11.5px', borderRadius: '8px', height: '32px', color: 'var(--text-secondary)' }}
                          >
                            Decline
                          </button>
                        </div>
                      )}
                    </div>

                  </div>
                </div>

                {/* Error handling message */}
                {tx.status === 'failed' && tx.error && (
                  <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--error)', marginTop: '4px', borderTop: '1px solid rgba(244,63,94,0.08)', paddingTop: '6px' }}>
                    <AlertCircle size={12} />
                    <span>{tx.error}</span>
                  </div>
                )}

                {/* Tip or problem after Print / Edit */}
                {fileActionError?.id === tx.id && (
                  <div role="alert" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: fileActionError.tip ? 'var(--text-secondary)' : 'var(--warning)', marginTop: '4px', paddingTop: '6px' }}>
                    <AlertCircle size={12} />
                    <span>{fileActionError.message}</span>
                  </div>
                )}

              </div>
            ))}
          </div>
        </div>
      )}
      
    </div>
  );
};
