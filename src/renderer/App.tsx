import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TrustedDevicesPanel, TrustedDeviceView } from './components/TrustedDevicesPanel';
import { SharedFoldersPanel } from './components/SharedFoldersPanel';
import { BrowseScreen } from './components/BrowseScreen';
import { Toast, ToastState } from './components/Toast';
import { Onboarding, hasSeenOnboarding, askHostIfOnboardingSeen, rememberOnboardingSeen } from './components/Onboarding';
import { SessionEnded } from './components/SessionEnded';
import { AccountScreen, PayScreen, AccountBadge, useAccount, accountBlocksApp } from './components/AccessGate';
import { Dashboard } from './components/Dashboard';
import { SendScreen } from './components/SendScreen';
import { ReceiveScreen } from './components/ReceiveScreen';
import { HistoryList, TransferInfo } from './components/HistoryList';
import { 
  ArrowLeft, Download, ShieldAlert, Sparkles, QrCode, UploadCloud, 
  Settings, Send, History, Laptop, Smartphone, Tablet, Pause, Play, FolderOpen, File, Wifi, HardDrive
} from 'lucide-react';
import LogoImg from './logo.png';
import { AdminDashboard } from './components/AdminDashboard';
import { formatSize } from './utils/format';
import { downloadInPage, saveBlob } from './utils/pageDownload';

interface ServerInfo {
  ips: string[];
  port: number;
  token: string;
  deviceName: string;
  fingerprint?: string;
  /** true when that computer serves HTTPS/WSS ("Encrypt connections" on), false for plain HTTP/WS. */
  secure?: boolean;
}

// Link schemes for a computer, depending on whether it encrypts its connections.
const httpScheme = (info: { secure?: boolean } | null | undefined) => (info?.secure ? 'https' : 'http');
const wsScheme = (info: { secure?: boolean } | null | undefined) => (info?.secure ? 'wss' : 'ws');

// Works out whether another computer is serving plain HTTP or HTTPS by asking it over each.
// A plain request to an HTTPS server (or the reverse) fails outright, so whichever answers wins.
const detectSecure = async (address: string): Promise<boolean> => {
  const answers = async (scheme: 'http' | 'https') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      await fetch(`${scheme}://${address}/api/auth-check?token=probe`, { signal: controller.signal });
      return true;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  if (await answers('http')) return false;
  if (await answers('https')) return true;
  return false;
};

interface Peer {
  id: string;
  name: string;
  ip: string;
  type: 'phone' | 'desktop';
  os: string;
  trusted?: boolean;
}

interface IncomingOffer {
  transferId: string;
  fileId?: string;
  name: string;
  size: number;
  senderName: string;
  isFolder?: boolean;
  batchId?: string;
  batchName?: string;
  batchCount?: number;
  relativePath?: string;
}

// Offers sent together (one "Send" press) are shown and answered as one batch.
interface IncomingBatch {
  key: string;
  senderName: string;
  name?: string;
  expected: number;
  offers: IncomingOffer[];
}

// A file a phone/browser is fetching inside the page, then saving.
interface PageDownload {
  id: string;
  name: string;
  url: string;
  status: 'queued' | 'downloading' | 'ready' | 'error';
  received: number;
  total: number;
  blobUrl?: string;
  error?: string;
}

// Outgoing offers, kept so uploads that start later know what they are sending.
interface OutgoingOffer {
  name: string;
  size: number;
  isFolder?: boolean;
}

const isLocalHostName = (hostname: string): boolean => {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    hostname.endsWith('.local')
  );
};

// getRandomValues works on plain-http LAN pages, unlike crypto.randomUUID.
const randomId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// ---- Remembered computers (this device's side of "trusted devices") ----
// A computer that chose to remember us gives us a personal key; we keep one entry per
// computer and match it by certificate fingerprint (survives IP changes) or address.
interface SavedHost {
  address: string; // "ip:port"
  fingerprint: string;
  token: string;
  hostName: string;
}
const SAVED_HOSTS_KEY = 'weshare_trusted_hosts';
const DEVICE_ID_KEY = 'weshare_device_id';

const loadSavedHosts = (): SavedHost[] => {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_HOSTS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((h) => h && typeof h.token === 'string' && typeof h.address === 'string') : [];
  } catch (e) {
    return [];
  }
};
const storeSavedHosts = (list: SavedHost[]) => {
  try {
    localStorage.setItem(SAVED_HOSTS_KEY, JSON.stringify(list));
  } catch (e) {}
};
const findSavedHost = (address: string, fingerprint?: string): SavedHost | undefined =>
  loadSavedHosts().find((h) => (!!fingerprint && h.fingerprint === fingerprint) || h.address === address);
const saveSavedHost = (entry: SavedHost) =>
  storeSavedHosts([
    ...loadSavedHosts().filter((h) => h.address !== entry.address && !(entry.fingerprint && h.fingerprint === entry.fingerprint)),
    entry
  ]);
const removeSavedHost = (address: string, fingerprint?: string) =>
  storeSavedHosts(loadSavedHosts().filter((h) => h.address !== address && !(fingerprint && h.fingerprint === fingerprint)));

// Device id stays the same across visits so a computer can recognise us.
const loadDeviceId = (): string => {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^peer_[a-f0-9]{32}$/.test(existing)) return existing;
    const created = 'peer_' + randomId();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch (e) {
    return 'peer_' + randomId();
  }
};
const rotateDeviceId = () => {
  try {
    localStorage.setItem(DEVICE_ID_KEY, 'peer_' + randomId());
  } catch (e) {}
};

// Asks the computer whether a saved key still works. Only an explicit refusal counts;
// if the computer is unreachable we keep the key and let the normal reconnect retry.
const isSavedTokenValid = async (address: string, token: string, secure: boolean): Promise<boolean> => {
  try {
    const res = await fetch(`${secure ? 'https' : 'http'}://${address}/api/auth-check?token=${encodeURIComponent(token)}`);
    return res.status !== 401;
  } catch (e) {
    return true;
  }
};

export const App: React.FC = () => {
  // null while a phone is still asking the computer whether it has seen the intro
  const [isOnboarded, setIsOnboarded] = useState<boolean | null>(() =>
    hasSeenOnboarding() ? true : (window as any).electronAPI ? false : null
  );
  const [currentScreen, setCurrentScreen] = useState<'nearby' | 'send' | 'receive' | 'browse' | 'history' | 'admin' | 'pair-gate'>('nearby');
  const [isElectron, setIsElectron] = useState(false);
  // Only the owner's computer (marked with an admin-device file) offers the Admin Console.
  const [isAdminDevice, setIsAdminDevice] = useState(false);
  const [isHost, setIsHost] = useState(false);
  // Weekly access (sign-in, free trial, paid week) on the desktop app.
  const account = useAccount(!!(window as any).electronAPI);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [draggedFiles, setDraggedFiles] = useState<any[]>([]);
  
  // Settings Modal State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [customDeviceName, setCustomDeviceName] = useState(() => localStorage.getItem('weshare_custom_device_name') || '');
  
  // File Transfer Pause Toggle (Visual Mock State)
  const [isTransferPaused, setIsTransferPaused] = useState(false);

  // Local server stats (for Desktop Host)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  
  // Connection states
  const [wsConnected, setWsConnected] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  // Set when the computer pressed Done; the phone shows how to leave the Wi-Fi.
  const [sessionEnded, setSessionEnded] = useState(false);
  const endedByHostRef = useRef<() => void>();
  const [discoveredDevices, setDiscoveredDevices] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<TransferInfo[]>([]);
  
  // Handshake details for clients (phone/browser)
  const [myDeviceId] = useState(loadDeviceId);

  // Trusted devices: the host's list, and whether this device is remembered by its host.
  const [trustedDevices, setTrustedDevices] = useState<TrustedDeviceView[]>([]);
  const [youAreTrusted, setYouAreTrusted] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const notify = (message: string, tone: ToastState['tone'] = 'success') => setToast({ message, tone });
  const dismissToast = useCallback(() => setToast(null), []);
  const [myDeviceName, setMyDeviceName] = useState(() => localStorage.getItem('weshare_custom_device_name') || 'Mobile Web Client');
  
  // Active upload store for browser files awaiting upload acceptance
  const activeUploadsRef = useRef<Map<string, File>>(new Map());
  
  // Incoming file offer modal state
  const [incomingBatches, setIncomingBatches] = useState<IncomingBatch[]>([]);
  const incomingBatch = incomingBatches[0] || null;
  // Every offer this device received, by transferId (name, size, folder flag).
  const offerInfoRef = useRef<Map<string, IncomingOffer>>(new Map());
  // Batches already answered: late-arriving files of the same batch follow that answer.
  const answeredBatchesRef = useRef<Map<string, 'accept' | 'reject'>>(new Map());
  const outgoingOffersRef = useRef<Map<string, OutgoingOffer>>(new Map());
  // Client uploads run one at a time so a big batch doesn't open hundreds of connections.
  const uploadChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // Files a phone/browser is fetching inside the page, with their progress and Save link.
  const [pageDownloads, setPageDownloads] = useState<PageDownload[]>([]);
  const pageDownloadAbortsRef = useRef<Map<string, () => void>>(new Map());
  const pageDownloadChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const pausedTransfersRef = useRef<Set<string>>(new Set());

  // Auto-Updater State
  const [updateAvailable, setUpdateAvailable] = useState<{
    version: string;
    notes: string;
    mandatory: boolean;
  } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [pairingPin, setPairingPin] = useState('');
  const [hostIp, setHostIp] = useState(() => {
    const hn = window.location.hostname;
    if (isLocalHostName(hn)) {
      return window.location.host;
    }
    return '';
  });

  const socketRef = useRef<WebSocket | null>(null);
  const handleForgottenRef = useRef<() => void>();
  const handleWebSocketMessageRef = useRef<(data: any) => void>();


  const handlePairSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pairingPin.length !== 6) {
      alert('Please enter a valid 6-digit PIN code.');
      return;
    }
    if (!hostIp.trim()) {
      alert('Please enter the Host IP Address.');
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('token', pairingPin);
    url.searchParams.set('host', hostIp.trim());
    window.location.href = url.toString();
  };

  // Connects this desktop to another WeShare computer. Uses this device's saved key for
  // that computer when there is one; returns 'need-pin' if a PIN is required instead.
  const handleConnectToRemote = async (ipInput: string, pin: string, fingerprint?: string): Promise<'connected' | 'need-pin'> => {
    let ip = ipInput;
    let port = 5003;
    if (ipInput.includes(':')) {
      const parts = ipInput.split(':');
      ip = parts[0];
      port = parseInt(parts[1], 10) || 5003;
    }
    const address = `${ip}:${port}`;

    let token = pin;
    const remoteSecure = await detectSecure(address);
    const saved = findSavedHost(address, fingerprint);
    if (saved) {
      // Expect the certificate we saw when we were trusted, even after an app restart.
      if (remoteSecure && saved.fingerprint) await window.electronAPI?.pinHostFingerprint?.(ip, saved.fingerprint);
      if (await isSavedTokenValid(address, saved.token, remoteSecure)) {
        token = saved.token;
        if (saved.address !== address) saveSavedHost({ ...saved, address });
      } else {
        removeSavedHost(saved.address, saved.fingerprint);
        if (!pin) {
          notify(`${saved.hostName} no longer remembers this device. Enter its PIN.`, 'error');
          return 'need-pin';
        }
      }
    }
    if (!token) return 'need-pin';

    if (socketRef.current) {
      socketRef.current.close();
    }

    setIsHost(false);

    const remoteServerInfo: ServerInfo = {
      ips: [ip],
      port: port,
      token: token,
      deviceName: 'Remote Laptop Host',
      secure: remoteSecure
    };
    setServerInfo(remoteServerInfo);

    const remoteUrl = `${wsScheme(remoteServerInfo)}://${ip}:${port}/?token=${encodeURIComponent(token)}`;
    const deviceOS = 'Desktop';

    connectWebSocket(remoteUrl, false, remoteServerInfo, customDeviceName || 'Desktop Client', deviceOS, 'desktop');
    return 'connected';
  };

  const handleDisconnectFromRemote = () => {
    if (socketRef.current) {
      socketRef.current.close();
    }

    setIsHost(true);

    if (window.electronAPI) {
      window.electronAPI.getServerInfo().then((info: ServerInfo) => {
        setServerInfo(info);
        connectWebSocket(`${wsScheme(info)}://127.0.0.1:${info.port}/?token=${info.token}`, true, info);
      });
    }
  };

  useEffect(() => {
    const isDesktop = !!(window as any).electronAPI;
    if (isDesktop) window.electronAPI.isAdminDevice?.().then((v) => setIsAdminDevice(v === true)).catch(() => {});
    setIsElectron(isDesktop);
    setIsHost(isDesktop || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');


    if (hasSeenOnboarding()) {
      setIsOnboarded(true);
    } else if (isDesktop) {
      setIsOnboarded(false);
    } else {
      askHostIfOnboardingSeen().then((seen) => {
        if (seen) rememberOnboardingSeen();
        setIsOnboarded(seen);
      });
    }

    let unsubscribeProgress: (() => void) | undefined;
    let unsubscribeUpload: (() => void) | undefined;
    let unsubscribeDownload: (() => void) | undefined;

    if (isDesktop) {
      window.electronAPI.getServerInfo().then((info: ServerInfo) => {
        setServerInfo(info);
        connectWebSocket(`${wsScheme(info)}://127.0.0.1:${info.port}/?token=${info.token}`, true, info);
      });

      const runUpdateCheck = async () => {
        try {
          // The main process asks GitHub Releases and keeps the installer link + checksum itself.
          const update = await window.electronAPI.checkForUpdate();
          if (update) {
            setUpdateAvailable({ version: update.version, notes: update.notes, mandatory: false });
          }
        } catch (err) {
          console.error('[Updater] Failed to run update check:', err);
        }
      };

      runUpdateCheck();

      unsubscribeProgress = window.electronAPI.onUpdateProgress((progress: number) => {
        setUpdateProgress(progress);
      });

      if (window.electronAPI.onUploadProgress) {
        unsubscribeUpload = window.electronAPI.onUploadProgress((data: any) => {
          socketRef.current?.send(
            JSON.stringify({
              type: 'transfer-progress',
              transferId: data.transferId,
              bytesTransferred: data.bytesTransferred,
              speed: data.speed
            })
          );
          setTransfers((prev) =>
            prev.map((tx) =>
              tx.id === data.transferId
                ? {
                    ...tx,
                    bytesTransferred: data.bytesTransferred,
                    speed: data.speed,
                    progress: Math.min(100, Math.round((data.bytesTransferred / tx.size) * 100)),
                    status: 'transferring'
                  }
                : tx
            )
          );
        });
      }

      if (window.electronAPI.onDownloadProgress) {
        unsubscribeDownload = window.electronAPI.onDownloadProgress((data: any) => {
          setTransfers((prev) =>
            prev.map((tx) =>
              tx.id === data.transferId
                ? {
                    ...tx,
                    bytesTransferred: data.bytesTransferred,
                    speed: data.speed,
                    progress: Math.min(100, Math.round((data.bytesTransferred / tx.size) * 100)),
                    status: 'transferring'
                  }
                : tx
            )
          );
        });
      }
    } else {
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('token');
      const hostParam = params.get('host');

      let host = hostParam || window.location.host;
      if (host.startsWith('localhost:') || host.startsWith('127.0.0.1:')) {
        host = `localhost:5003`;
      } else if (host && !host.includes(':')) {
        host = `${host}:5003`;
      }

      const startBrowserClient = (token: string) => {
        const userAgent = navigator.userAgent.toLowerCase();
        let deviceOS = 'Unknown Mobile';
        if (userAgent.includes('iphone') || userAgent.includes('ipad')) deviceOS = 'iOS';
        else if (userAgent.includes('android')) deviceOS = 'Android';
        else if (userAgent.includes('macintosh')) deviceOS = 'macOS';
        else if (userAgent.includes('windows')) deviceOS = 'Windows';
        
        const isMobile = userAgent.includes('mobi') || userAgent.includes('android') || userAgent.includes('iphone') || userAgent.includes('ipad');
        const clientType: 'phone' | 'desktop' = isMobile ? 'phone' : 'desktop';
        const defaultName = customDeviceName || (clientType === 'phone' ? 'Mobile Device' : `${deviceOS} Laptop`);
        setMyDeviceName(defaultName);

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const serverUrl = `${protocol}//${host}/?token=${encodeURIComponent(token)}`;
        
        const clientServerInfo: ServerInfo = {
          ips: [host.split(':')[0]],
          port: parseInt(host.split(':')[1] || '80', 10),
          token: token,
          secure: window.location.protocol === 'https:',
          deviceName: defaultName
        };
        setServerInfo(clientServerInfo);

        connectWebSocket(
          serverUrl,
          window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1',
          clientServerInfo,
          defaultName,
          deviceOS,
          clientType
        );
        setCurrentScreen('send');
      };

      // A computer that remembers this device lets it in with its saved key, no PIN needed.
      const saved = isLocalHostName(window.location.hostname) ? findSavedHost(host) : undefined;

      if (saved) {
        (async () => {
          if (await isSavedTokenValid(host, saved.token, window.location.protocol === 'https:')) {
            startBrowserClient(saved.token);
          } else {
            removeSavedHost(saved.address, saved.fingerprint);
            if (urlToken) {
              startBrowserClient(urlToken);
            } else {
              setCurrentScreen('pair-gate');
            }
          }
        })();
      } else if (urlToken) {
        startBrowserClient(urlToken);
      } else {
        setCurrentScreen('pair-gate');
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        setIsDraggingFile(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (e.clientX === 0 && e.clientY === 0) {
        setIsDraggingFile(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      setIsDraggingFile(false);

      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        const filesList = e.dataTransfer.files;
        const formattedFiles: any[] = [];

        for (let i = 0; i < filesList.length; i++) {
          const file = filesList[i];
          if (isDesktop && (window as any).electronAPI) {
            const res = await (window as any).electronAPI.offerDroppedFile((file as any).path);
            if (res) {
              formattedFiles.push({
                fileId: res.fileId,
                name: res.name,
                size: res.size,
                path: res.path
              });
            }
          } else {
            formattedFiles.push({
              name: file.name,
              size: file.size,
              rawFile: file
            });
          }
        }

        if (formattedFiles.length > 0) {
          setDraggedFiles(formattedFiles);
          setCurrentScreen('send');
        }
      }
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      if (unsubscribeProgress) {
        unsubscribeProgress();
      }
      if (unsubscribeUpload) {
        unsubscribeUpload();
      }
      if (unsubscribeDownload) {
        unsubscribeDownload();
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  useEffect(() => {
    if (isElectron && (window as any).electronAPI.onDeviceDiscovered) {
      const unsubscribe = (window as any).electronAPI.onDeviceDiscovered((device: any) => {
        setDiscoveredDevices((prev) => {
          if (prev.some((d) => d.id === device.id)) {
            return prev.map((d) =>
              d.id === device.id ? { ...d, ...device, lastSeen: Date.now() } : d
            );
          }
          return [...prev, { ...device, lastSeen: Date.now() }];
        });
      });

      const interval = setInterval(() => {
        setDiscoveredDevices((prev) =>
          prev.filter((d) => Date.now() - d.lastSeen < 30000)
        );
      }, 5000);

      return () => {
        unsubscribe();
        clearInterval(interval);
      };
    }
  }, [isElectron]);

  const connectWebSocket = (
    url: string,
    isHostParam: boolean,
    info: ServerInfo,
    deviceName = 'Desktop Panel',
    deviceOS = 'Desktop',
    deviceType: 'phone' | 'desktop' = 'phone'
  ) => {
    try {
      const socket = new WebSocket(url);
      socketRef.current = socket;
      let opened = false;

      // If the connection never opens (e.g. Electron's network service restarted mid-handshake),
      // give up on it so onclose runs and the normal retry kicks in.
      const connectTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) {
          console.warn('[WS Client] Connection attempt timed out, retrying');
          socket.close();
        }
      }, 8000);

      socket.onopen = () => {
        clearTimeout(connectTimeout);
        opened = true;
        setWsConnected(true);
        socket.send(
          JSON.stringify({
            type: 'device-info',
            device: {
              id: isHostParam ? 'desktop-main' : myDeviceId,
              name: isHostParam ? (customDeviceName || info?.deviceName || 'Local Host') : deviceName,
              type: isHostParam ? 'desktop' : deviceType,
              ip: isHostParam ? (info?.ips[0] || '127.0.0.1') : '',
              os: deviceOS
            }
          })
        );
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessageRef.current?.(data);
        } catch (e) {
          console.error('WS json parse error', e);
        }
      };

      socket.onclose = (event) => {
        clearTimeout(connectTimeout);
        // A connection we replaced or closed on purpose must not come back.
        if (socketRef.current !== socket) return;
        setWsConnected(false);

        // 4002: the computer pressed Done and ended every session; don't reconnect.
        if (event.code === 4002) {
          socketRef.current = null;
          endedByHostRef.current?.();
          return;
        }

        // 4003: the computer's weekly access ran out. Keep trying slowly; it reconnects by
        // itself once the staff renew it.
        if (event.code === 4003) {
          notify("This computer's Weshare week has ended. Ask the staff to renew it.", 'error');
          setTimeout(() => {
            if (socketRef.current === socket) connectWebSocket(url, isHostParam, info, deviceName, deviceOS, deviceType);
          }, 15000);
          return;
        }

        // 4001: the computer forgot this device, so its saved key no longer works.
        if (event.code === 4001) {
          socketRef.current = null;
          handleForgottenRef.current?.();
          return;
        }

        const retry = () =>
          setTimeout(() => {
            if (socketRef.current === socket) {
              connectWebSocket(url, isHostParam, info, deviceName, deviceOS, deviceType);
            }
          }, 3000);

        // A refused connection looks the same as a network drop to a browser. Ask the computer
        // whether our PIN/key still works (it changes when the app restarts); if not, stop
        // retrying and go back to the PIN screen instead of knocking forever.
        if (!opened && !isHostParam && !isElectron) {
          const token = new URL(url).searchParams.get('token') || '';
          fetch(`${httpScheme(info)}://${info.ips[0]}:${info.port}/api/auth-check?token=${encodeURIComponent(token)}`)
            .then(async (res) => {
              if (res.status === 402) {
                const body = await res.json().catch(() => ({}));
                notify(body.error || "This computer's Weshare week has ended. Ask the staff to renew it.", 'error');
                setTimeout(() => {
                  if (socketRef.current === socket) connectWebSocket(url, isHostParam, info, deviceName, deviceOS, deviceType);
                }, 15000);
                return;
              }
              if (res.status === 401 && socketRef.current === socket) {
                socketRef.current = null;
                const address = `${info.ips[0]}:${info.port}`;
                const saved = findSavedHost(address);
                if (saved?.token === token) removeSavedHost(address, saved.fingerprint);
                setCurrentScreen('pair-gate');
                notify('The computer was restarted or its PIN changed. Enter the new PIN.', 'error');
              } else {
                retry();
              }
            })
            .catch(() => retry());
          return;
        }
        retry();
      };

      socket.onerror = (err) => {
        console.error('WS error connection:', err);
      };
    } catch (error) {
      console.error('WebSocket connection error:', error);
    }
  };

  const handleWebSocketMessage = (data: any) => {
    console.log('[WS Client] Received WebSocket message:', data);
    switch (data.type) {
      case 'state-sync':
        const otherPeers = data.peers.filter((p: Peer) => p.id !== (isHost ? 'desktop-main' : myDeviceId));
        setPeers((prev) => {
          const mocks = prev.filter(p => p.id.startsWith('mock_'));
          const incomingWithoutMocks = otherPeers.filter((op: Peer) => !mocks.some(m => m.id === op.id));
          return [...mocks, ...incomingWithoutMocks];
        });
        setTransfers((prev) => {
          const mocks = prev.filter(t => t.id.startsWith('mock_'));
          let incoming = data.transfers.filter((it: any) => !mocks.some(m => m.id === it.id));
          
          // Invert transfer direction types from the client browser's perspective
          if (!isHost) {
            incoming = incoming.map((tx: any) => ({
              ...tx,
              type: tx.type === 'send' ? 'receive' : 'send'
            }));
          }
          
          return [...mocks, ...incoming];
        });
        if (isHost) {
          setTrustedDevices(data.trustedDevices || []);
        } else {
          setYouAreTrusted(!!data.youAreTrusted);
        }
        break;

      case 'trust-granted': {
        const address = serverInfo ? `${serverInfo.ips[0]}:${serverInfo.port}` : window.location.host;
        saveSavedHost({
          address,
          fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : '',
          token: data.token,
          hostName: data.hostName || 'Weshare computer'
        });
        setYouAreTrusted(true);
        notify(`${data.hostName || 'This computer'} will remember this device.`);
        break;
      }

      case 'access-ended':
        notify(typeof data.message === 'string' ? data.message : "This computer's Weshare week has ended.", 'error');
        break;

      case 'session-ended':
        endedByHostRef.current?.();
        break;

      case 'trust-revoked': {
        const address = serverInfo ? `${serverInfo.ips[0]}:${serverInfo.port}` : window.location.host;
        const saved = findSavedHost(address);
        removeSavedHost(address, saved?.fingerprint);
        setYouAreTrusted(false);
        notify('This computer no longer remembers this device.', 'error');
        break;
      }

      case 'transfer-progress-delta':
        setTransfers((prevTransfers) =>
          prevTransfers.map((tx) =>
            tx.id === data.transferId
              ? {
                  ...tx,
                  bytesTransferred: data.bytesTransferred,
                  progress: data.progress,
                  speed: data.speed,
                  status: tx.status === 'pending' || tx.status === 'paused' || tx.status === 'completed' || tx.status === 'failed' ? tx.status : 'transferring'
                }
              : tx
          )
        );
        break;

      case 'transfer-paused-sync':
        setIsTransferPaused(data.paused);
        if (data.paused) {
          pausedTransfersRef.current.add(data.transferId);
        } else {
          pausedTransfersRef.current.delete(data.transferId);
        }
        setTransfers((prevTransfers) =>
          prevTransfers.map((tx) =>
            tx.id === data.transferId
              ? {
                  ...tx,
                  status: data.paused ? 'paused' : 'transferring',
                  speed: 0
                }
              : tx
          )
        );
        break;

      case 'file-offered':
        // Only trigger offer modal if we are NOT the sender of this file
        if (data.senderId === (isHost ? 'desktop-main' : myDeviceId)) {
          console.log('[WS Client] Ignoring own file offer:', data.name);
          break;
        }
        {
          const offer: IncomingOffer = {
            transferId: data.transferId,
            fileId: data.fileId,
            name: data.name,
            size: Number(data.size) || 0,
            senderName: data.senderName,
            isFolder: data.isFolder,
            batchId: data.batchId,
            batchName: data.batchName,
            batchCount: data.batchCount,
            relativePath: data.relativePath
          };
          offerInfoRef.current.set(offer.transferId, offer);
          const key = offer.batchId || offer.transferId;

          // Rest of a batch the user already answered.
          const answer = answeredBatchesRef.current.get(key);
          if (answer === 'accept') {
            acceptTransfer(offer.transferId, offer.fileId);
            break;
          }
          if (answer === 'reject') {
            rejectTransfer(offer.transferId);
            break;
          }

          setIncomingBatches((prev) => {
            const existing = prev.find((b) => b.key === key);
            if (existing) {
              return prev.map((b) => (b.key === key ? { ...b, offers: [...b.offers, offer] } : b));
            }
            return [
              ...prev,
              {
                key,
                senderName: offer.senderName,
                name: offer.batchName,
                expected: Math.max(1, Number(offer.batchCount) || 1),
                offers: [offer]
              }
            ];
          });
        }
        break;

      case 'file-accepted':
        if (!isHost) {
          const transferId = data.transferId;
          const fileId = data.fileId;
          uploadChainRef.current = uploadChainRef.current
            .then(() => (isElectron ? startNativeUpload(transferId, fileId) : startBrowserUpload(transferId)))
            .catch((err) => console.error('[Upload queue]', err));
        }
        break;

      case 'file-rejected':
        if (isElectron) {
          window.electronAPI.cancelNativeTransfer(data.transferId);
        }
        activeUploadsRef.current.delete(data.transferId);
        outgoingOffersRef.current.delete(data.transferId);
        // The sender cancelled: stop fetching it and drop it from the downloads panel.
        pageDownloadAbortsRef.current.get(data.transferId)?.();
        setPageDownloads((prev) => prev.filter((d) => d.id !== data.transferId || d.status === 'ready'));
        setIncomingBatches((prev) =>
          prev
            .map((b) => ({ ...b, offers: b.offers.filter((o) => o.transferId !== data.transferId) }))
            .filter((b) => b.offers.length > 0)
        );
        break;

      case 'file-offer-error':
        activeUploadsRef.current.delete(data.transferId);
        alert(`Could not send "${data.name || 'file'}": ${data.error}`);
        break;
    }
  };

  handleWebSocketMessageRef.current = handleWebSocketMessage;

  // The computer pressed Done. A phone shows a "You're done" screen; a computer just disconnects.
  endedByHostRef.current = () => {
    if (isElectron) {
      handleDisconnectFromRemote();
      notify('The other computer ended the session.');
      return;
    }
    setSessionEnded(true);
  };

  // The connected computer forgot this device: drop back to pairing with a PIN.
  handleForgottenRef.current = () => {
    setYouAreTrusted(false);
    if (isElectron) {
      handleDisconnectFromRemote();
    } else {
      setCurrentScreen('pair-gate');
    }
  };

  // ---- Trusted-device actions ----
  const sendWS = (msg: object) => socketRef.current?.send(JSON.stringify(msg));
  const handleTrustDevice = (deviceId: string) => sendWS({ type: 'trust-device', deviceId });
  const handleForgetDevice = (deviceId: string) => sendWS({ type: 'untrust-device', deviceId });
  const handleSetAutoAccept = (deviceId: string, enabled: boolean) => sendWS({ type: 'set-auto-accept', deviceId, enabled });

  // This device asks its computer to forget it, deletes the saved key, and gets a new id.
  const handleForgetThisComputer = () => {
    sendWS({ type: 'forget-me' });
    const address = serverInfo ? `${serverInfo.ips[0]}:${serverInfo.port}` : window.location.host;
    removeSavedHost(address, findSavedHost(address)?.fingerprint);
    rotateDeviceId();
    setYouAreTrusted(false);
    setIsSettingsOpen(false);
    notify('Forgotten. You will need the PIN to connect again.');
  };

  const startBrowserUpload = async (transferId: string) => {
    const file = activeUploadsRef.current.get(transferId);
    if (!file || !serverInfo) return;

    const CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB chunks
    // At least one chunk, so empty (0-byte) files are still created on the other side.
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    try {
      socketRef.current?.send(
        JSON.stringify({
          type: 'transfer-started',
          transferId: transferId,
          name: file.name,
          size: file.size,
          dir: 'upload',
          device: myDeviceName
        })
      );

      const activeRequests = new Set<XMLHttpRequest>();
      const uploadedBytesList = new Array(totalChunks).fill(0);
      
      let nextChunkToQueue = 0;
      let lastReportTime = Date.now();
      let lastReportBytes = 0;

      const reportProgress = (bytesUploadedTotal: number) => {
        if (pausedTransfersRef.current.has(transferId)) {
          lastReportTime = Date.now();
          lastReportBytes = bytesUploadedTotal;
          return;
        }
        const now = Date.now();
        const elapsed = (now - lastReportTime) / 1000;
        
        if (elapsed >= 1.5) {
          const speed = (bytesUploadedTotal - lastReportBytes) / elapsed;
          lastReportTime = now;
          lastReportBytes = bytesUploadedTotal;

          socketRef.current?.send(
            JSON.stringify({
              type: 'transfer-progress',
              transferId: transferId,
              bytesTransferred: bytesUploadedTotal,
              speed: speed
            })
          );
        }
      };

      const uploadChunk = (chunkIndex: number): Promise<void> => {
        return new Promise((resolve, reject) => {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(file.size, start + CHUNK_SIZE);
          const chunkBlob = file.slice(start, end);

          const xhr = new XMLHttpRequest();
          activeRequests.add(xhr);

          const uploadUrl = `${httpScheme(serverInfo)}://${serverInfo.ips[0] || window.location.hostname}:${serverInfo.port}/api/upload-chunk?token=${serverInfo.token}&transferId=${transferId}&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}&fileName=${encodeURIComponent(file.name)}&fileSize=${file.size}`;
          
          xhr.open('POST', uploadUrl, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              uploadedBytesList[chunkIndex] = e.loaded;
              const totalUploaded = uploadedBytesList.reduce((a, b) => a + b, 0);
              reportProgress(totalUploaded);
            }
          };

          xhr.onload = () => {
            activeRequests.delete(xhr);
            if (xhr.status === 200) {
              uploadedBytesList[chunkIndex] = end - start;
              const totalUploaded = uploadedBytesList.reduce((a, b) => a + b, 0);
              reportProgress(totalUploaded);
              resolve();
            } else {
              reject(new Error(`Chunk upload failed with status ${xhr.status}`));
            }
          };

          xhr.onerror = () => {
            activeRequests.delete(xhr);
            reject(new Error('Chunk upload network connection error'));
          };

          xhr.send(chunkBlob);
        });
      };

      const processQueue = async () => {
        const MAX_CONCURRENT = 4;
        
        const spawnWorker = async () => {
          while (nextChunkToQueue < totalChunks) {
            while (pausedTransfersRef.current.has(transferId)) {
              await new Promise(r => setTimeout(r, 500));
            }
            const chunkIndex = nextChunkToQueue++;
            
            let success = false;
            let retries = 3;
            while (!success && retries > 0) {
              try {
                await uploadChunk(chunkIndex);
                success = true;
              } catch (err) {
                retries--;
                if (retries === 0) throw err;
                await new Promise(r => setTimeout(r, 1000));
              }
            }
          }
        };

        const workers = [];
        for (let i = 0; i < Math.min(MAX_CONCURRENT, totalChunks); i++) {
          workers.push(spawnWorker());
        }

        try {
          await Promise.all(workers);
          activeUploadsRef.current.delete(transferId);
        } catch (err: any) {
          activeRequests.forEach(xhr => xhr.abort());
          socketRef.current?.send(
            JSON.stringify({
              type: 'transfer-failed',
              transferId: transferId,
              error: err.message || 'Parallel upload queue failed'
            })
          );
        }
      };

      await processQueue();
    } catch (err: any) {
      socketRef.current?.send(
        JSON.stringify({
          type: 'transfer-failed',
          transferId: transferId,
          error: err.message || 'Upload queue setup error'
        })
      );
    }
  };

  const handleSendFiles = (files: any[], peerId: string) => {
    if (!socketRef.current || !serverInfo) return;

    if (files.length === 0) return;

    // Everything sent in one go is one batch: the receiver answers it with a single Accept.
    const batchId = randomId();
    const batchCount = files.length;
    const topFolders = new Set(
      files.map((f) => (typeof f.relativePath === 'string' && f.relativePath.includes('/') ? f.relativePath.split('/')[0] : ''))
    );
    const sharedFolder = topFolders.size === 1 ? [...topFolders][0] : '';
    const batchName = batchCount === 1 ? files[0].name : sharedFolder || `${batchCount} files`;

    files.forEach((file) => {
      const transferId = randomId();
      outgoingOffersRef.current.set(transferId, { name: file.name, size: file.size, isFolder: file.isFolder });
      const batchFields = {
        batchId,
        batchName,
        batchCount,
        relativePath: typeof file.relativePath === 'string' ? file.relativePath : undefined
      };

      if (isElectron) {
        socketRef.current?.send(
          JSON.stringify({
            type: 'file-offer',
            fileId: file.fileId,
            transferId: transferId,
            targetId: peerId,
            name: file.name,
            size: file.size,
            senderId: isHost ? 'desktop-main' : myDeviceId,
            senderName: isHost ? (serverInfo?.deviceName || 'Weshare Desktop') : myDeviceName,
            isFolder: file.isFolder,
            ...batchFields
          })
        );
      } else {
        if (file.rawFile) {
          activeUploadsRef.current.set(transferId, file.rawFile);
        }
        socketRef.current?.send(
          JSON.stringify({
            type: 'file-offer',
            transferId: transferId,
            targetId: peerId,
            name: file.name,
            size: file.size,
            senderId: myDeviceId,
            senderName: myDeviceName,
            ...batchFields
          })
        );
      }
    });

    setDraggedFiles([]);
  };

  const startNativeDownload = async (downloadUrl: string, transferId: string, isFolder?: boolean) => {
    try {
      const tx = transfers.find(t => t.id === transferId);
      const offer = offerInfoRef.current.get(transferId);
      const fileName = offer?.name || tx?.name || 'downloaded-file';
      const fileSize = offer?.size || tx?.size || 0;
      const folderFlag = isFolder !== undefined ? isFolder : (offer?.isFolder || tx?.isFolder || false);

      const success = await window.electronAPI.startFileDownload({
        downloadUrl,
        transferId,
        fileName,
        fileSize,
        isFolder: folderFlag
      });
      
      if (success) {
        console.log(`[Native Download] Success for transfer ${transferId}`);
      } else {
        console.error(`[Native Download] Failed for transfer ${transferId}`);
      }
    } catch (err) {
      console.error('[Native Download] Error calling Electron API:', err);
    }
  };

  const startNativeUpload = async (transferId: string, fileId: string) => {
    if (!serverInfo) return;
    try {
      const tx = transfers.find(t => t.id === transferId);
      const sent = outgoingOffersRef.current.get(transferId);
      const fileName = sent?.name || tx?.name || 'uploaded-file';
      const fileSize = sent?.size ?? tx?.size ?? 0;
      const isFolder = sent?.isFolder || tx?.isFolder || false;
      outgoingOffersRef.current.delete(transferId);

      let uploadUrl = `${httpScheme(serverInfo)}://${serverInfo.ips[0] || window.location.hostname}:${serverInfo.port}/api/upload?token=${serverInfo.token}&transferId=${transferId}`;
      if (isFolder) {
        uploadUrl += `&isFolder=true`;
      }

      socketRef.current?.send(
        JSON.stringify({
          type: 'transfer-started',
          transferId: transferId,
          name: fileName,
          size: fileSize,
          dir: 'upload',
          device: myDeviceName
        })
      );

      const success = await window.electronAPI.startFileUpload({
        uploadUrl,
        transferId,
        fileId,
        fileName,
        fileSize,
        isFolder
      });

      if (success) {
        socketRef.current?.send(
          JSON.stringify({
            type: 'transfer-completed',
            transferId: transferId
          })
        );
      } else {
        socketRef.current?.send(
          JSON.stringify({
            type: 'transfer-failed',
            transferId: transferId,
            error: 'Native upload failed'
          })
        );
      }
    } catch (err: any) {
      console.error('[Native Upload] Failed to start:', err);
      socketRef.current?.send(
        JSON.stringify({
          type: 'transfer-failed',
          transferId: transferId,
          error: err.message || 'Native upload failed'
        })
      );
    }
  };

  // Phones/browsers fetch files inside the page (see utils/pageDownload), one at a time,
  // then save each one. A file that finishes after the first may need a tap on Save,
  // because browsers only let a page save one file by itself.
  const updatePageDownload = (id: string, patch: Partial<PageDownload>) =>
    setPageDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const startPageDownload = (id: string, name: string, url: string, expectedSize: number) => {
    setPageDownloads((prev) => [
      ...prev.filter((d) => d.id !== id),
      { id, name, url, status: 'queued', received: 0, total: expectedSize }
    ]);
    let cancelled = false;
    pageDownloadAbortsRef.current.set(id, () => { cancelled = true; });

    pageDownloadChainRef.current = pageDownloadChainRef.current.then(async () => {
      if (cancelled) return;
      updatePageDownload(id, { status: 'downloading' });
      let lastUpdate = 0;
      const handle = downloadInPage(url, ({ received, total }) => {
        const now = Date.now();
        if (now - lastUpdate > 300 || received >= total) {
          lastUpdate = now;
          updatePageDownload(id, { received, total });
        }
      });
      pageDownloadAbortsRef.current.set(id, handle.abort);
      try {
        const blob = await handle.promise;
        const blobUrl = URL.createObjectURL(blob);
        updatePageDownload(id, { status: 'ready', blobUrl, received: blob.size, total: blob.size });
        saveBlob(blobUrl, name);
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        console.error('[Page download] failed:', err);
        updatePageDownload(id, { status: 'error', error: err?.message || 'Download failed' });
      } finally {
        pageDownloadAbortsRef.current.delete(id);
      }
    }).catch(() => {});
  };

  const clearFinishedPageDownloads = () =>
    setPageDownloads((prev) => {
      prev.forEach((d) => d.blobUrl && URL.revokeObjectURL(d.blobUrl));
      return prev.filter((d) => d.status === 'queued' || d.status === 'downloading');
    });

  const acceptTransfer = (transferId: string, fileId?: string) => {
    if (!socketRef.current || !serverInfo) return;

    if (isHost) {
      socketRef.current.send(
        JSON.stringify({
          type: 'file-accept',
          transferId: transferId
        })
      );
    } else {
      socketRef.current.send(
        JSON.stringify({
          type: 'file-accept',
          transferId: transferId,
          fileId: fileId
        })
      );

      const userAgent = navigator.userAgent.toLowerCase();
      let clientOS = 'Unknown Mobile';
      if (userAgent.includes('iphone') || userAgent.includes('ipad')) clientOS = 'iOS';
      else if (userAgent.includes('android')) clientOS = 'Android';
      else if (userAgent.includes('macintosh')) clientOS = 'macOS';
      else if (userAgent.includes('windows')) clientOS = 'Windows';

      const tx = transfers.find(t => t.id === transferId);
      const isFolder = offerInfoRef.current.get(transferId)?.isFolder || tx?.isFolder || false;
      
      let downloadUrl = `${httpScheme(serverInfo)}://${serverInfo.ips[0] || window.location.hostname}:${serverInfo.port}/api/download/${fileId}?token=${serverInfo.token}&transferId=${transferId}&deviceName=${encodeURIComponent(myDeviceName)}&deviceOS=${encodeURIComponent(clientOS)}`;
      if (isFolder) {
        downloadUrl += `&isFolder=true`;
      }
      
      if (isElectron) {
        startNativeDownload(downloadUrl, transferId, isFolder);
      } else {
        const offer = offerInfoRef.current.get(transferId);
        const name = isFolder ? `${offer?.name || tx?.name || 'folder'}.zip` : offer?.name || tx?.name || 'file';
        startPageDownload(transferId, name, downloadUrl, offer?.size || tx?.size || 0);
      }
    }
  };

  const rejectTransfer = (transferId: string) => {
    if (isElectron) {
      window.electronAPI.cancelNativeTransfer(transferId);
    }
    if (socketRef.current) {
      socketRef.current.send(
        JSON.stringify({
          type: 'file-reject',
          transferId: transferId
        })
      );
    }
  };

  const handleTogglePause = () => {
    if (!activeTx) return;
    const newPausedState = !isTransferPaused;
    setIsTransferPaused(newPausedState);
    
    if (newPausedState) {
      pausedTransfersRef.current.add(activeTx.id);
    } else {
      pausedTransfersRef.current.delete(activeTx.id);
    }

    if (isElectron) {
      window.electronAPI.toggleNativeTransfer(activeTx.id, newPausedState);
    }

    setTransfers((prevTransfers) =>
      prevTransfers.map((tx) =>
        tx.id === activeTx.id
          ? {
              ...tx,
              status: newPausedState ? 'paused' : 'transferring',
              speed: 0
            }
          : tx
      )
    );
    
    socketRef.current?.send(
      JSON.stringify({
        type: 'transfer-toggle-pause',
        transferId: activeTx.id,
        paused: newPausedState
      })
    );
  };

  const answerBatch = (answer: 'accept' | 'reject') => {
    const batch = incomingBatch;
    if (!batch) return;
    // Files of this batch still on their way get the same answer when they arrive.
    if (batch.offers.length < batch.expected) {
      answeredBatchesRef.current.set(batch.key, answer);
    }
    batch.offers.forEach((offer) =>
      answer === 'accept' ? acceptTransfer(offer.transferId, offer.fileId) : rejectTransfer(offer.transferId)
    );
    setIncomingBatches((prev) => prev.filter((b) => b.key !== batch.key));
  };
  const handleAcceptOffer = () => answerBatch('accept');
  const handleRejectOffer = () => answerBatch('reject');

  const handleOpenFolder = (filePath?: string) => {
    if (isElectron && window.electronAPI) {
      window.electronAPI.openFolder(filePath);
    }
  };

  const handleRegenerateToken = async () => {
    if (isElectron && window.electronAPI) {
      const result = await window.electronAPI.regenerateToken();
      setServerInfo((prev) => prev ? { ...prev, token: result.token } : null);
    }
  };

  const handleStartUpdate = async () => {
    if (!updateAvailable) return;
    setIsDownloadingUpdate(true);
    setUpdateError(null);
    setUpdateProgress(0);

    try {
      const success = await window.electronAPI.startUpdateDownload();
      if (success) {
        await window.electronAPI.installUpdate();
      } else {
        setUpdateError('The update could not be downloaded or failed its security check. Please try again later.');
        setIsDownloadingUpdate(false);
      }
    } catch (err: any) {
      setUpdateError(err.message || 'An error occurred during update.');
      setIsDownloadingUpdate(false);
    }
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    if (customDeviceName.trim()) {
      localStorage.setItem('weshare_custom_device_name', customDeviceName.trim());
      setMyDeviceName(customDeviceName.trim());
    }
    setIsSettingsOpen(false);
  };

  const formatSpeed = (bytesPerSec: number): string => {
    if (bytesPerSec <= 0) return '0 B/s';
    const mbs = bytesPerSec / (1024 * 1024);
    if (mbs < 0.1) {
      return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    }
    return `${mbs.toFixed(1)} MB/s`;
  };

  const calculateRemainingTime = (tx: TransferInfo) => {
    if (!tx.speed || tx.speed <= 0) return 'Estimating...';
    const remainingBytes = tx.size - tx.bytesTransferred;
    const secs = remainingBytes / tx.speed;
    if (secs < 1) return 'Done';
    if (secs < 60) return `${Math.ceil(secs)}s remaining`;
    const mins = Math.floor(secs / 60);
    const remainingSecs = Math.ceil(secs % 60);
    return `${mins}m ${remainingSecs}s remaining`;
  };

  const activeTransfers = transfers.filter((tx) => tx.status === 'transferring' || tx.status === 'paused' || (tx.status === 'pending' && tx.type === 'send'));
  // The ring follows the file that is actually moving; files still waiting their turn come after.
  const activeTx =
    activeTransfers.find((tx) => tx.status === 'transferring') ||
    activeTransfers.find((tx) => tx.status === 'paused') ||
    activeTransfers[0];

  const getDeviceIcon = (deviceType?: string) => {
    if (!deviceType) return <Smartphone size={32} />;
    if (deviceType.toLowerCase().includes('laptop') || deviceType.toLowerCase().includes('desktop') || deviceType.toLowerCase().includes('windows')) {
      return <Laptop size={32} />;
    } else if (deviceType.toLowerCase().includes('ipad') || deviceType.toLowerCase().includes('tablet')) {
      return <Tablet size={32} />;
    }
    return <Smartphone size={32} />;
  };

  const sessionTransfers = activeTx 
    ? transfers.filter(tx => tx.device === activeTx.device && (tx.status === 'transferring' || tx.status === 'paused' || tx.status === 'pending' || tx.status === 'completed' || tx.status === 'failed')).slice(0, 10)
    : [];
  // "File 2 of 5" when several files go in one go.
  const activeFileNumber = activeTx ? sessionTransfers.filter((tx) => tx.status === 'completed' || tx.status === 'failed').length + 1 : 0;


  if (isOnboarded === null && currentScreen !== 'admin') {
    return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />;
  }

  if (sessionEnded && !isElectron) {
    return (
      <SessionEnded
        onConnectAgain={() => {
          setSessionEnded(false);
          setCurrentScreen('pair-gate');
        }}
      />
    );
  }

  if (!isOnboarded && currentScreen !== 'admin') {
    return <Onboarding onComplete={() => setIsOnboarded(true)} />;
  }

  // Desktop app: sign in first; once the free trial or paid week is over, only the pay screen.
  if (isElectron && accountBlocksApp(account)) {
    return account!.status === 'signed-out' ? <AccountScreen /> : <PayScreen account={account!} />;
  }

  const navItems = isHost ? [
    { id: 'nearby', label: 'Nearby Devices', icon: <Wifi size={15} /> },
    { id: 'send', label: 'Send Files', icon: <Send size={15} /> },
    { id: 'receive', label: 'Receive Files', icon: <QrCode size={15} /> },
    { id: 'history', label: 'Transfer History', icon: <History size={15} /> }
  ] : [
    { id: 'send', label: 'Send Files', icon: <Send size={15} /> },
    { id: 'browse', label: 'Browse Computer', icon: <HardDrive size={15} /> },
    { id: 'history', label: 'Transfer History', icon: <History size={15} /> }
  ];

  // Shared folders are opened with this device's own key (from being remembered), never the PIN.
  const hostAddress = serverInfo ? `${serverInfo.ips[0] || window.location.hostname}:${serverInfo.port}` : window.location.host;
  const browseToken = !isHost
    ? findSavedHost(hostAddress)?.token || (serverInfo?.token?.startsWith('t.') ? serverInfo.token : null)
    : null;

  const handleBrowseDownload = (url: string, name: string, size: number, isFolder: boolean) => {
    if (isElectron) {
      window.electronAPI.startFileDownload({ downloadUrl: url, transferId: randomId(), fileName: name, fileSize: size, isFolder })
        .then((ok) => notify(ok ? `Saved ${name}` : `Could not download ${name}`, ok ? 'success' : 'error'));
    } else {
      startPageDownload(randomId(), isFolder ? `${name}.zip` : name, url, size);
    }
  };

  return (
    <div className={`app-container${isElectron ? ' has-titlebar' : ''}`}>
      {isElectron && <div className="titlebar-drag-region" />}

      {isDraggingFile && (
        <div className="global-drag-overlay">
          <div className="global-drag-content">
            <UploadCloud size={64} style={{ color: 'var(--primary-light)', animation: 'float 3s ease-in-out infinite' }} />
            <h3>Drop Files Anywhere to Share</h3>
            <p>Ready to transmit over secure local network</p>
          </div>
        </div>
      )}

      <header className="app-header">
        <div className="logo-container" onClick={() => setCurrentScreen('nearby')} style={{ cursor: 'pointer' }}>
          <div className="logo-icon" style={{ background: 'none', boxShadow: 'none', width: '32px', height: '32px' }}>
            <img src={LogoImg} alt="Weshare Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          <span className="logo-text">Weshare</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', WebkitAppRegion: 'none' } as any}>
          {isElectron && account && <AccountBadge account={account} />}
          <span
            className="connection-status-badge"
            style={{
              fontSize: '11px',
              color: wsConnected ? 'var(--success)' : 'var(--error)',
              background: wsConnected ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)',
              padding: '4px 10px',
              borderRadius: '999px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <span
              className={`pulse-indicator ${wsConnected ? 'cyan' : ''}`}
              style={{ width: '6px', height: '6px', margin: 0 }}
            ></span>
            <span className="badge-text">
              {wsConnected ? (serverInfo?.secure ? 'ENCRYPTED LAN ACTIVE' : 'LAN ACTIVE') : 'CONNECTING...'}
            </span>
          </span>

          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="interactive-btn"
            style={{ padding: '6px', borderRadius: '8px', minWidth: 'unset', width: '32px', height: '32px' }}
            title="Weshare Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      {updateAvailable && (
        <div className="update-banner">
          <div className="update-banner-content">
            <Sparkles size={18} style={{ color: 'var(--accent-light)' }} />
            <div className="update-banner-text">
              <strong>Update Available (v{updateAvailable.version})</strong>
              <span style={{ margin: '0 8px', color: 'var(--text-muted)' }}>•</span>
              <span>{updateAvailable.notes || 'Performance enhancements and bug fixes.'}</span>
              {updateAvailable.mandatory && (
                <span style={{ marginLeft: '8px', color: 'var(--error)', fontWeight: 600, fontSize: '11px', background: 'rgba(244,63,94,0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                  Mandatory Update
                </span>
              )}
            </div>
          </div>
          
          {isDownloadingUpdate ? (
            <div className="update-progress-container">
              <div className="update-progress-text">
                <span>Downloading update package...</span>
                <span>{updateProgress !== null ? `${updateProgress}%` : '0%'}</span>
              </div>
              <div className="progress-bar-container" style={{ height: '6px' }}>
                <div className="progress-bar-fill" style={{ width: `${updateProgress || 0}%` }} />
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {updateError && (
                <span style={{ color: 'var(--error)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <ShieldAlert size={14} />
                  {updateError}
                </span>
              )}
              <button 
                className="interactive-btn primary" 
                onClick={handleStartUpdate}
                style={{ padding: '6px 16px', fontSize: '12.5px', height: '34px' }}
              >
                <Download size={14} />
                Update Now
              </button>
            </div>
          )}
        </div>
      )}

      {isSettingsOpen && (
        <div className="dialog-overlay" style={{ zIndex: 10000 }}>
          <div className="glass-panel settings-modal-card" style={{ animation: 'fadeIn 0.2s cubic-bezier(0.4, 0, 0.2, 1)' }}>
            <h3 style={{ fontSize: '18px', marginBottom: '16px', fontFamily: 'var(--font-title)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Settings size={18} style={{ color: 'var(--primary-light)' }} />
              Weshare Settings
            </h3>
            
            <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'left' }}>DEVICE NAME</label>
                <input
                  type="text"
                  placeholder="e.g. My Laptop Node"
                  value={customDeviceName || (isHost ? (serverInfo?.deviceName || 'Weshare Desktop') : myDeviceName)}
                  onChange={(e) => setCustomDeviceName(e.target.value)}
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    fontSize: '14px',
                    width: '100%'
                  }}
                  required
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', textAlign: 'left', background: 'rgba(0,0,0,0.15)', padding: '12px', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>SERVER DETAILS</span>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>IP: <strong style={{ color: 'var(--text-primary)' }}>{serverInfo?.ips[0] || '127.0.0.1'}</strong></span>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Port: <strong style={{ color: 'var(--text-primary)' }}>{serverInfo?.port || 5003}</strong></span>
                {/* Only the host shows its PIN; on other devices this may be a personal device key. */}
                {isHost && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>Pairing PIN: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{serverInfo?.token || 'N/A'}</strong></span>
                )}
              </div>

              {isElectron && isHost && <SharedFoldersPanel />}

              {isElectron && isHost && (
                <TrustedDevicesPanel
                  peers={peers}
                  trustedDevices={trustedDevices}
                  onTrust={handleTrustDevice}
                  onForget={handleForgetDevice}
                  onSetAutoAccept={handleSetAutoAccept}
                />
              )}

              {!isHost && youAreTrusted && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', textAlign: 'left' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    This computer remembers this device, so you won't need the PIN next time.
                  </span>
                  <button
                    type="button"
                    className="interactive-btn"
                    onClick={handleForgetThisComputer}
                    style={{ fontSize: '12px', padding: '6px 12px', color: 'var(--error)', alignSelf: 'flex-start' }}
                  >
                    Forget this computer
                  </button>
                </div>
              )}

              {isElectron && isHost && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="interactive-btn"
                    onClick={handleRegenerateToken}
                    style={{ fontSize: '12px', padding: '6px 12px' }}
                  >
                    Regenerate Pairing PIN
                  </button>
                  {isAdminDevice && <button
                    type="button"
                    className="interactive-btn primary"
                    onClick={() => {
                      setIsSettingsOpen(false);
                      setCurrentScreen('admin');
                    }}
                    style={{ fontSize: '12px', padding: '6px 12px', background: 'var(--primary)', color: 'var(--text-on-primary)' }}
                  >
                    Admin Console
                  </button>}
                </div>
              )}

              <div className="dialog-actions" style={{ marginTop: '8px' }}>
                <button
                  type="button"
                  className="interactive-btn"
                  onClick={() => setIsSettingsOpen(false)}
                  style={{ flex: 1, color: 'var(--text-secondary)' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="interactive-btn primary"
                  style={{ flex: 1 }}
                >
                  Save & Close
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <main className="app-main">
        {currentScreen === 'pair-gate' ? (
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 0 }}>
            <div className="glass-panel" style={{ padding: '36px', maxWidth: '400px', width: '100%', display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out' }}>
              <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="icon-tile" style={{ alignSelf: 'center', padding: '12px', marginBottom: '4px' }}>
                  <QrCode size={32} />
                </div>
                <h3 style={{ fontSize: '22px', fontFamily: 'var(--font-title)' }}>Pair a device</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: '1.5' }}>
                  Enter the Host IP Address and 6-digit PIN shown on the host device's screen to connect.
                </p>
              </div>

              <form onSubmit={handlePairSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'left' }}>HOST IP ADDRESS</label>
                  <input
                    type="text"
                    placeholder="e.g. 192.168.1.15"
                    value={hostIp}
                    onChange={(e) => setHostIp(e.target.value)}
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid var(--glass-border)',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      color: 'var(--text-primary)',
                      outline: 'none',
                      fontSize: '14px'
                    }}
                    required
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'left' }}>6-DIGIT PIN</label>
                  <input
                    type="text"
                    maxLength={6}
                    placeholder="e.g. 582914"
                    value={pairingPin}
                    onChange={(e) => setPairingPin(e.target.value.replace(/\D/g, ''))}
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid var(--glass-border)',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      color: 'var(--text-primary)',
                      outline: 'none',
                      fontSize: '14px',
                      textAlign: 'center',
                      fontFamily: 'monospace',
                      letterSpacing: '4px'
                    }}
                    required
                  />
                </div>
                
                <button className="interactive-btn primary" type="submit" style={{ width: '100%', padding: '12px', fontSize: '14px', marginTop: '8px' }}>
                  Link Device
                </button>
              </form>
            </div>
          </div>
        ) : currentScreen === 'admin' ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', padding: '12px 24px', background: 'rgba(26, 26, 34, 0.4)', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', justifyContent: 'space-between', zIndex: 100 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                  className="interactive-btn"
                  onClick={() => setCurrentScreen(isHost ? 'nearby' : 'send')}
                  style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <ArrowLeft size={12} />
                  Back Dashboard
                </button>
                <h2 style={{ fontSize: '14px', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>Weshare Admin Console</h2>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Secure Console Mode</span>
            </div>
            <div style={{ flex: 1, display: 'flex', minHeight: 0, padding: '20px', boxSizing: 'border-box' }}>
              <AdminDashboard />
            </div>
          </div>
        ) : activeTx ? (
          <div className="transfer-interface-container">
            <div className="transfer-left-column">
              <div className="glass-panel transfer-files-panel">
                <h3 style={{ fontSize: '15px', color: 'var(--text-primary)', borderBottom: '1px solid var(--glass-border)', paddingBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <File size={16} style={{ color: 'var(--primary-light)' }} />
                  Selected Files ({sessionTransfers.length})
                </h3>
                <div className="transfer-files-list">
                  {sessionTransfers.map((tx) => (
                    <div key={tx.id} className="transfer-file-item" style={{ opacity: tx.id === activeTx.id ? 1 : 0.6, borderLeft: tx.id === activeTx.id ? '2px solid var(--accent)' : 'none', paddingLeft: tx.id === activeTx.id ? '12px' : '10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                        {tx.isFolder ? (
                          <FolderOpen size={14} style={{ color: tx.id === activeTx.id ? 'var(--accent-light)' : 'var(--text-muted)', flexShrink: 0 }} />
                        ) : (
                          <File size={14} style={{ color: tx.id === activeTx.id ? 'var(--accent-light)' : 'var(--text-muted)', flexShrink: 0 }} />
                        )}
                        <span style={{ fontWeight: tx.id === activeTx.id ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tx.name}>
                          {tx.name}
                        </span>
                      </div>
                      <span style={{ fontSize: '11px', marginLeft: '8px', flexShrink: 0, fontFamily: 'var(--font-mono)', color:
                        tx.status === 'completed' ? 'var(--success)' :
                        tx.status === 'failed' ? 'var(--error)' :
                        tx.id === activeTx.id ? 'var(--accent-light)' : 'var(--text-muted)' }}>
                        {tx.status === 'completed' ? '✓ Done' :
                          tx.status === 'failed' ? 'Failed' :
                          tx.id === activeTx.id ? `${tx.progress}%` :
                          tx.status === 'pending' ? 'Waiting' : formatSize(tx.size)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="transfer-center-column">
              <div className="transfer-circle-container">
                <svg className="transfer-circle-svg" viewBox="0 0 220 220">
                  <defs>
                    <linearGradient id="transferProgressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="var(--primary)" />
                      <stop offset="100%" stopColor="var(--accent)" />
                    </linearGradient>
                  </defs>
                  <circle className="transfer-circle-bg" cx="110" cy="110" r="90" />
                  <circle
                    key={activeTx.id}
                    className="transfer-circle-progress"
                    cx="110"
                    cy="110"
                    r="90"
                    style={{ 
                      strokeDashoffset: 565.48 - (activeTx.progress / 100) * 565.48 
                    }}
                  />
                </svg>
                <div className="transfer-circle-content">
                  <span className="transfer-percent-text">{activeTx.progress}%</span>
                  <span className="transfer-speed-text">
                    {isTransferPaused ? 'Paused' : formatSpeed(activeTx.speed)}
                  </span>
                  <span className="transfer-eta-text">
                    {isTransferPaused ? 'Suspended' : calculateRemainingTime(activeTx)}
                  </span>
                </div>
              </div>
              
              <div style={{ maxWidth: '340px', width: '100%', padding: '0 16px', boxSizing: 'border-box' }}>
                {sessionTransfers.length > 1 && (
                  <span className="mono-label" style={{ display: 'block', marginBottom: '6px' }}>
                    File {Math.min(activeFileNumber, sessionTransfers.length)} of {sessionTransfers.length}
                  </span>
                )}
                <h4 style={{ fontSize: '16px', color: 'var(--text-primary)', marginBottom: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {activeTx.type === 'send' ? 'Sending' : 'Receiving'}: {activeTx.name}
                </h4>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {formatSize(activeTx.bytesTransferred)} of {formatSize(activeTx.size)} transferred
                </p>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
                <button 
                  onClick={handleTogglePause}
                  className="interactive-btn"
                  style={{ minWidth: '100px' }}
                >
                  {isTransferPaused ? <Play size={14} /> : <Pause size={14} />}
                  {isTransferPaused ? 'Resume' : 'Pause'}
                </button>
                <button 
                  onClick={() => rejectTransfer(activeTx.id)}
                  className="interactive-btn"
                  style={{ minWidth: '100px', color: 'var(--error)', borderColor: 'rgba(244,63,94,0.2)' }}
                >
                  Cancel
                </button>
                {isElectron && (
                  <button 
                    onClick={() => handleOpenFolder(activeTx.filePath)}
                    className="interactive-btn"
                    style={{ minWidth: '100px' }}
                  >
                    <FolderOpen size={14} />
                    Open Folder
                  </button>
                )}
              </div>
            </div>

            <div className="transfer-right-column">
              <div className="glass-panel transfer-device-card">
                <div className="transfer-device-icon">
                  {getDeviceIcon(activeTx.device)}
                </div>
                <div>
                  <h3 style={{ fontSize: '16px', color: 'var(--text-primary)', marginBottom: '4px' }}>
                    {activeTx.device || 'Remote Device'}
                  </h3>
                  <span style={{ fontSize: '11px', color: 'var(--success)', background: 'rgba(16,185,129,0.08)', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
                    ACTIVE CONNECTION
                  </span>
                </div>
                <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '16px', width: '100%', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12.5px', color: 'var(--text-secondary)', textAlign: 'center' }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Session Status:</span>{' '}
                    <strong style={{ color: 'var(--accent-light)' }}>{isTransferPaused ? 'Paused' : 'Transmitting'}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Secure Protocol:</span>{' '}
                    <strong style={{ color: 'var(--text-primary)' }}>Weshare LAN</strong>
                  </div>
                </div>
              </div>
            </div>

          </div>
        ) : (
          <div className="app-main-layout">
            <aside className="sidebar-nav">
              {navItems.map((item, index) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setDraggedFiles([]);
                    setCurrentScreen(item.id as any);
                  }}
                  className={`sidebar-item ${currentScreen === item.id ? 'active' : ''}`}
                >
                  <span className="nav-num">{String(index + 1).padStart(2, '0')}</span>
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </aside>

            <section className="workspace-content">
              {(() => {
                const index = navItems.findIndex((item) => item.id === currentScreen);
                const label = index >= 0 ? navItems[index].label : '';
                const where = serverInfo?.ips?.[0] ? `${serverInfo.ips[0]}:${serverInfo.port}` : '';
                return label ? (
                  <div className="ws-bar mono">
                    <span>{String(index + 1).padStart(2, '0')} / {label}</span>
                    <span>{serverInfo?.secure ? 'Encrypted' : 'Local network'}{where ? ` · ${where}` : ''}</span>
                  </div>
                ) : null;
              })()}
              <div className="ws-body">
              {currentScreen === 'nearby' && (
                <Dashboard
                  peers={peers}
                  discoveredDevices={discoveredDevices}
                  deviceName={customDeviceName || (isHost ? (serverInfo?.deviceName || 'Weshare Desktop') : (serverInfo?.deviceName || 'Remote Host'))}
                  ips={serverInfo?.ips || []}
                  port={serverInfo?.port || 5003}
                  isElectron={isElectron}
                  isHost={isHost}
                  token={serverInfo?.token}
                  onNavigate={setCurrentScreen as any}
                  onConnectToRemote={handleConnectToRemote}
                  onDisconnectFromRemote={handleDisconnectFromRemote}
                  hasSavedKey={(address, fingerprint) => !!findSavedHost(address, fingerprint)}
                />
              )}

              {currentScreen === 'send' && (
                <SendScreen
                  peers={peers}
                  isElectron={isElectron}
                  isHost={isHost}
                  onSendFiles={handleSendFiles}
                  initialFiles={draggedFiles}
                  serverInfo={serverInfo}
                  onRegenerateToken={handleRegenerateToken}
                  onConnectToRemote={handleConnectToRemote}
                />
              )}

              {currentScreen === 'receive' && isHost && (
                <ReceiveScreen serverInfo={serverInfo} onRegenerateToken={handleRegenerateToken} onConnectToRemote={handleConnectToRemote} />
              )}

              {currentScreen === 'browse' && !isHost && (
                <BrowseScreen
                  baseUrl={`${httpScheme(serverInfo)}://${hostAddress}`}
                  token={browseToken}
                  hostName={serverInfo?.deviceName || 'your computer'}
                  onDownload={handleBrowseDownload}
                />
              )}

              {currentScreen === 'history' && (
                <HistoryList
                  transfers={transfers}
                  isElectron={isElectron}
                  isHost={isHost}
                  onOpenFolder={handleOpenFolder}
                  onAcceptTransfer={acceptTransfer}
                  onRejectTransfer={rejectTransfer}
                  isFullPage={true}
                />
              )}
              </div>
            </section>
          </div>
        )}
      </main>

      <Toast toast={toast} onDismiss={dismissToast} />

      {!isElectron && pageDownloads.length > 0 && (() => {
        const active = pageDownloads.filter((d) => d.status === 'queued' || d.status === 'downloading').length;
        return (
          <div
            className="glass-panel"
            style={{
              position: 'fixed', left: '16px', right: '16px', bottom: '16px', zIndex: 10000,
              maxWidth: '480px', margin: '0 auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
              <strong style={{ fontSize: '13px' }}>
                {active > 0 ? `Receiving ${active} ${active === 1 ? 'file' : 'files'}` : 'Downloads'}
              </strong>
              {active < pageDownloads.length && (
                <button
                  className="interactive-btn"
                  onClick={clearFinishedPageDownloads}
                  style={{ padding: '2px 10px', fontSize: '11.5px', minWidth: 'unset' }}
                >
                  Clear finished
                </button>
              )}
            </div>
            {active > 0 && (
              <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                Keep this page open until it finishes.
              </span>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '240px', overflowY: 'auto' }}>
              {pageDownloads.map((d) => {
                const pct = d.total > 0 ? Math.min(100, Math.floor((d.received / d.total) * 100)) : 0;
                return (
                  <div key={d.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <File size={14} style={{ flexShrink: 0, color: 'var(--primary-light)' }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>
                        {d.name}
                      </span>
                      {d.status === 'queued' && <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>Waiting…</span>}
                      {d.status === 'downloading' && (
                        <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)', flexShrink: 0 }}>
                          {pct}% · {formatSize(d.received)}{d.total > 0 ? ` of ${formatSize(d.total)}` : ''}
                        </span>
                      )}
                      {d.status === 'ready' && d.blobUrl && (
                        <a
                          href={d.blobUrl}
                          download={d.name}
                          className="interactive-btn primary"
                          style={{ padding: '4px 12px', fontSize: '12px', minWidth: 'unset', textDecoration: 'none' }}
                        >
                          <Download size={13} /> Save
                        </a>
                      )}
                      {d.status === 'error' && (
                        <button
                          className="interactive-btn"
                          onClick={() => startPageDownload(d.id, d.name, d.url, d.total)}
                          style={{ padding: '4px 12px', fontSize: '12px', minWidth: 'unset', color: 'var(--error)' }}
                          title={d.error}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                    {d.status === 'downloading' && (
                      <div style={{ height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
                      </div>
                    )}
                    {d.status === 'ready' && (
                      <span style={{ fontSize: '11px', color: 'var(--success)' }}>Received. If it didn't save by itself, tap Save.</span>
                    )}
                    {d.status === 'error' && (
                      <span style={{ fontSize: '11px', color: 'var(--error)' }}>{d.error}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {incomingBatch && (
        <div className="dialog-overlay" style={{ zIndex: 10001 }}>
          <div className="glass-panel dialog-content" style={{ animation: 'fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--accent-light)' }}>
              <Download size={48} />
            </div>
            <div>
              <h4 style={{ fontSize: '18px', marginBottom: '6px', fontFamily: 'var(--font-title)' }}>
                {incomingBatch.expected > 1 ? 'Incoming Files' : 'Incoming File Offer'}
              </h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{incomingBatch.senderName}</strong> wants to send
                {incomingBatch.expected > 1
                  ? <> {incomingBatch.expected} files ({formatSize(incomingBatch.offers.reduce((sum, o) => sum + o.size, 0))}{incomingBatch.offers.length < incomingBatch.expected ? ' so far' : ''}):</>
                  : ':'}
              </p>
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  padding: '12px',
                  borderRadius: '10px',
                  marginTop: '12px',
                  fontFamily: 'monospace',
                  fontSize: '13px',
                  wordBreak: 'break-all',
                  border: '1px solid var(--glass-border)',
                  maxHeight: '180px',
                  overflowY: 'auto',
                  textAlign: 'left'
                }}
              >
                {incomingBatch.expected > 1 && incomingBatch.name && (
                  <div style={{ fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>{incomingBatch.name}</div>
                )}
                {incomingBatch.offers.slice(0, 50).map((o) => (
                  <div key={o.transferId}>
                    {o.relativePath || o.name} ({formatSize(o.size)})
                  </div>
                ))}
                {incomingBatch.offers.length > 50 && (
                  <div style={{ color: 'var(--text-secondary)' }}>…and {incomingBatch.offers.length - 50} more</div>
                )}
              </div>
              {incomingBatches.length > 1 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '8px' }}>
                  {incomingBatches.length - 1} more {incomingBatches.length === 2 ? 'offer' : 'offers'} waiting
                </p>
              )}
            </div>

            <div className="dialog-actions">
              <button
                className="interactive-btn"
                onClick={handleRejectOffer}
                style={{ flex: 1, color: 'var(--text-secondary)' }}
              >
                {incomingBatch.expected > 1 ? 'Decline all' : 'Decline'}
              </button>
              <button
                className="interactive-btn primary"
                onClick={handleAcceptOffer}
                style={{ flex: 1 }}
              >
                {incomingBatch.expected > 1 ? 'Accept all' : 'Accept'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
