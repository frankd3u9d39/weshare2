import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import { fork, execFile } from 'child_process';
import { TransferEngine } from '../services/transferEngine';
import { offeredFolderZips } from './offeredZips';
import { openPrintScreen, registerPrintScreenHandlers, PRINTABLE_IMAGE_TYPES } from './printScreen';

async function zipDirectory(sourcePath: string): Promise<{ zipPath: string; size: number }> {
  return new Promise((resolve, reject) => {
    try {
      const tempDir = path.join(app.getPath('temp'), 'Weshare');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const zipPath = path.join(tempDir, `${path.basename(sourcePath)}-${Date.now()}.zip`);
      const workerPath = path.join(__dirname, 'zipWorker.js');

      console.log(`[Main Process] Spawning zip worker to archive directory: ${sourcePath}`);
      const child = fork(workerPath, [sourcePath, zipPath]);

      child.on('close', (code) => {
        if (code === 0) {
          try {
            const stat = fs.statSync(zipPath);
            resolve({ zipPath, size: stat.size });
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Zip worker process exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export function registerFileSelectionHandlers(getMainWindow: () => BrowserWindow | null) {
  // IPC Handler: File Selection Dialog
  // Windows and Linux can't show a picker that selects both files and folders (asking for
  // both shows a folder-only picker), so the renderer asks for one kind at a time.
  ipcMain.handle('select-file', async (event, mode: 'files' | 'folders' = 'files') => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: mode === 'folders' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      title: mode === 'folders' ? 'Select Folders to Share' : 'Select Files to Share'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const files = [];
    for (const filePath of result.filePaths) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          const { zipPath, size } = await zipDirectory(filePath);
          const fileId = TransferEngine.getInstance().offerFile(zipPath);
          offeredFolderZips.set(fileId, zipPath);
          files.push({
            fileId,
            name: path.basename(filePath),
            size,
            path: filePath,
            isFolder: true
          });
        } else {
          const fileId = TransferEngine.getInstance().offerFile(filePath);
          files.push({
            fileId,
            name: path.basename(filePath),
            size: stat.size,
            path: filePath,
            isFolder: false
          });
        }
      } catch (err) {
        console.error('[Select File] Error processing path:', filePath, err);
      }
    }

    return files;
  });

  // IPC Handler: Offer a single dragged-and-dropped file
  ipcMain.handle('offer-dropped-file', async (event, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          const { zipPath, size } = await zipDirectory(filePath);
          const fileId = TransferEngine.getInstance().offerFile(zipPath);
          offeredFolderZips.set(fileId, zipPath);
          return {
            fileId,
            name: path.basename(filePath),
            size,
            path: filePath,
            isFolder: true
          };
        } else {
          const fileId = TransferEngine.getInstance().offerFile(filePath);
          return {
            fileId,
            name: path.basename(filePath),
            size: stat.size,
            path: filePath,
            isFolder: false
          };
        }
      }
    } catch (e) {
      console.error('Failed to offer dropped file:', e);
    }
    return null;
  });

  // IPC Handler: Open Folder in Explorer
  ipcMain.handle('open-folder', async (event, targetPath) => {
    const defaultDir = TransferEngine.getInstance().getDownloadsFolder();
    const folderToOpen = targetPath || defaultDir;

    if (fs.existsSync(folderToOpen)) {
      // If it is a file, show the file in the containing folder
      const stat = fs.statSync(folderToOpen);
      if (stat.isFile()) {
        shell.showItemInFolder(folderToOpen);
      } else {
        shell.openPath(folderToOpen);
      }
      return true;
    }
    return false;
  });

  // Print and Edit only work on a real file that exists (not a folder).
  const existingFile = (p: unknown): string | null => {
    if (typeof p !== 'string' || !p) return null;
    try {
      return fs.statSync(p).isFile() ? p : null;
    } catch (e) {
      return null;
    }
  };

  // ---- Print ----
  // Pictures and PDFs open Weshare's own print screen (preview, printer, copies, colour...),
  // because on many PCs the app that opens them (Photos, Edge, other browsers) gives Windows
  // no "print" command. Everything else (Word, text files...) goes to the app Windows uses
  // to print that kind of file.
  registerPrintScreenHandlers();

  // Outside Windows, PDFs open in Weshare's PDF viewer, whose print button prints every page.
  const openPdfForPrinting = (file: string) => {
    const win = new BrowserWindow({
      width: 900,
      height: 1000,
      title: `Print · ${path.basename(file)}`,
      icon: path.join(__dirname, 'logo.png'),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true }
    });
    // Electron reports a PDF hand-over to the viewer as a failed load even though it shows fine.
    win.loadURL(pathToFileURL(file).href).catch(() => {});
  };

  ipcMain.handle('print-file', async (event, targetPath) => {
    const file = existingFile(targetPath);
    if (!file) return { ok: false, error: 'The file is no longer there.' };
    const ext = path.extname(file).toLowerCase();

    try {
      if (PRINTABLE_IMAGE_TYPES.includes(ext) || (ext === '.pdf' && process.platform === 'win32')) {
        await openPrintScreen(file);
        return { ok: true };
      }
      if (ext === '.pdf') {
        openPdfForPrinting(file);
        return { ok: true, note: 'pdf-viewer' };
      }
    } catch (e: any) {
      console.error('[Print] Failed:', e?.message || e);
      return { ok: false, error: 'Could not open the file for printing.' };
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      if (process.platform === 'win32') {
        // The path goes in through an environment variable, so nothing in a file name
        // can be read as a command.
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath $env:WESHARE_PRINT_FILE -Verb Print -ErrorAction Stop'],
          { env: { ...process.env, WESHARE_PRINT_FILE: file }, windowsHide: true, timeout: 30000 },
          (err) => {
            if (err) {
              console.error('[Print] Failed:', err.message);
              resolve({ ok: false, error: 'No app on this computer can print this kind of file. Use Edit to open it, then print from there.' });
            } else {
              resolve({ ok: true });
            }
          }
        );
      } else {
        execFile('lp', [file], (err) => resolve(err ? { ok: false, error: 'Printing is not available on this computer.' } : { ok: true }));
      }
    });
  });

  // IPC Handler: Edit = ask which app to open the file with (Windows' "Open with" list).
  ipcMain.handle('open-file-with', async (event, targetPath) => {
    const file = existingFile(targetPath);
    if (!file) return { ok: false, error: 'The file is no longer there.' };

    if (process.platform === 'win32') {
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        // OpenAs_RunDLL reads the rest of the line as the path, so it is passed unquoted.
        execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', file], { windowsVerbatimArguments: true }, (err) => {
          if (err) console.error('[Open with] Failed:', err.message);
          resolve(err ? { ok: false, error: 'Could not show the list of apps.' } : { ok: true });
        });
      });
    }
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
  });
}
