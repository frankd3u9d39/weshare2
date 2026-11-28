import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (mode: 'files' | 'folders' = 'files') => ipcRenderer.invoke('select-file', mode),
  offerDroppedFile: (filePath: string) => ipcRenderer.invoke('offer-dropped-file', filePath),
  openFolder: (dirPath?: string) => ipcRenderer.invoke('open-folder', dirPath),
  printFile: (filePath: string) => ipcRenderer.invoke('print-file', filePath),
  openFileWith: (filePath: string) => ipcRenderer.invoke('open-file-with', filePath),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  regenerateToken: () => ipcRenderer.invoke('regenerate-token'),
  pinHostFingerprint: (host: string, fingerprint: string) => ipcRenderer.invoke('pin-host-fingerprint', host, fingerprint),
  isElectron: true,

  // Weshare account and weekly access
  getAccount: () => ipcRenderer.invoke('account-get'),
  refreshAccount: () => ipcRenderer.invoke('account-refresh'),
  signUp: (email: string, password: string) => ipcRenderer.invoke('account-sign-up', email, password),
  signIn: (email: string, password: string) => ipcRenderer.invoke('account-sign-in', email, password),
  resetPassword: (email: string) => ipcRenderer.invoke('account-reset-password', email),
  signOut: () => ipcRenderer.invoke('account-sign-out'),
  buyWeek: () => ipcRenderer.invoke('account-buy-week'),
  onAccountUpdated: (callback: (state: any) => void) => {
    const listener = (_event: any, state: any) => callback(state);
    ipcRenderer.on('account-updated', listener);
    return () => ipcRenderer.removeListener('account-updated', listener);
  },

  // Host preferences
  isAdminDevice: () => ipcRenderer.invoke('is-admin-device'),
  getAppSettings: () => ipcRenderer.invoke('settings-get'),
  updateAppSettings: (patch: any) => ipcRenderer.invoke('settings-update', patch),
  endGuestSessions: () => ipcRenderer.invoke('end-guest-sessions'),

  // Shared folders (host side)
  listShares: () => ipcRenderer.invoke('shares-list'),
  addShare: () => ipcRenderer.invoke('shares-add'),
  removeShare: (id: string) => ipcRenderer.invoke('shares-remove', id),

  // Auto-Updater APIs
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => process.platform,
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  startUpdateDownload: () => ipcRenderer.invoke('start-update-download'),
  onUpdateProgress: (callback: (progress: number) => void) => {
    const subscription = (_event: any, progress: number) => callback(progress);
    ipcRenderer.on('update-progress', subscription);
    return () => ipcRenderer.removeListener('update-progress', subscription);
  },
  onDeviceDiscovered: (callback: (device: any) => void) => {
    const subscription = (_event: any, device: any) => callback(device);
    ipcRenderer.on('device-discovered', subscription);
    return () => ipcRenderer.removeListener('device-discovered', subscription);
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // Native streaming APIs
  startFileDownload: (options: { downloadUrl: string, transferId: string, fileName: string, fileSize: number, isFolder?: boolean }) => ipcRenderer.invoke('start-file-download', options),
  startFileUpload: (options: { uploadUrl: string, transferId: string, fileId: string, fileName: string, fileSize: number, isFolder?: boolean }) => ipcRenderer.invoke('start-file-upload', options),
  toggleNativeTransfer: (transferId: string, paused: boolean) => ipcRenderer.invoke('toggle-native-transfer', transferId, paused),
  cancelNativeTransfer: (transferId: string) => ipcRenderer.invoke('cancel-native-transfer', transferId),
  onUploadProgress: (callback: (data: { transferId: string, bytesTransferred: number, speed: number }) => void) => {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on('upload-progress-delta', subscription);
    return () => ipcRenderer.removeListener('upload-progress-delta', subscription);
  },
  onDownloadProgress: (callback: (data: { transferId: string, bytesTransferred: number, speed: number }) => void) => {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on('download-progress-delta', subscription);
    return () => ipcRenderer.removeListener('download-progress-delta', subscription);
  }
});
