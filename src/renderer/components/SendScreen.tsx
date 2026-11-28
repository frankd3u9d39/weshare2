import React, { useState, useRef, useEffect } from 'react';
import { UploadCloud, File, X, Send, Loader2, FolderOpen } from 'lucide-react';
import { PairingPortal, ServerInfo } from './PairingPortal';
import { formatSize } from '../utils/format';

interface SelectedFile {
  name: string;
  size: number;
  rawFile?: File;
  fileId?: string;
  isFolder?: boolean;
  relativePath?: string;
}

interface Peer {
  id: string;
  name: string;
  type: string;
}

interface SendScreenProps {
  peers: Peer[];
  isElectron: boolean;
  isHost: boolean;
  onSendFiles: (files: SelectedFile[], peerId: string) => void;
  initialFiles?: SelectedFile[];
  serverInfo?: ServerInfo | null;
  onRegenerateToken?: () => void;
  onConnectToRemote?: (address: string, pin: string, fingerprint?: string) => Promise<'connected' | 'need-pin'>;
}

export const SendScreen: React.FC<SendScreenProps> = ({
  peers,
  isElectron,
  isHost,
  onSendFiles,
  initialFiles,
  serverInfo,
  onRegenerateToken
}) => {
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>(initialFiles || []);
  const [isDragging, setIsDragging] = useState(false);
  const [targetPeerId, setTargetPeerId] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // webkitdirectory isn't in React's types, so it is set on the element directly.
  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      setSelectedFiles(initialFiles);
    }
  }, [initialFiles]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  // Browser files. A file picked from a folder keeps its path inside that folder
  // ("Photos/2024/a.jpg") so the other side can rebuild the same structure.
  const addBrowserFiles = (files: { file: File; relativePath?: string }[]) => {
    const list: SelectedFile[] = files.map(({ file, relativePath }) => ({
      name: file.name,
      size: file.size,
      rawFile: file,
      relativePath: relativePath && relativePath.includes('/') ? relativePath : undefined
    }));
    if (list.length > 0) setSelectedFiles((prev) => [...prev, ...list]);
  };

  const processFiles = (filesList: FileList) => {
    addBrowserFiles(
      Array.from(filesList).map((file) => ({ file, relativePath: (file as any).webkitRelativePath || undefined }))
    );
  };

  // Walks a dropped folder (browsers expose dropped folders only through entries).
  const readEntry = async (entry: any, prefix: string, out: { file: File; relativePath?: string }[]) => {
    if (out.length >= 10000) return;
    if (entry.isFile) {
      const file: File = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : undefined });
    } else if (entry.isDirectory) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      // readEntries hands back the folder in pieces; keep reading until it returns nothing.
      for (;;) {
        const batch: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await readEntry(child, path, out);
      }
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const items = Array.from(e.dataTransfer.items || []);
    const entries = items.map((item) => (item as any).webkitGetAsEntry?.()).filter(Boolean);
    if (!isElectron && entries.some((entry: any) => entry.isDirectory)) {
      const collected: { file: File; relativePath?: string }[] = [];
      try {
        for (const entry of entries) await readEntry(entry, '', collected);
      } catch (err) {
        console.error('[Send] Could not read dropped folder:', err);
      }
      addBrowserFiles(collected);
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const pick = async (mode: 'files' | 'folders') => {
    if (isElectron && window.electronAPI) {
      const files = await window.electronAPI.selectFile(mode);
      if (files && files.length > 0) {
        const formatted: SelectedFile[] = files.map((f: any) => ({
          name: f.name,
          size: f.size,
          fileId: f.fileId,
          isFolder: !!f.isFolder
        }));
        setSelectedFiles((prev) => [...prev, ...formatted]);
      }
    } else if (mode === 'folders') {
      folderInputRef.current?.click();
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
    e.target.value = ''; // lets the same file or folder be picked again
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = () => {
    const selectedPeer = targetPeerId || (peers.length > 0 ? peers[0].id : '');
    if (selectedFiles.length === 0 || !selectedPeer) return;
    onSendFiles(selectedFiles, selectedPeer);
    setSelectedFiles([]);
  };

  const defaultPeerId = peers.length > 0 ? peers[0].id : '';
  const canSend = selectedFiles.length > 0 && (peers.length > 0 || targetPeerId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', animation: 'fadeIn 0.3s ease-out' }}>
      
      {/* Title Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Send Files</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Choose files to share with other nodes</p>
        </div>
      </div>

      {/* Main Send Split Grid Layout */}
      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        
        {/* Left Side: Drag & Drop and Queue List */}
        <div style={{ flex: 1, minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          
          {/* Drag & Drop Target Area */}
          <div
            className={`drag-zone ${isDragging ? 'dragging' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => pick('files')}
            style={{ minHeight: '160px', padding: '24px' }}
          >
            <UploadCloud className="drag-zone-icon" size={36} />
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontWeight: 600, fontSize: '14px', marginBottom: '2px' }}>
                Select or drop files and folders
              </p>
              <p style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                Any file type, any size, over your secure local network
              </p>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                type="button"
                className="interactive-btn"
                onClick={(e) => { e.stopPropagation(); pick('files'); }}
                style={{ padding: '8px 14px', fontSize: '12px' }}
              >
                <File size={14} />
                Choose files
              </button>
              <button
                type="button"
                className="interactive-btn"
                onClick={(e) => { e.stopPropagation(); pick('folders'); }}
                style={{ padding: '8px 14px', fontSize: '12px' }}
              >
                <FolderOpen size={14} />
                Choose folder
              </button>
            </div>
            {!isElectron && (
              <p style={{ color: 'var(--text-muted)', fontSize: '11px', textAlign: 'center', maxWidth: '300px', lineHeight: 1.4 }}>
                Phone only lets you pick files? Zip the folder first (in your Files app) and send the zip. The computer unpacks it back into the folder.
              </p>
            )}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              multiple
              style={{ display: 'none' }}
            />
            <input
              type="file"
              ref={folderInputRef}
              onChange={handleFileInputChange}
              multiple
              style={{ display: 'none' }}
            />
          </div>

          {/* Selected File Cards */}
          {selectedFiles.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>
                SELECTED FILES ({selectedFiles.length})
              </div>
              <div className="selected-files-list">
                {selectedFiles.slice(0, 200).map((file, index) => (
                  <div key={index} className="selected-file-card" style={{ padding: '8px 12px' }}>
                    <div className="selected-file-info">
                      {file.isFolder ? (
                        <FolderOpen size={14} style={{ color: 'var(--primary-light)', flexShrink: 0 }} />
                      ) : (
                        <File size={14} style={{ color: 'var(--primary-light)', flexShrink: 0 }} />
                      )}
                      <span
                        style={{
                          fontWeight: 500,
                          maxWidth: '160px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {file.relativePath || file.name}
                      </span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                        ({formatSize(file.size)})
                      </span>
                    </div>
                    <button className="remove-file-btn" onClick={() => removeFile(index)}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {selectedFiles.length > 200 && (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 12px' }}>
                    …and {selectedFiles.length - 200} more
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Side: Destination & Connection QR Portal */}
        <div style={{ flex: 1, minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {peers.length > 0 ? (
            /* Connected state - target select and send button */
            <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', justifyContent: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>
                  CONNECTED TARGET DEVICE
                </label>
                <select
                  value={targetPeerId || defaultPeerId}
                  onChange={(e) => setTargetPeerId(e.target.value)}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    outline: 'none',
                    cursor: 'pointer',
                    width: '100%'
                  }}
                >
                  {peers.map((peer) => (
                    <option key={peer.id} value={peer.id} style={{ background: '#0b0a12' }}>
                      {peer.name} ({peer.type === 'phone' ? 'Phone' : 'Desktop'})
                    </option>
                  ))}
                </select>
              </div>

              <button
                className="interactive-btn primary"
                disabled={!canSend}
                onClick={handleSend}
                style={{
                  width: '100%',
                  padding: '12px',
                  opacity: canSend ? 1 : 0.5,
                  cursor: canSend ? 'pointer' : 'not-allowed',
                  height: '42px'
                }}
              >
                <Send size={14} />
                Send to Connected Device
              </button>
            </div>
          ) : isHost ? (
            /* Disconnected state for Host - Displays the QR pairing hub card */
            <PairingPortal
              serverInfo={serverInfo || null}
              onRegenerateToken={onRegenerateToken || (() => {})}
            />
          ) : (
            /* Disconnected state for Client - Displays Connecting to Host status */
            <div className="glass-panel" style={{ padding: '36px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', minHeight: '300px', width: '100%', textAlign: 'center' }}>
              <Loader2 className="active-pulse-neon" style={{ animation: 'ring-spin 2s linear infinite', color: 'var(--primary-light)' }} size={32} />
              <div>
                <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                  Connecting to Desktop Host...
                </h4>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '280px', margin: '0 auto', lineHeight: '1.4' }}>
                  Establishing local link. Make sure Weshare is active on your computer.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
