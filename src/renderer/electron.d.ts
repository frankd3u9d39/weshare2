export interface AccountState {
  billing: boolean;
  signedIn: boolean;
  email: string;
  status: 'open' | 'signed-out' | 'checking' | 'trial' | 'paid' | 'expired';
  endsAt: number;
  trialEndsAt: number;
  paidUntil: number;
  offline: boolean;
  adminDevice: boolean;
}

export interface AccountResult {
  ok: boolean;
  error?: string;
  state?: AccountState;
}

export interface SharedFolderInfo {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface ElectronAPI {
  selectFile: (mode?: 'files' | 'folders') => Promise<any[] | null>;
  openFolder: (dirPath?: string) => Promise<boolean>;
  printFile: (filePath: string) => Promise<{ ok: boolean; error?: string; note?: string }>;
  openFileWith: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  getServerInfo: () => Promise<any>;
  regenerateToken: () => Promise<any>;
  pinHostFingerprint: (host: string, fingerprint: string) => Promise<boolean>;
  isElectron: boolean;
  isAdminDevice: () => Promise<boolean>;
  getAccount: () => Promise<AccountState>;
  refreshAccount: () => Promise<AccountResult>;
  signUp: (email: string, password: string) => Promise<AccountResult>;
  signIn: (email: string, password: string) => Promise<AccountResult>;
  resetPassword: (email: string) => Promise<AccountResult>;
  signOut: () => Promise<AccountState>;
  buyWeek: () => Promise<AccountResult & { paid?: boolean; message?: string }>;
  onAccountUpdated: (callback: (state: AccountState) => void) => () => void;
  getAppSettings: () => Promise<{ unpackZips: boolean; encryptConnections: boolean }>;
  updateAppSettings: (patch: { unpackZips?: boolean; encryptConnections?: boolean }) => Promise<{ unpackZips: boolean; encryptConnections: boolean }>;
  endGuestSessions: () => Promise<{ disconnected: number }>;
  listShares: () => Promise<SharedFolderInfo[]>;
  addShare: () => Promise<SharedFolderInfo[]>;
  removeShare: (id: string) => Promise<SharedFolderInfo[]>;
  getAppVersion: () => Promise<string>;
  getPlatform: () => Promise<string>;
  checkForUpdate: () => Promise<{ version: string; notes: string } | null>;
  startUpdateDownload: () => Promise<boolean>;
  onUpdateProgress: (callback: (progress: number) => void) => () => void;
  installUpdate: () => Promise<boolean>;
  startFileDownload: (options: { downloadUrl: string, transferId: string, fileName: string, fileSize: number, isFolder?: boolean }) => Promise<boolean>;
  startFileUpload: (options: { uploadUrl: string, transferId: string, fileId: string, fileName: string, fileSize: number, isFolder?: boolean }) => Promise<boolean>;
  toggleNativeTransfer: (transferId: string, paused: boolean) => Promise<boolean>;
  cancelNativeTransfer: (transferId: string) => Promise<boolean>;
  onUploadProgress: (callback: (data: { transferId: string, bytesTransferred: number, speed: number }) => void) => () => void;
  onDownloadProgress: (callback: (data: { transferId: string, bytesTransferred: number, speed: number }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

