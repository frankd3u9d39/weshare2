import express from 'express';
import http from 'http';
import https from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cors from 'cors';
import multer from 'multer';
import { DeviceManager } from '../services/deviceManager';
import { TransferEngine, TransferInfo } from '../services/transferEngine';
import { isSafeId, sanitizeFileName, sanitizeRelativePath, safeJoin, contentDisposition } from '../services/pathSafety';
import { TrustStore } from '../services/trustStore';
import { extractZipToUniqueDir, unpackReceivedZip } from '../services/zipExtract';
import { getAppSettings } from '../services/appSettings';
import { createProgressThrottle } from '../services/progressThrottle';
import { ShareStore, ShareError } from '../services/shareStore';
import { IntroStore } from '../services/introStore';
import { isAccessActive, onAccessChange, ACCESS_ENDED_MESSAGE } from '../services/accessGate';
import yazl from 'yazl';

let serverInstance: http.Server | https.Server | null = null;
let wssInstance: WebSocketServer | null = null;
// trustedDeviceId is set when the connection logged in with a trusted device's own key
// (instead of the PIN); such a connection may only identify as that device.
const activeSockets = new Map<string, { socket: WebSocket; deviceInfo?: any; remoteIp: string; trustedDeviceId?: string }>();

// SHA-256 fingerprint of this server's certificate, handed to devices when they're trusted
// so remembered desktops can pin it across restarts and IP changes.
let serverFingerprint = '';

// The desktop app's own window connects to its server with this id.
const HOST_ID = 'desktop-main';

// Who a transfer is between. Offers, accepts and progress are only delivered to,
// and only accepted from, these two devices; HTTP transfers need `accepted`.
interface TransferRoute {
  senderId: string;
  targetId: string;
  fileId: string;
  accepted: boolean;
  batchId?: string;
  // Folder path inside a sent folder, e.g. ["Photos", "2024"] for "Photos/2024/a.jpg".
  relDirs?: string[];
}
const transferRoutes = new Map<string, TransferRoute>();

// Where each incoming folder batch is being written, so all its files share one root
// (e.g. "Photos" or "Photos (2)" if a folder with that name already exists).
const batchRoots = new Map<string, string>();

function uniqueDir(parent: string, name: string): string {
  let candidate = safeJoin(parent, name);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = safeJoin(parent, `${name} (${n})`);
  return candidate;
}

/** Folder an upload for this transfer should be saved into, creating it if needed. */
function destinationDirFor(route: TransferRoute | undefined): string {
  const downloads = TransferEngine.getInstance().getDownloadsFolder();
  if (!route?.relDirs?.length) return downloads;
  // One root per top folder in the batch (two folders dropped together stay apart).
  const key = `${route.batchId || route.fileId}/${route.relDirs[0]}`;
  let root = batchRoots.get(key);
  if (!root) {
    root = uniqueDir(downloads, route.relDirs[0]);
    batchRoots.set(key, root);
  }
  const dir = route.relDirs.length > 1 ? safeJoin(root, ...route.relDirs.slice(1)) : root;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isLoopback(ip: string): boolean {
  const n = normalizeIp(ip);
  return n === '127.0.0.1' || n === '::1';
}

function findSocketIdByDevice(deviceId: string): string | undefined {
  for (const [id, entry] of activeSockets.entries()) {
    if (entry.deviceInfo?.id === deviceId) return id;
  }
  return undefined;
}

function sendToDevice(deviceId: string, messageObj: any) {
  const socketId = findSocketIdByDevice(deviceId);
  const entry = socketId ? activeSockets.get(socketId) : undefined;
  if (entry && entry.socket.readyState === WebSocket.OPEN) {
    entry.socket.send(JSON.stringify(messageObj));
  }
}

function isParticipant(route: TransferRoute | undefined, deviceId: string | undefined): route is TransferRoute {
  return !!route && !!deviceId && (route.senderId === deviceId || route.targetId === deviceId);
}
const activeDownloads = new Map<string, { readStream: fs.ReadStream; res: express.Response; resetReportTime?: () => void }>();
const mergingTransfers = new Set<string>();
// Progress timers for downloads, kept per transfer across the requests that make it up.
const downloadThrottles = new Map<string, ReturnType<typeof createProgressThrottle>>();

// Multer storage configuration for saving uploads in the downloads directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TransferEngine.getInstance().getDownloadsFolder());
  },
  filename: (req, file, cb) => {
    // Sanitize filename to prevent path traversal and names Windows can't store
    let originalName: string;
    try {
      originalName = sanitizeFileName(file.originalname);
    } catch (e) {
      originalName = `file-${Date.now()}`;
    }
    const destFolder = TransferEngine.getInstance().getDownloadsFolder();
    const ext = path.extname(originalName);
    const name = path.basename(originalName, ext);
    let targetPath = path.join(destFolder, originalName);

    if (fs.existsSync(targetPath)) {
      const timestamp = Date.now();
      cb(null, `${name}-${timestamp}${ext}`);
    } else {
      cb(null, originalName);
    }
  }
});

const upload = multer({ storage });

/** True while the server is serving HTTPS/WSS (the "Encrypt connections" setting). */
export function isServerSecure(): boolean {
  return serverInstance instanceof https.Server;
}

// With tlsOptions the server speaks HTTPS/WSS, so the PIN and file contents are encrypted on
// the LAN. Without them it speaks plain HTTP/WS (the default), which browsers accept without
// a certificate warning.
export function startServer(tlsOptions: { key: string; cert: string } | null, preferredPort = 5003): Promise<number> {
  return new Promise((resolve, reject) => {
    const app = express();
    const deviceManager = DeviceManager.getInstance();
    const transferEngine = TransferEngine.getInstance();

    const isAllowedOrigin = (origin: string): boolean => {
      try {
        const url = new URL(origin);
        const hostname = url.hostname;
        if (
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '::1' ||
          hostname.endsWith('.local')
        ) {
          return true;
        }
        const localIps = deviceManager.getLocalIPs();
        return localIps.includes(hostname);
      } catch (e) {
        return false;
      }
    };

    app.use(cors({
      origin: (origin, callback) => {
        if (!origin || origin === 'null' || isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Blocked by CORS policy'));
        }
      },
      credentials: true
    }));
    app.use(express.json());

    // Serve static files of the React build
    const staticPath = path.join(__dirname, '../../renderer');
    app.use(express.static(staticPath));

    // Fallback for HTML5 routing on mobile clients
    app.get('/', (req, res, next) => {
      // If client requests root, serve our index.html
      const indexPath = path.join(staticPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).send('Weshare local server is running. Web UI bundle not found yet. Please build the frontend.');
      }
    });

    // Weekly access: while this computer's trial or paid week has ended, phones and other
    // computers get a clear "renew" answer instead of being let in. The computer itself is
    // never blocked.
    app.get('/api/access-status', (req, res) => {
      res.json({ active: isAccessActive(), message: isAccessActive() ? '' : ACCESS_ENDED_MESSAGE });
    });
    app.use('/api', (req, res, next) => {
      if (isAccessActive() || isLoopback(req.socket.remoteAddress || '') || req.path === '/intro-seen') return next();
      res.status(402).json({ error: ACCESS_ENDED_MESSAGE, code: 'access-ended' });
    });

    // Whether this visitor has already been through the intro. Keyed by the caller's own
    // network address, so a visitor can only read or set its own entry.
    const visitorAddress = (req: express.Request) => normalizeIp(req.socket.remoteAddress || '');
    app.get('/api/intro-seen', (req, res) => {
      res.json({ seen: IntroStore.getInstance().hasSeen(visitorAddress(req)) });
    });
    app.post('/api/intro-seen', (req, res) => {
      IntroStore.getInstance().markSeen(visitorAddress(req));
      res.json({ seen: true });
    });

    // Middleware to validate session tokens
    const validateTokenMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = req.query.token as string || req.headers['x-session-token'] as string;
      if (!deviceManager.validateToken(token, req.ip)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid session token' });
      }
      next();
    };

    // API: lets a remembered device check its saved key still works before connecting
    // (a browser can't see why a WebSocket was refused).
    app.get('/api/auth-check', validateTokenMiddleware, (req, res) => {
      res.json({ ok: true });
    });

    // ---- Shared folders: browsing is for remembered devices (using their own key) only ----
    const requireTrustedDevice = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = (req.query.token as string) || (req.headers['x-session-token'] as string) || '';
      const auth = deviceManager.authenticate(token, req.ip || '');
      if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
      if (!auth.trustedDeviceId && !isLoopback(req.ip || '')) {
        return res.status(403).json({ error: 'Only remembered devices can browse shared folders' });
      }
      next();
    };
    const shareError = (res: express.Response, err: any) => {
      const status = err instanceof ShareError ? err.status : 500;
      if (status === 500) console.error('[Shares]', err);
      res.status(status).json({ error: err instanceof ShareError ? err.message : 'Could not read shared folder' });
    };

    app.get('/api/shares', requireTrustedDevice, (req, res) => {
      res.json({ shares: ShareStore.getInstance().list().map((s) => ({ id: s.id, name: s.name })) });
    });

    app.get('/api/shares/:id/list', requireTrustedDevice, (req, res) => {
      try {
        res.json({ entries: ShareStore.getInstance().listDir(req.params.id, String(req.query.path || '')) });
      } catch (err) {
        shareError(res, err);
      }
    });

    app.get('/api/shares/:id/file', requireTrustedDevice, (req, res) => {
      try {
        const { fullPath } = ShareStore.getInstance().resolve(req.params.id, String(req.query.path || ''));
        if (!fs.statSync(fullPath).isFile()) return res.status(400).json({ error: 'Not a file' });
        req.socket.setTimeout(0);
        // sendFile streams and supports resuming (Range requests).
        res.sendFile(fullPath, {
          dotfiles: 'allow',
          headers: { 'Content-Disposition': contentDisposition(path.basename(fullPath)), 'Content-Type': 'application/octet-stream' }
        }, (err) => {
          if (err && !res.headersSent) shareError(res, err);
        });
      } catch (err) {
        shareError(res, err);
      }
    });

    // A whole folder from a share, zipped while it streams.
    app.get('/api/shares/:id/zip', requireTrustedDevice, (req, res) => {
      try {
        const { share, fullPath, segments } = ShareStore.getInstance().resolve(req.params.id, String(req.query.path || ''));
        if (!fs.statSync(fullPath).isDirectory()) return res.status(400).json({ error: 'Not a folder' });
        req.socket.setTimeout(0);
        const folderName = segments.length ? segments[segments.length - 1] : share.name;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', contentDisposition(`${folderName}.zip`));
        const zip = new yazl.ZipFile();
        const addDir = (dir: string, prefix: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          if (entries.length === 0 && prefix) zip.addEmptyDirectory(prefix);
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) addDir(full, name);
            else if (entry.isFile()) zip.addFile(full, name, { compress: false });
          }
        };
        zip.outputStream.pipe(res);
        res.on('close', () => zip.outputStream.unpipe(res));
        addDir(fullPath, folderName);
        zip.end();
      } catch (err) {
        shareError(res, err);
      }
    });

    // API: Download a file
    app.get('/api/download/:fileId', validateTokenMiddleware, async (req, res) => {
      req.socket.setTimeout(0);
      const { fileId } = req.params;

      // Only the device the host offered this file to may download it, and only after accepting.
      // The accept arrives over the WebSocket, so give it a moment to land before this request.
      const route = transferRoutes.get(req.query.transferId as string);
      for (let i = 0; i < 20 && route && !route.accepted; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
      console.log(`[Download] Request for transfer ${req.query.transferId} from ${req.ip}`);
      if (!route || !route.accepted || route.senderId !== HOST_ID || route.fileId !== fileId) {
        console.warn(`[Download] Refused: ${!route ? 'unknown transfer' : !route.accepted ? 'not accepted' : 'file does not match'}`);
        return res.status(403).json({ error: 'Transfer not accepted' });
      }

      const filePath = transferEngine.getOfferedFilePath(fileId);

      if (!filePath || !fs.existsSync(filePath)) {
        console.warn(`[Download] File for transfer ${req.query.transferId} is missing on disk`);
        return res.status(404).json({ error: 'File not found or transfer expired' });
      }

      const stat = fs.statSync(filePath);
      const fileName = path.basename(filePath);

      // Phones' download managers pause when the connection drops (screen lock, Wi-Fi blip,
      // hand-over from the page) and then ask to continue from a byte offset. Answering those
      // "Range" requests, with a validator (ETag/Last-Modified), is what lets them resume.
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(fileName));

      let rangeStart = 0;
      let rangeEnd = stat.size - 1;
      const rangeHeader = req.headers.range;
      const rangeMatch = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
      // An empty file has no byte ranges; just send it (empty) in full.
      if (rangeMatch && stat.size > 0 && (rangeMatch[1] || rangeMatch[2])) {
        if (rangeMatch[1]) {
          rangeStart = parseInt(rangeMatch[1], 10);
          if (rangeMatch[2]) rangeEnd = Math.min(parseInt(rangeMatch[2], 10), stat.size - 1);
        } else {
          // "bytes=-N": the last N bytes
          rangeStart = Math.max(0, stat.size - parseInt(rangeMatch[2], 10));
        }
        if (rangeStart >= stat.size || rangeStart > rangeEnd) {
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${stat.size}`);
      }
      const length = stat.size === 0 ? 0 : rangeEnd - rangeStart + 1;
      res.setHeader('Content-Length', length);
      if (rangeStart > 0) console.log(`[Download] Resuming transfer ${req.query.transferId} from byte ${rangeStart}`);

      if (req.method === 'HEAD') return res.end();

      const transferId = req.query.transferId as string || fileId;
      const fileStream = stat.size === 0
        ? fs.createReadStream(filePath)
        : fs.createReadStream(filePath, { start: rangeStart, end: rangeEnd, highWaterMark: 256 * 1024 });
      let bytesSent = 0;
      // One progress timer per transfer, shared by all its requests: a phone fetching the file
      // in pieces makes a new request every few seconds, and a fresh timer per request would
      // never reach its first report.
      let throttle = downloadThrottles.get(transferId);
      if (!throttle) {
        throttle = createProgressThrottle(1, (bytesTransferred, speed) => {
          transferEngine.updateProgress(transferId, bytesTransferred, speed);
          broadcastProgressDelta(transferId, bytesTransferred, speed);
        });
        throttle.reset(rangeStart);
        downloadThrottles.set(transferId, throttle);
      }
      const reportPosition = (speed?: number) => {
        const position = rangeStart + bytesSent;
        const tx = transferEngine.getTransfer(transferId);
        const currentSpeed = speed ?? tx?.speed ?? 0;
        transferEngine.updateProgress(transferId, position, currentSpeed);
        broadcastProgressDelta(transferId, position, currentSpeed);
      };

      const downloadEntry = {
        readStream: fileStream,
        res,
        resetReportTime: () => throttle!.reset(rangeStart + bytesSent)
      };
      activeDownloads.set(transferId, downloadEntry);

      // Register transfer progress on download
      const transfer: TransferInfo = transferEngine.getTransfer(transferId) || {
        id: transferId,
        name: fileName,
        size: stat.size,
        type: 'send',
        status: 'transferring',
        progress: 0,
        speed: 0,
        bytesTransferred: 0,
        startedAt: new Date()
      };
      
      // A resumed or repeated request keeps the original start time.
      if (transfer.status !== 'transferring' && transfer.status !== 'paused') transfer.startedAt = new Date();
      transfer.status = 'transferring';

      if (transfer.type === 'send') {
        const deviceName = req.query.deviceName as string;
        const deviceOS = req.query.deviceOS as string;
        if (deviceName) transfer.device = deviceName;
        if (deviceOS) transfer.deviceOS = deviceOS;

        // Fallback user agent check if query parameters aren't passed
        if (!transfer.deviceOS) {
          const userAgent = req.headers['user-agent'] || '';
          if (userAgent.toLowerCase().includes('iphone') || userAgent.toLowerCase().includes('ipad')) {
            transfer.deviceOS = 'iOS';
          } else if (userAgent.toLowerCase().includes('android')) {
            transfer.deviceOS = 'Android';
          } else if (userAgent.toLowerCase().includes('macintosh')) {
            transfer.deviceOS = 'macOS';
          } else if (userAgent.toLowerCase().includes('windows')) {
            transfer.deviceOS = 'Windows';
          } else {
            transfer.deviceOS = 'Unknown Mobile';
          }
        }
        
        if (!transfer.device) {
          transfer.device = `Browser (${transfer.deviceOS})`;
        }
      }

      transferEngine.registerTransfer(transfer);
      broadcastState();

      fileStream.on('data', (chunk) => {
        bytesSent += chunk.length;
        throttle!.report(rangeStart + bytesSent);
      });

      // Done only when the phone has received the file's last byte.
      res.on('finish', () => {
        if (activeDownloads.get(transferId) === downloadEntry) activeDownloads.delete(transferId);
        if (rangeEnd >= stat.size - 1 && rangeStart + bytesSent >= stat.size) {
          console.log(`[Download] Transfer ${transferId} finished`);
          downloadThrottles.delete(transferId);
          transferEngine.updateProgress(transferId, stat.size, 0);
          broadcastProgressDelta(transferId, stat.size, 0);
          transferEngine.completeTransfer(transferId);
          broadcastState();
        } else {
          // End of one piece: show where we are right away.
          reportPosition();
        }
      });

      fileStream.on('error', (err) => {
        if (activeDownloads.get(transferId) === downloadEntry) activeDownloads.delete(transferId);
        console.error('Download stream error:', err);
        transferEngine.failTransfer(transferId, err.message);
        broadcastState();
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        } else {
          res.destroy();
        }
      });

      // The phone dropped the connection before the end. That's not a failure: its download
      // manager will usually come back and resume, so just show it as stalled for now.
      res.on('close', () => {
        fileStream.destroy();
        if (res.writableFinished) return;
        if (activeDownloads.get(transferId) === downloadEntry) activeDownloads.delete(transferId);
        console.log(`[Download] Connection for ${transferId} dropped at byte ${rangeStart + bytesSent}; waiting for the phone to resume`);
        reportPosition(0);
      });

      fileStream.pipe(res);
    });

    // API: Upload files (Multer handles writing directly to Downloads/Weshare)
    app.post('/api/upload', validateTokenMiddleware, (req, res) => {
      req.socket.setTimeout(0);
      const transferId = req.query.transferId as string;

      // Uploads must belong to an offer the host has accepted.
      const route = transferRoutes.get(transferId);
      if (!route || !route.accepted || route.targetId !== HOST_ID) {
        return res.status(403).json({ error: 'Transfer not accepted' });
      }

      const singleUpload = upload.single('file');
      
      singleUpload(req, res, async (err) => {
        if (err) {
          console.error('Multer error:', err);
          transferEngine.failTransfer(transferId, err.message);
          broadcastState();
          return res.status(500).json({ error: err.message });
        }

        const file = req.file;
        if (!file) {
          transferEngine.failTransfer(transferId, 'No file received');
          broadcastState();
          return res.status(400).json({ error: 'No file received' });
        }

        let finalPath = file.path;
        const isFolder = req.query.isFolder === 'true';

        if (isFolder) {
          try {
            const destFolder = transferEngine.getDownloadsFolder();
            finalPath = await extractZipToUniqueDir(file.path, destFolder, file.originalname);
            console.log(`[Server API] Extracted folder successfully to: ${finalPath}`);
          } catch (err: any) {
            console.error('[Server API] Folder extraction failed:', err);
          }
        } else if (getAppSettings().unpackZips && /\.zip$/i.test(file.originalname)) {
          const folder = await unpackReceivedZip(file.path, transferEngine.getDownloadsFolder(), file.originalname);
          if (folder) {
            finalPath = folder;
            console.log(`[Unzip] Unpacked ${file.originalname} to ${folder}`);
          }
        }

        // Complete the transfer info
        const currentTx = transferEngine.getTransfer(transferId);
        if (currentTx) {
          currentTx.filePath = finalPath;
          if (isFolder) {
            currentTx.isFolder = true;
            if (currentTx.name.endsWith('.zip')) {
              currentTx.name = currentTx.name.slice(0, -4);
            }
          }
          transferEngine.completeTransfer(transferId);
          
          const fileKey = currentTx.fileId || transferId;
          transferEngine.registerUploadedFile(fileKey, finalPath);
        } else {
          // Fallback registration
          transferEngine.registerTransfer({
            id: transferId,
            name: isFolder && file.originalname.endsWith('.zip') ? file.originalname.slice(0, -4) : file.originalname,
            size: file.size,
            type: 'receive',
            status: 'completed',
            progress: 100,
            speed: 0,
            filePath: finalPath,
            bytesTransferred: file.size,
            isFolder: isFolder,
            startedAt: new Date(),
            completedAt: new Date()
          });

          transferEngine.registerUploadedFile(transferId, finalPath);
        }
        broadcastState();
        res.status(200).json({ success: true, filename: file.filename });
      });
    });

    app.post('/api/upload-chunk', validateTokenMiddleware, async (req, res) => {
      const transferId = req.query.transferId as string;
      const chunkIndex = parseInt(req.query.chunkIndex as string, 10);
      const totalChunks = parseInt(req.query.totalChunks as string, 10);
      const fileName = req.query.fileName as string;
      const fileSize = parseInt(req.query.fileSize as string, 10);

      if (!transferId || isNaN(chunkIndex) || isNaN(totalChunks) || !fileName) {
        return res.status(400).json({ error: 'Missing chunk upload parameters' });
      }

      if (!isSafeId(transferId) || chunkIndex < 0 || chunkIndex >= totalChunks) {
        return res.status(400).json({ error: 'Invalid chunk upload parameters' });
      }

      const route = transferRoutes.get(transferId);
      if (!route || !route.accepted || route.targetId !== HOST_ID) {
        return res.status(403).json({ error: 'Transfer not accepted' });
      }

      // If the transfer is paused, hold the request until it is resumed
      const tx = transferEngine.getTransfer(transferId);
      if (tx && tx.status === 'paused') {
        console.log(`[Chunk Upload] Transfer "${transferId}" is paused. Holding chunk ${chunkIndex} upload...`);
        while (tx && tx.status === 'paused') {
          await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[Chunk Upload] Transfer "${transferId}" resumed. Resuming chunk ${chunkIndex} upload...`);
      }

      const tempChunksFolder = path.join(transferEngine.getDownloadsFolder(), '.chunks');
      if (!fs.existsSync(tempChunksFolder)) {
        try {
          fs.mkdirSync(tempChunksFolder, { recursive: true });
        } catch (err) {
          console.error('[Chunk Upload] Failed to create temp folder:', err);
          return res.status(500).json({ error: 'Failed to create temporary folder' });
        }
      }

      const chunkFileName = `${transferId}_chunk_${chunkIndex}`;
      const chunkPath = path.join(tempChunksFolder, chunkFileName);
      const writeStream = fs.createWriteStream(chunkPath);

      req.pipe(writeStream);

      writeStream.on('error', (err) => {
        console.error(`[Chunk Upload] Chunk ${chunkIndex} write error:`, err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to write chunk file' });
        }
      });

      writeStream.on('finish', async () => {
        try {
          // Check what chunks have been successfully uploaded so far
          const completedChunks = [];
          for (let i = 0; i < totalChunks; i++) {
            const checkPath = path.join(tempChunksFolder, `${transferId}_chunk_${i}`);
            if (fs.existsSync(checkPath)) {
              completedChunks.push(checkPath);
            }
          }

          if (completedChunks.length === totalChunks) {
            // All chunks received. Respond first to prevent HTTP timeouts during merge.
            res.status(200).json({ success: true, status: 'merging' });

            // Guard against concurrent merge triggers from retried final chunks
            if (!mergingTransfers.has(transferId)) {
              mergingTransfers.add(transferId);
              mergeChunks(transferId, fileName, fileSize, totalChunks).finally(() => {
                mergingTransfers.delete(transferId);
              });
            }
          } else {
            res.status(200).json({ success: true, status: 'uploaded', chunkIndex });
          }
        } catch (err: any) {
          console.error('[Chunk Upload] Error checking chunks:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Internal check error' });
          }
        }
      });
    });

    // Helper function to sequentially merge chunks on disk
    async function mergeChunks(transferId: string, fileName: string, fileSize: number, totalChunks: number) {
      const tempChunksFolder = path.join(transferEngine.getDownloadsFolder(), '.chunks');
      let sanitizedName: string;
      try {
        sanitizedName = sanitizeFileName(fileName);
      } catch (e) {
        sanitizedName = `file-${Date.now()}`;
      }
      // Files from a sent folder go into that folder's structure instead of Downloads itself.
      const destFolder = destinationDirFor(transferRoutes.get(transferId));

      const ext = path.extname(sanitizedName);
      const name = path.basename(sanitizedName, ext);
      let targetPath = safeJoin(destFolder, sanitizedName);
      for (let n = 1; fs.existsSync(targetPath); n++) {
        targetPath = safeJoin(destFolder, `${name} (${n})${ext}`);
      }

      const finalWriteStream = fs.createWriteStream(targetPath);
      // Resolves once every byte is on disk, so "completed" really means complete.
      const fullyWritten = new Promise<void>((resolve, reject) => {
        finalWriteStream.on('finish', () => resolve());
        finalWriteStream.on('error', reject);
      });

      try {
        for (let i = 0; i < totalChunks; i++) {
          const chunkPath = path.join(tempChunksFolder, `${transferId}_chunk_${i}`);
          
          await new Promise<void>((resolve, reject) => {
            const chunkReadStream = fs.createReadStream(chunkPath);
            chunkReadStream.pipe(finalWriteStream, { end: false });
            chunkReadStream.on('end', () => {
              try {
                fs.unlinkSync(chunkPath);
              } catch (e) {}
              resolve();
            });
            chunkReadStream.on('error', (err) => reject(err));
          });
        }

        finalWriteStream.end();
        await fullyWritten;

        // Phones often can't pick folders, so people zip them; turn the zip back into a folder.
        let finalPath = targetPath;
        let unpacked = false;
        if (getAppSettings().unpackZips && /\.zip$/i.test(sanitizedName)) {
          const folder = await unpackReceivedZip(targetPath, destFolder, sanitizedName);
          if (folder) {
            finalPath = folder;
            unpacked = true;
            console.log(`[Unzip] Unpacked ${sanitizedName} to ${folder}`);
          }
        }

        const tx = transferEngine.getTransfer(transferId);
        if (tx) {
          tx.filePath = finalPath;
          if (unpacked) {
            tx.isFolder = true;
            tx.name = tx.name.replace(/\.zip$/i, '');
          }
          transferEngine.completeTransfer(transferId);
        } else {
          // Fallback final registration
          transferEngine.registerTransfer({
            id: transferId,
            name: sanitizedName,
            size: fileSize,
            type: 'receive',
            status: 'completed',
            progress: 100,
            speed: 0,
            filePath: finalPath,
            bytesTransferred: fileSize,
            isFolder: unpacked,
            startedAt: new Date(),
            completedAt: new Date()
          });
        }

        transferEngine.registerUploadedFile(transferId, finalPath);
        broadcastState();
        console.log(`[Chunk Merge] Success. Reassembled file: ${finalPath}`);
      } catch (err: any) {
        console.error('[Chunk Merge] Merge pipeline failed:', err);
        finalWriteStream.end();
        transferEngine.failTransfer(transferId, `Reassembly merge failed: ${err.message || err}`);
        broadcastState();

        // Clean up remaining chunks
        for (let i = 0; i < totalChunks; i++) {
          const chunkPath = path.join(tempChunksFolder, `${transferId}_chunk_${i}`);
          if (fs.existsSync(chunkPath)) {
            try { fs.unlinkSync(chunkPath); } catch (e) {}
          }
        }
      }
    }

    // Start server logic finding an open port
    let currentPort = preferredPort;
    const start = () => {
      if (tlsOptions) {
        serverInstance = https.createServer({ key: tlsOptions.key, cert: tlsOptions.cert }, app);
        serverFingerprint = new crypto.X509Certificate(tlsOptions.cert).fingerprint256;
      } else {
        serverInstance = http.createServer(app);
        serverFingerprint = '';
      }
      
      // Initialize WebSocket Server
      wssInstance = new WebSocketServer({ noServer: true });

      serverInstance.on('upgrade', (request, socket, head) => {
        try {
          const urlObj = new URL(request.url || '', 'http://localhost');
          const token = urlObj.searchParams.get('token');
          const remoteIp = request.socket.remoteAddress || '';

          console.log(`[WS Upgrade] Request from IP: ${remoteIp}`);

          if (!isAccessActive() && !isLoopback(remoteIp)) {
            console.log('[WS Upgrade] Rejecting connection: weekly access has ended');
            socket.write('HTTP/1.1 402 Payment Required\r\n\r\n');
            socket.destroy();
            return;
          }

          const auth = deviceManager.authenticate(token || '', remoteIp);
          const isAuthorized = auth.ok;
          console.log(`[WS Upgrade] isAuthorized: ${isAuthorized}${auth.trustedDeviceId ? ' (trusted device)' : ''}`);
          (request as any).weshareTrustedDeviceId = auth.trustedDeviceId;

          if (!isAuthorized) {
            console.log(`[WS Upgrade] Rejecting connection: Unauthorized`);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }

          wssInstance?.handleUpgrade(request, socket, head, (ws) => {
            console.log(`[WS Upgrade] Upgrade successful, emitting connection`);
            wssInstance?.emit('connection', ws, request);
          });
        } catch (err) {
          console.error('[WS Upgrade] Error handling upgrade:', err);
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        }
      });

      wssInstance.on('connection', (ws, request) => {
        const socketId = Math.random().toString(36).substring(2, 15);
        activeSockets.set(socketId, {
          socket: ws,
          remoteIp: normalizeIp(request.socket.remoteAddress || ''),
          trustedDeviceId: (request as any).weshareTrustedDeviceId
        });

        ws.on('message', (message: string) => {
          try {
            const data = JSON.parse(message);
            handleWSMessage(socketId, data);
          } catch (e) {
            console.error('Error parsing WS message:', e);
          }
        });

        ws.on('close', () => {
          const peer = activeSockets.get(socketId);
          if (peer?.deviceInfo) {
            deviceManager.removePeer(peer.deviceInfo.id);
          }
          activeSockets.delete(socketId);
          broadcastState();
        });

        ws.on('error', (err) => {
          console.error('WebSocket client error:', err);
        });
      });

      serverInstance.listen(currentPort, () => {
        console.log(`Weshare server running on port ${currentPort}`);
        resolve(currentPort);
      });

      serverInstance.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`Port ${currentPort} in use, trying next port...`);
          currentPort++;
          start();
        } else {
          reject(err);
        }
      });
    };

    start();
  });
}

/**
 * "Done" on the pairing screen: tells every connected phone/computer the session is over and
 * closes its connection (code 4002, so it doesn't reconnect). The host's own window stays.
 * Returns how many devices were disconnected.
 */
// When the week or trial runs out, everyone connected from another device is told and
// disconnected (code 4003); they can't come back until it's renewed.
onAccessChange((active) => {
  if (active) return;
  for (const [id, peer] of activeSockets.entries()) {
    if (isLoopback(peer.remoteIp)) continue;
    try {
      if (peer.socket.readyState === WebSocket.OPEN) {
        peer.socket.send(JSON.stringify({ type: 'access-ended', message: ACCESS_ENDED_MESSAGE }));
      }
      peer.socket.close(4003, 'Access ended');
    } catch (e) {
      try { peer.socket.terminate(); } catch (e2) {}
    }
    activeSockets.delete(id);
  }
  broadcastState();
});

export function endGuestSessions(): number {
  let count = 0;
  for (const [id, peer] of activeSockets.entries()) {
    if (isLoopback(peer.remoteIp)) continue;
    try {
      if (peer.socket.readyState === WebSocket.OPEN) {
        peer.socket.send(JSON.stringify({ type: 'session-ended' }));
      }
      peer.socket.close(4002, 'Session ended');
    } catch (e) {
      try { peer.socket.terminate(); } catch (e2) {}
    }
    activeSockets.delete(id);
    count++;
  }
  broadcastState();
  return count;
}

export function stopServer(): Promise<void> {
  for (const peer of activeSockets.values()) {
    try { peer.socket.terminate(); } catch (e) {}
  }
  activeSockets.clear();
  if (wssInstance) {
    wssInstance.close();
    wssInstance = null;
  }
  const server = serverInstance;
  serverInstance = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Drop open keep-alive and transfer connections so the port is freed straight away.
    try { (server as any).closeAllConnections?.(); } catch (e) {}
  });
}

// WS Signaling and Device Tracking handler
function handleWSMessage(socketId: string, data: any) {
  console.log(`[WS Server] Received message of type "${data?.type}" from socket "${socketId}"`);
  const deviceManager = DeviceManager.getInstance();
  const transferEngine = TransferEngine.getInstance();
  const peer = activeSockets.get(socketId);
  if (!peer || !data || typeof data.type !== 'string') return;

  if (data.type === 'ping') {
    peer.socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (data.type === 'device-info') {
    const claimedId = String(data.device?.id ?? '');
    if (!isSafeId(claimedId)) {
      peer.socket.close(1008, 'Invalid device id');
      return;
    }
    // Only the desktop app's own window (on this machine) may act as the host.
    if (claimedId === HOST_ID && !isLoopback(peer.remoteIp)) {
      console.warn(`[WS Server] Rejected remote device claiming host id from ${peer.remoteIp}`);
      peer.socket.close(1008, 'Reserved device id');
      return;
    }
    // A connection that logged in with a device key is that device and nothing else,
    // and a remembered device's id can only be used with its key (not the PIN).
    if (peer.trustedDeviceId && peer.trustedDeviceId !== claimedId) {
      peer.socket.close(1008, 'Device key does not match device id');
      return;
    }
    if (!peer.trustedDeviceId && claimedId !== HOST_ID && TrustStore.getInstance().has(claimedId)) {
      peer.socket.close(1008, 'Remembered device must use its key');
      return;
    }
    // Don't let a second connection take over another device's identity.
    const existing = findSocketIdByDevice(claimedId);
    if (existing && existing !== socketId && claimedId !== HOST_ID) {
      peer.socket.close(1008, 'Device id already connected');
      return;
    }

    peer.deviceInfo = { ...data.device, id: claimedId };
    if (peer.trustedDeviceId) {
      TrustStore.getInstance().touch(claimedId, String(data.device.name || '').slice(0, 64) || undefined);
    }
    deviceManager.registerPeer({
      id: claimedId,
      name: String(data.device.name || 'Unknown Device').slice(0, 64),
      ip: claimedId === HOST_ID ? (data.device.ip || peer.remoteIp) : peer.remoteIp,
      type: data.device.type === 'desktop' ? 'desktop' : 'phone',
      os: String(data.device.os || 'Unknown').slice(0, 32),
      connectedAt: new Date()
    });
    peer.socket.send(JSON.stringify({
      type: 'connect-ack',
      device: {
        id: HOST_ID,
        name: deviceManager.getDeviceName(),
        type: 'desktop',
        os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
      }
    }));
    broadcastState();
    return;
  }

  // Everything below requires the device to have identified itself.
  const deviceId: string | undefined = peer.deviceInfo?.id;
  if (!deviceId) return;

  switch (data.type) {
    case 'file-offer': {
      const isFromHost = deviceId === HOST_ID;
      // Clients can only send to the host; the host must name a connected device.
      const targetId = isFromHost ? String(data.targetId ?? '') : HOST_ID;
      const transferId = String(data.transferId ?? '');
      const offerError = (error: string) =>
        peer.socket.send(JSON.stringify({ type: 'file-offer-error', transferId, name: data.name, error }));

      if (!isSafeId(transferId) || transferRoutes.has(transferId)) {
        offerError('Invalid transfer id');
        break;
      }
      if (!targetId || targetId === deviceId || !findSocketIdByDevice(targetId)) {
        offerError('The selected device is not connected');
        break;
      }

      let fileId: string;
      if (isFromHost) {
        fileId = String(data.fileId ?? '');
        if (!transferEngine.getOfferedFilePath(fileId)) {
          offerError('File is no longer available');
          break;
        }
      } else {
        // A remote desktop client refers to the file by its own local id; browsers have none.
        fileId = isSafeId(data.fileId) ? data.fileId : crypto.randomBytes(16).toString('hex');
      }

      // Files from a remembered device with auto-accept on (and logged in with its key) skip the prompt.
      const trusted = !isFromHost && peer.trustedDeviceId === deviceId ? TrustStore.getInstance().get(deviceId) : undefined;
      const autoAccept = !!trusted?.autoAccept;

      // Batches group many files under one Accept; relativePath keeps a sent folder's structure.
      const batchId = isSafeId(data.batchId) ? data.batchId : undefined;
      let relDirs: string[] | undefined;
      if (!isFromHost && typeof data.relativePath === 'string' && data.relativePath.includes('/')) {
        try {
          relDirs = sanitizeRelativePath(data.relativePath).slice(0, -1);
        } catch (e) {
          relDirs = undefined;
        }
      }

      transferRoutes.set(transferId, { senderId: deviceId, targetId, fileId, accepted: autoAccept, batchId, relDirs });

      const remoteId = isFromHost ? targetId : deviceId;
      const remoteInfo = activeSockets.get(findSocketIdByDevice(remoteId) || '')?.deviceInfo;
      const senderName = String(data.senderName || peer.deviceInfo?.name || 'Unknown Device').slice(0, 64);

      transferEngine.registerTransfer({
        id: transferId,
        fileId,
        name: String(data.name ?? 'file'),
        size: Number(data.size) || 0,
        type: isFromHost ? 'send' : 'receive',
        status: autoAccept ? 'transferring' : 'pending',
        progress: 0,
        speed: 0,
        bytesTransferred: 0,
        isFolder: !!data.isFolder,
        startedAt: new Date(),
        device: isFromHost ? remoteInfo?.name : senderName,
        deviceOS: remoteInfo?.os || 'Unknown Mobile',
        peerId: remoteId
      });

      if (autoAccept) {
        console.log(`[WS Server] Auto-accepting "${data.name}" from trusted device ${deviceId}`);
        sendToDevice(deviceId, { type: 'file-accepted', transferId, fileId });
        broadcastState();
        break;
      }

      sendToDevice(targetId, {
        type: 'file-offered',
        fileId,
        transferId,
        name: data.name,
        size: data.size,
        senderId: deviceId,
        senderName,
        isFolder: !!data.isFolder,
        batchId,
        batchName: typeof data.batchName === 'string' ? data.batchName.slice(0, 120) : undefined,
        batchCount: Number(data.batchCount) || undefined,
        relativePath: typeof data.relativePath === 'string' ? data.relativePath.slice(0, 500) : undefined
      });
      broadcastState();
      break;
    }

    case 'file-accept': {
      const route = transferRoutes.get(data.transferId);
      if (!route || route.targetId !== deviceId || route.accepted) break;
      route.accepted = true;

      const acceptTx = transferEngine.getTransfer(data.transferId);
      if (acceptTx) {
        acceptTx.status = 'transferring';
        acceptTx.startedAt = new Date();
      }
      sendToDevice(route.senderId, {
        type: 'file-accepted',
        transferId: data.transferId,
        fileId: route.fileId
      });
      broadcastState();
      break;
    }

    case 'file-reject': {
      const route = transferRoutes.get(data.transferId);
      if (!route || route.targetId !== deviceId) break;
      transferRoutes.delete(data.transferId);
      transferEngine.failTransfer(data.transferId, 'Transfer rejected by receiver');
      sendToDevice(route.senderId, { type: 'file-rejected', transferId: data.transferId });
      broadcastState();
      break;
    }

    case 'transfer-started': {
      const route = transferRoutes.get(data.transferId);
      if (!isParticipant(route, deviceId)) break;
      const tx = transferEngine.getTransfer(data.transferId);
      if (tx) {
        tx.status = 'transferring';
        tx.startedAt = new Date();
      }
      broadcastState();
      break;
    }

    case 'transfer-progress': {
      if (!isParticipant(transferRoutes.get(data.transferId), deviceId)) break;
      transferEngine.updateProgress(data.transferId, Number(data.bytesTransferred) || 0, Number(data.speed) || 0);
      broadcastProgressDelta(data.transferId, Number(data.bytesTransferred) || 0, Number(data.speed) || 0);
      break;
    }

    case 'transfer-completed': {
      if (!isParticipant(transferRoutes.get(data.transferId), deviceId)) break;
      transferEngine.completeTransfer(data.transferId);
      broadcastState();
      break;
    }

    case 'transfer-failed': {
      if (!isParticipant(transferRoutes.get(data.transferId), deviceId)) break;
      transferEngine.failTransfer(data.transferId, String(data.error || 'Failed').slice(0, 200));
      broadcastState();
      break;
    }

    case 'transfer-toggle-pause': {
      const { transferId, paused } = data;
      const route = transferRoutes.get(transferId);
      if (!isParticipant(route, deviceId)) break;

      const download = activeDownloads.get(transferId);
      if (download) {
        if (paused) {
          download.readStream.pause();
        } else {
          download.resetReportTime?.();
          download.readStream.resume();
        }
      }

      const pausedTx = transferEngine.getTransfer(transferId);
      if (pausedTx) {
        pausedTx.status = paused ? 'paused' : 'transferring';
      }
      const otherId = route.senderId === deviceId ? route.targetId : route.senderId;
      sendToDevice(otherId, { type: 'transfer-paused-sync', transferId, paused: !!paused });
      broadcastState();
      break;
    }

    // ---- Trusted devices: only the host's own window may manage these ----
    case 'trust-device': {
      if (deviceId !== HOST_ID) break;
      const targetSocketId = findSocketIdByDevice(String(data.deviceId ?? ''));
      const target = targetSocketId ? activeSockets.get(targetSocketId) : undefined;
      if (!target?.deviceInfo || target.deviceInfo.id === HOST_ID) break;

      const info = target.deviceInfo;
      const token = TrustStore.getInstance().add({
        id: info.id,
        name: String(info.name || 'Unknown Device').slice(0, 64),
        os: String(info.os || 'Unknown').slice(0, 32),
        type: info.type === 'desktop' ? 'desktop' : 'phone'
      });
      // The live connection now counts as the trusted device too.
      target.trustedDeviceId = info.id;
      sendToDevice(info.id, {
        type: 'trust-granted',
        token,
        hostName: deviceManager.getDeviceName(),
        fingerprint: serverFingerprint
      });
      broadcastState();
      break;
    }

    case 'forget-me':
    case 'untrust-device': {
      // The host can forget any device; a device can only ask to forget itself.
      if (data.type === 'untrust-device' && deviceId !== HOST_ID) break;
      const id = data.type === 'forget-me' ? deviceId : String(data.deviceId ?? '');
      if (id === HOST_ID) break;
      if (!TrustStore.getInstance().remove(id)) break;
      const socketId2 = findSocketIdByDevice(id);
      const target = socketId2 ? activeSockets.get(socketId2) : undefined;
      if (target) {
        target.socket.send(JSON.stringify({ type: 'trust-revoked' }));
        // A connection that logged in with the now-deleted key must not stay open.
        if (target.trustedDeviceId === id) target.socket.close(4001, 'Device removed');
        target.trustedDeviceId = undefined;
      }
      broadcastState();
      break;
    }

    case 'set-auto-accept': {
      if (deviceId !== HOST_ID) break;
      TrustStore.getInstance().setAutoAccept(String(data.deviceId ?? ''), !!data.enabled);
      broadcastState();
      break;
    }
  }
}

// Sends each connected device its own view: the host sees everything, other
// devices only see the host and the transfers they are part of.
export function broadcastState() {
  const deviceManager = DeviceManager.getInstance();
  const transferEngine = TransferEngine.getInstance();
  const allPeers = deviceManager.getPeers();
  const allTransfers = transferEngine.getTransfers();
  const trustStore = TrustStore.getInstance();
  const peersWithTrust = allPeers.map((p) => ({ ...p, trusted: p.id !== HOST_ID && trustStore.has(p.id) }));
  const connectedIds = new Set(allPeers.map((p) => p.id));
  const trustedDevices = trustStore.list().map((d) => ({ ...d, connected: connectedIds.has(d.id) }));

  for (const { socket, deviceInfo } of activeSockets.values()) {
    const viewerId: string | undefined = deviceInfo?.id;
    if (!viewerId || socket.readyState !== WebSocket.OPEN) continue;
    const isHostViewer = viewerId === HOST_ID;

    socket.send(JSON.stringify({
      type: 'state-sync',
      peers: isHostViewer ? peersWithTrust : peersWithTrust.filter((p) => p.id === HOST_ID || p.id === viewerId),
      transfers: isHostViewer ? allTransfers : allTransfers.filter((t) => t.peerId === viewerId),
      downloadsFolder: isHostViewer ? transferEngine.getDownloadsFolder() : undefined,
      // Only the host gets the list of remembered devices; others just learn whether they are one.
      trustedDevices: isHostViewer ? trustedDevices : undefined,
      youAreTrusted: isHostViewer ? undefined : trustStore.has(viewerId)
    }));
  }
}

// Progress updates go only to the host and the device on the other end of the transfer.
export function broadcastProgressDelta(transferId: string, bytesTransferred: number, speed: number) {
  const transferEngine = TransferEngine.getInstance();
  const tx = transferEngine.getTransfer(transferId);
  const progress = tx ? tx.progress : 0;

  const payload = JSON.stringify({
    type: 'transfer-progress-delta',
    transferId,
    bytesTransferred,
    progress,
    speed
  });

  for (const { socket, deviceInfo } of activeSockets.values()) {
    const viewerId = deviceInfo?.id;
    if (viewerId !== HOST_ID && (!tx || viewerId !== tx.peerId)) continue;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}
