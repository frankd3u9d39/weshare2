import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { startServer, stopServer, broadcastState, isServerSecure, endGuestSessions } from '../server';
import { DeviceManager } from '../services/deviceManager';
import { registerFileSelectionHandlers } from './fileSelection';
import { initAccount } from './account';
import { registerNativeTransferHandlers } from './nativeTransfer';
import { registerUpdaterHandlers } from './updater';
import { startUDPDiscovery, DiscoveryHandle } from './discovery';
import { loadOrCreateTls, TlsMaterial } from '../services/tlsCert';
import { setOwnFingerprint, installCertificateErrorHandler, pinHostFingerprint } from './tlsTrust';
import { TrustStore } from '../services/trustStore';
import { ShareStore } from '../services/shareStore';
import { initAppSettings, getAppSettings, updateAppSettings } from '../services/appSettings';
import { IntroStore } from '../services/introStore';

// Global error handlers to capture silent Electron startup crashes
process.on('uncaughtException', (err) => {
  try {
    const logDir = app.isReady() ? app.getPath('userData') : os.homedir();
    fs.writeFileSync(path.join(logDir, 'weshare-crash.log'), `Uncaught Exception:\n${err.stack || err.message}`);
  } catch (e) {}
  app.quit();
});

process.on('unhandledRejection', (reason: any) => {
  try {
    const logDir = app.isReady() ? app.getPath('userData') : os.homedir();
    const msg = reason instanceof Error ? reason.stack : String(reason);
    fs.appendFileSync(path.join(logDir, 'weshare-warnings.log'), `Unhandled Rejection at: ${new Date().toISOString()}:\n${msg}\n\n`);
  } catch (e) {}
});

let mainWindow: BrowserWindow | null = null;
let serverPort: number = 5003;
let discoveryHandle: DiscoveryHandle | null = null;
let tlsMaterial: TlsMaterial | null = null;

const isDev = !app.isPackaged;

// The certificate is only used when the user has turned on "Encrypt connections".
function serverTlsOptions(): { key: string; cert: string } | null {
  return getAppSettings().encryptConnections && tlsMaterial ? { key: tlsMaterial.key, cert: tlsMaterial.cert } : null;
}

// Restarts the server in the other mode after the setting changes. Connected devices are
// dropped; phones have to scan the QR code again because the address scheme changed.
async function restartServerForSettings() {
  await stopServer();
  serverPort = await startServer(serverTlsOptions(), serverPort);
  console.log(`Server restarted on port ${serverPort} (${isServerSecure() ? 'HTTPS' : 'HTTP'})`);
  // The window reconnects to its own server with the new scheme.
  mainWindow?.webContents.reload();
}

// Disable hardware acceleration to prevent Access Violation crashes (0xC0000005) on some Windows machines
app.disableHardwareAcceleration();

async function createWindow() {
  // Clean up any stale temp zips from previous sessions/crashes on startup
  try {
    const tempDir = path.join(app.getPath('temp'), 'Weshare');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (startupCleanErr) {
    console.error('Failed to clean temp zips on startup:', startupCleanErr);
  }

  // Start the offline Express + WebSocket server: plain HTTP/WS by default, or HTTPS/WSS with
  // this install's certificate when "Encrypt connections" is on in Settings.
  try {
    TrustStore.getInstance().init(path.join(app.getPath('userData'), 'trusted-devices.json'));
    ShareStore.getInstance().init(path.join(app.getPath('userData'), 'shared-folders.json'));
    IntroStore.getInstance().init(path.join(app.getPath('userData'), 'intro-seen.json'));
    initAppSettings(path.join(app.getPath('userData'), 'settings.json'));
    // Weekly access (trial / paid) is known before other devices can connect.
    await initAccount(() => mainWindow);
    tlsMaterial = loadOrCreateTls(path.join(app.getPath('userData'), 'tls'));
    setOwnFingerprint(tlsMaterial.fingerprint256);
    installCertificateErrorHandler(app);

    serverPort = await startServer(serverTlsOptions(), 5003);
    console.log(`Server started successfully on port ${serverPort}`);

    // Start UDP Broadcast Auto-Discovery Sockets (LAN laptop-to-laptop discovery)
    try {
      const fingerprint = tlsMaterial.fingerprint256;
      discoveryHandle = startUDPDiscovery({
        getServerPort: () => serverPort,
        getFingerprint: () => (isServerSecure() ? fingerprint : ''),
        getMainWindow: () => mainWindow
      });
    } catch (udpErr) {
      console.error('Failed to start UDP auto-discovery:', udpErr);
    }

    // Initialize Telemetry Queue on startup to sync any pending offline items
    try {
      const { TelemetryQueue } = require('../services/telemetryQueue');
      TelemetryQueue.getInstance().processQueue();
    } catch (telemetryErr) {
      console.error('Failed to initialize telemetry queue on startup:', telemetryErr);
    }
  } catch (error) {
    console.error('Failed to start server:', error);
  }

  const iconPath = path.join(__dirname, 'logo.png');
  const devIconPath = path.join(__dirname, '../../src/main/logo.png');
  const appIcon = fs.existsSync(iconPath) ? iconPath : (fs.existsSync(devIconPath) ? devIconPath : undefined);

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#121316',
      symbolColor: '#a3a29d',
      height: 35
    },
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#121316',
    show: false
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const builtPage = path.join(__dirname, '../../renderer/index.html');
  let useBuiltPage = !isDev;
  let pageLoaded = false;
  const loadPage = () => {
    if (!mainWindow) return;
    const load = useBuiltPage ? mainWindow.loadFile(builtPage) : mainWindow.loadURL('http://127.0.0.1:5773');
    load.catch(() => {}); // failures are handled by did-fail-load below
  };

  // Development: if the Vite page server hasn't delivered the page after a few seconds
  // (Electron's network service can hang here), fall back to the last built page.
  if (isDev) {
    setTimeout(() => {
      if (!pageLoaded && mainWindow && !mainWindow.isDestroyed() && fs.existsSync(builtPage)) {
        console.warn('[Window] Vite page did not load; using the built page instead');
        useBuiltPage = true;
        loadPage();
      }
    }, 8000);
  }

  // Electron's network service sometimes restarts while the page is loading; the load then
  // fails, the page never draws and the hidden window never appears. Try again, a few times.
  let loadRetries = 0;
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* ERR_ABORTED: replaced by another load */) return;
    console.error(`[Window] Page failed to load (${errorCode} ${errorDescription})`);
    if (loadRetries++ < 5) setTimeout(loadPage, 1000);
    else mainWindow?.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    pageLoaded = true;
    console.log('[Window] Page loaded');
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[Window] Page process stopped (${details.reason}); reloading`);
    setTimeout(loadPage, 1000);
  });
  app.on('child-process-gone', (_e, details) => {
    console.error(`[App] ${details.type} process stopped (${details.reason}, ${details.exitCode})`);
  });

  // Never leave the user with no window: show it after a few seconds even if nothing drew yet.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  }, 6000);

  loadPage();
  if (isDev && process.env.WESHARE_DEVTOOLS !== '0') mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Handle Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', createWindow);
}

app.on('window-all-closed', () => {
  stopServer();
  discoveryHandle?.stop();
  discoveryHandle = null;

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Clean up entire temp directory on exit
  try {
    const tempDir = path.join(app.getPath('temp'), 'Weshare');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (cleanErr) {
    console.error('Failed to clean temp zips on exit:', cleanErr);
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

registerFileSelectionHandlers(() => mainWindow);
registerNativeTransferHandlers(() => mainWindow);
registerUpdaterHandlers(() => mainWindow);

// IPC Handler: Get local network info for QR generation
ipcMain.handle('get-server-info', () => {
  const dm = DeviceManager.getInstance();
  return {
    ips: dm.getLocalIPs(),
    port: serverPort,
    token: dm.getSessionToken(),
    deviceName: dm.getDeviceName(),
    secure: isServerSecure(),
    fingerprint: isServerSecure() ? tlsMaterial?.fingerprint256 || '' : ''
  };
});

// IPC Handler: Regenerate secure session token
ipcMain.handle('regenerate-token', () => {
  const dm = DeviceManager.getInstance();
  const newToken = dm.regenerateToken();
  broadcastState();
  return {
    token: newToken,
    ips: dm.getLocalIPs(),
    port: serverPort
  };
});

// IPC Handler: pin a remembered host's certificate before connecting to it,
// so a saved trust survives app restarts and isn't replaced by first-use trust.
ipcMain.handle('pin-host-fingerprint', (event, host: string, fingerprint: string) => {
  return pinHostFingerprint(String(host || ''), String(fingerprint || ''));
});

// The Admin Console only shows on the owner's computer: the one that has a file named
// "admin-device" in Weshare's data folder. Other installs never have it.
ipcMain.handle('is-admin-device', () => fs.existsSync(path.join(app.getPath('userData'), 'admin-device')));

// IPC Handlers: host preferences the server uses (e.g. unpack received zips)
ipcMain.handle('settings-get', () => getAppSettings());
ipcMain.handle('settings-update', async (event, patch) => {
  const before = getAppSettings().encryptConnections;
  const updated = updateAppSettings(patch && typeof patch === 'object' ? patch : {});
  if (updated.encryptConnections !== before) {
    try {
      await restartServerForSettings();
    } catch (err) {
      console.error('[Settings] Could not restart the server:', err);
    }
  }
  return updated;
});

// "Done": disconnect every phone/computer. The window then changes the PIN (regenerate-token)
// so the old QR link stops working.
ipcMain.handle('end-guest-sessions', () => {
  return { disconnected: endGuestSessions() };
});

// IPC Handlers: folders this computer shares with its remembered devices
ipcMain.handle('shares-list', () => ShareStore.getInstance().list());
ipcMain.handle('shares-add', async () => {
  const win = mainWindow;
  const result = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a folder to share' })
    : await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose a folder to share' });
  if (result.canceled || result.filePaths.length === 0) return ShareStore.getInstance().list();
  ShareStore.getInstance().add(result.filePaths[0]);
  return ShareStore.getInstance().list();
});
ipcMain.handle('shares-remove', (event, id: string) => {
  ShareStore.getInstance().remove(String(id || ''));
  return ShareStore.getInstance().list();
});


