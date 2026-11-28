import { BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { TransferEngine } from '../services/transferEngine';
import { pinnedAgent } from './tlsTrust';
import { safeJoin, sanitizeFileName } from '../services/pathSafety';
import { extractZipToUniqueDir } from '../services/zipExtract';
import { createProgressThrottle } from '../services/progressThrottle';
import { offeredFolderZips } from './offeredZips';

interface ActiveNativeTransfer {
  type: 'upload' | 'download';
  filePath: string;
  fileStream: fs.ReadStream | fs.WriteStream;
  request?: http.ClientRequest;
  response?: http.IncomingMessage;
  paused: boolean;
}

const activeNativeTransfers = new Map<string, ActiveNativeTransfer>();

function getUniqueFilePath(destFolder: string, originalName: string): string {
  const safeName = sanitizeFileName(originalName);
  const ext = path.extname(safeName);
  const name = path.basename(safeName, ext);
  let targetPath = safeJoin(destFolder, safeName);
  let counter = 1;
  while (fs.existsSync(targetPath)) {
    targetPath = safeJoin(destFolder, `${name}-${counter}${ext}`);
    counter++;
  }
  return targetPath;
}

function cleanupDownload(transferId: string, filePath: string) {
  activeNativeTransfers.delete(transferId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {}

  const localTx = TransferEngine.getInstance().getTransfer(transferId);
  if (localTx) {
    TransferEngine.getInstance().failTransfer(transferId, 'Native download failed');
  }
}

// Strips CR/LF and quotes so an attacker-influenced filename can't break out of the
// Content-Disposition header and inject extra multipart fields/headers.
function escapeHeaderValue(value: string): string {
  return String(value).replace(/[\r\n"]/g, '');
}

export function registerNativeTransferHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle('start-file-download', async (event, { downloadUrl, transferId, fileName, fileSize, isFolder }) => {
    return new Promise((resolve) => {
      try {
        const destFolder = TransferEngine.getInstance().getDownloadsFolder();
        const downloadFileName = isFolder ? `${fileName}.zip` : fileName;
        const uniqueFilePath = getUniqueFilePath(destFolder, downloadFileName);

        // https links are checked against the pinned WeShare certificate; plain http is used
        // when the other computer has "Encrypt connections" turned off.
        const secure = downloadUrl.startsWith('https://');
        if (!secure && !downloadUrl.startsWith('http://')) {
          console.error('[Native Download] Refusing non-http(s) URL');
          resolve(false);
          return;
        }

        const onResponse = (response: http.IncomingMessage) => {
          if (response.socket) {
            response.socket.setTimeout(0);
          }

          if (response.statusCode !== 200) {
            console.error(`[Native Download] Failed: status code ${response.statusCode}`);
            resolve(false);
            return;
          }

          const fileStream = fs.createWriteStream(uniqueFilePath);

          activeNativeTransfers.set(transferId, {
            type: 'download',
            filePath: uniqueFilePath,
            fileStream,
            request,
            response,
            paused: false
          });

          let bytesWritten = 0;
          const throttle = createProgressThrottle(1.0, (bytesTransferred, speed) => {
            getMainWindow()?.webContents.send('download-progress-delta', {
              transferId,
              bytesTransferred,
              speed
            });
          });

          response.on('data', (chunk) => {
            bytesWritten += chunk.length;
            throttle.report(bytesWritten);
          });

          response.pipe(fileStream);

          fileStream.on('finish', async () => {
            fileStream.close();
            activeNativeTransfers.delete(transferId);

            let finalPath = uniqueFilePath;
            if (isFolder) {
              try {
                finalPath = await extractZipToUniqueDir(uniqueFilePath, destFolder, fileName);
                console.log(`[Native Download] Extracted folder successfully to: ${finalPath}`);
              } catch (err) {
                console.error('[Native Download] Extraction failed:', err);
              }
            }

            const localTx = TransferEngine.getInstance().getTransfer(transferId);
            if (localTx) {
              localTx.filePath = finalPath;
              TransferEngine.getInstance().completeTransfer(transferId);
            } else {
              TransferEngine.getInstance().registerTransfer({
                id: transferId,
                name: fileName,
                size: fileSize,
                type: 'receive',
                status: 'completed',
                progress: 100,
                speed: 0,
                filePath: finalPath,
                bytesTransferred: fileSize,
                startedAt: new Date(),
                completedAt: new Date()
              });
            }

            resolve(true);
          });

          fileStream.on('error', (err) => {
            console.error('[Native Download] write stream error:', err);
            fileStream.close();
            cleanupDownload(transferId, uniqueFilePath);
            resolve(false);
          });
        };

        const request = secure
          ? https.get(downloadUrl, { agent: pinnedAgent }, onResponse)
          : http.get(downloadUrl, onResponse);

        request.on('error', (err) => {
          console.error('[Native Download] request error:', err);
          cleanupDownload(transferId, uniqueFilePath);
          resolve(false);
        });

      } catch (err) {
        console.error('[Native Download] setup error:', err);
        resolve(false);
      }
    });
  });

  ipcMain.handle('start-file-upload', async (event, { uploadUrl, transferId, fileId, fileName, fileSize }) => {
    return new Promise((resolve) => {
      try {
        const filePath = TransferEngine.getInstance().getOfferedFilePath(fileId);
        if (!filePath || !fs.existsSync(filePath)) {
          console.error(`[Native Upload] File path not found for fileId: ${fileId}`);
          resolve(false);
          return;
        }

        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2, 15);
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeHeaderValue(fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const footer = `\r\n--${boundary}--\r\n`;

        // https uploads are pinned to the WeShare certificate; plain http when the other
        // computer has "Encrypt connections" turned off.
        const secure = uploadUrl.startsWith('https://');
        if (!secure && !uploadUrl.startsWith('http://')) {
          console.error('[Native Upload] Refusing non-http(s) URL');
          resolve(false);
          return;
        }

        const request = (secure ? https : http).request(uploadUrl, {
          ...(secure ? { agent: pinnedAgent } : {}),
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(header) + fileSize + Buffer.byteLength(footer)
          }
        }, (res) => {
          if (res.socket) {
            res.socket.setTimeout(0);
          }

          res.on('data', (d) => {
            console.log('[Native Upload] Response chunk:', d.toString());
          });

          res.on('end', () => {
            activeNativeTransfers.delete(transferId);

            const tempZip = offeredFolderZips.get(fileId);
            if (tempZip) {
              try { fs.unlinkSync(tempZip); } catch (e) {}
              offeredFolderZips.delete(fileId);
            }

            const localTx = TransferEngine.getInstance().getTransfer(transferId);
            if (localTx) {
              TransferEngine.getInstance().completeTransfer(transferId);
            } else {
              TransferEngine.getInstance().registerTransfer({
                id: transferId,
                name: fileName,
                size: fileSize,
                type: 'send',
                status: 'completed',
                progress: 100,
                speed: 0,
                filePath: filePath,
                bytesTransferred: fileSize,
                startedAt: new Date(),
                completedAt: new Date()
              });
            }

            resolve(res.statusCode === 200);
          });
        });

        request.on('error', (err) => {
          console.error('[Native Upload] request error:', err);
          activeNativeTransfers.delete(transferId);

          const tempZip = offeredFolderZips.get(fileId);
          if (tempZip) {
            try { fs.unlinkSync(tempZip); } catch (e) {}
            offeredFolderZips.delete(fileId);
          }

          const localTx = TransferEngine.getInstance().getTransfer(transferId);
          if (localTx) {
            TransferEngine.getInstance().failTransfer(transferId, err.message);
          }
          resolve(false);
        });

        const fileStream = fs.createReadStream(filePath);

        activeNativeTransfers.set(transferId, {
          type: 'upload',
          filePath,
          fileStream,
          request,
          paused: false
        });

        request.write(header);

        let bytesUploaded = 0;
        const throttle = createProgressThrottle(1.0, (bytesTransferred, speed) => {
          getMainWindow()?.webContents.send('upload-progress-delta', {
            transferId,
            bytesTransferred,
            speed
          });
        });

        fileStream.on('data', (chunk) => {
          bytesUploaded += chunk.length;
          throttle.report(bytesUploaded);
        });

        fileStream.pipe(request, { end: false });

        fileStream.on('end', () => {
          request.write(footer);
          request.end();
        });

        fileStream.on('error', (err) => {
          console.error('[Native Upload] read stream error:', err);
          request.destroy();
          activeNativeTransfers.delete(transferId);

          const tempZip = offeredFolderZips.get(fileId);
          if (tempZip) {
            try { fs.unlinkSync(tempZip); } catch (e) {}
            offeredFolderZips.delete(fileId);
          }

          const localTx = TransferEngine.getInstance().getTransfer(transferId);
          if (localTx) {
            TransferEngine.getInstance().failTransfer(transferId, err.message);
          }
          resolve(false);
        });

      } catch (err) {
        console.error('[Native Upload] setup error:', err);
        resolve(false);
      }
    });
  });

  ipcMain.handle('toggle-native-transfer', async (event, transferId, paused) => {
    const transfer = activeNativeTransfers.get(transferId);
    if (transfer) {
      transfer.paused = paused;
      if (transfer.type === 'upload') {
        const readStream = transfer.fileStream as fs.ReadStream;
        if (paused) {
          console.log(`[Native Upload] Pausing stream for transfer ${transferId}`);
          readStream.pause();
        } else {
          console.log(`[Native Upload] Resuming stream for transfer ${transferId}`);
          readStream.resume();
        }
      } else {
        const response = transfer.response;
        if (response) {
          if (paused) {
            console.log(`[Native Download] Pausing response stream for transfer ${transferId}`);
            response.pause();
          } else {
            console.log(`[Native Download] Resuming response stream for transfer ${transferId}`);
            response.resume();
          }
        }
      }
      return true;
    }
    return false;
  });

  ipcMain.handle('cancel-native-transfer', async (event, transferId) => {
    const transfer = activeNativeTransfers.get(transferId);
    if (transfer) {
      console.log(`[Native Transfer] Cancelling transfer: ${transferId}`);
      try {
        if (transfer.request) {
          transfer.request.destroy();
        }
        transfer.fileStream.close();
      } catch (e) {
        console.error('[Native Transfer] Error closing streams on cancel:', e);
      }

      if (transfer.type === 'download' && transfer.filePath) {
        try {
          if (fs.existsSync(transfer.filePath)) {
            fs.unlinkSync(transfer.filePath);
          }
        } catch (e) {
          console.error('[Native Transfer] Error deleting partial download file:', e);
        }
      }

      activeNativeTransfers.delete(transferId);

      const localTx = TransferEngine.getInstance().getTransfer(transferId);
      if (localTx) {
        TransferEngine.getInstance().failTransfer(transferId, 'Transfer cancelled by user');
        if (localTx.fileId) {
          const tempZip = offeredFolderZips.get(localTx.fileId);
          if (tempZip) {
            try { fs.unlinkSync(tempZip); } catch (e) {}
            offeredFolderZips.delete(localTx.fileId);
          }
        }
      }
      return true;
    }
    return false;
  });
}
