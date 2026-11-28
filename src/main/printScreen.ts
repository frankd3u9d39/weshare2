import { app, BrowserWindow, ipcMain, WebContents } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

/*
 * Weshare's own print screen: a preview of every page plus the printer, copies, colour,
 * paper, layout and two-sided settings, then prints straight to the chosen printer.
 *
 * Pictures are shown as they are. PDF pages are first turned into pictures by the PDF reader
 * built into Windows 10/11 (Windows.Data.Pdf), so no extra software is needed, and printing
 * doesn't depend on which app opens PDFs on this PC.
 */

export const PRINTABLE_IMAGE_TYPES = ['.jpg', '.jpeg', '.jfif', '.png', '.gif', '.bmp', '.webp', '.avif', '.svg', '.ico'];

type PrintPage = { src: string; width: number; height: number };
type PrintJob = {
  name: string;
  kind: 'image' | 'pdf';
  pages: PrintPage[];
  total: number;
  done: boolean;
  error?: string;
  tempDir?: string;
  child?: ChildProcess;
};

const jobs = new Map<number, PrintJob>();

const publicJob = (job: PrintJob) => ({
  name: job.name,
  kind: job.kind,
  pages: job.pages,
  total: job.total,
  done: job.done,
  error: job.error
});

const sendUpdate = (wc: WebContents, job: PrintJob) => {
  if (!wc.isDestroyed()) wc.send('print:job-updated', publicJob(job));
};

// Turns each PDF page into a PNG (240 dpi), printing "TOTAL n" and then one "PAGE {...}" line
// per page as it goes, so the preview fills in while the rest are still being made.
// Paths come in through environment variables, so nothing in a file name is read as a command.
const PDF_PAGES_SCRIPT = `
$ErrorActionPreference = 'Stop'
$src = $env:WESHARE_PDF_FILE
$outDir = $env:WESHARE_PDF_OUT
$scale = 2.5
$maxPages = 300
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
$asTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
} | Select-Object -First 1
$asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
} | Select-Object -First 1
function Wait-Op($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
function Wait-Action($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait() }
$file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])
$doc = Wait-Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$folder = Wait-Op ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outDir)) ([Windows.Storage.StorageFolder])
$count = [Math]::Min([int]$doc.PageCount, $maxPages)
[Console]::Out.WriteLine("TOTAL $count")
[Console]::Out.Flush()
for ($i = 0; $i -lt $count; $i++) {
  $page = $doc.GetPage([uint32]$i)
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opts.DestinationWidth = [uint32][Math]::Round($page.Size.Width * $scale)
  $opts.DestinationHeight = [uint32][Math]::Round($page.Size.Height * $scale)
  $name = 'page-{0:D4}.png' -f ($i + 1)
  $out = Wait-Op ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $stream = Wait-Op ($out.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  Wait-Action ($page.RenderToStreamAsync($stream, $opts))
  $stream.Dispose()
  $line = @{ file = $name; width = [double]$page.Size.Width; height = [double]$page.Size.Height } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine("PAGE $line")
  [Console]::Out.Flush()
  $page.Dispose()
}
`;

const printTempRoot = () => path.join(app.getPath('temp'), 'Weshare', 'print');

// Leftover page pictures from earlier print screens (e.g. after a crash) are removed.
const removeOldPrintFolders = () => {
  const root = printTempRoot();
  const inUse = new Set([...jobs.values()].map((j) => j.tempDir).filter(Boolean));
  try {
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      if (!inUse.has(dir)) fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  } catch (e) {}
};

const renderPdfPages = (file: string, job: PrintJob, wc: WebContents) => {
  const dir = path.join(printTempRoot(), `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  job.tempDir = dir;

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PDF_PAGES_SCRIPT, 'utf16le').toString('base64')],
    { env: { ...process.env, WESHARE_PDF_FILE: file, WESHARE_PDF_OUT: dir }, windowsHide: true }
  );
  job.child = child;

  let buffer = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('TOTAL ')) {
        job.total = Number(line.slice(6)) || 0;
        sendUpdate(wc, job);
      } else if (line.startsWith('PAGE ')) {
        try {
          const p = JSON.parse(line.slice(5));
          job.pages.push({ src: pathToFileURL(path.join(dir, p.file)).href, width: p.width, height: p.height });
          sendUpdate(wc, job);
        } catch (e) {}
      }
    }
  });
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  child.on('close', (code) => {
    job.child = undefined;
    job.done = true;
    if (code !== 0 || job.pages.length === 0) {
      console.error('[Print] PDF pages failed:', code, errors.slice(0, 500));
      job.error = /password/i.test(errors)
        ? 'This PDF is locked with a password, so Weshare can\'t print it. Use Edit to open it in another app.'
        : 'Weshare couldn\'t read this PDF. Use Edit to open it in another app and print from there.';
    }
    sendUpdate(wc, job);
  });
};

/** Opens the print screen for a picture or (on Windows) a PDF. */
export async function openPrintScreen(file: string) {
  const ext = path.extname(file).toLowerCase();
  const kind: PrintJob['kind'] = ext === '.pdf' ? 'pdf' : 'image';
  removeOldPrintFolders();

  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: `Print · ${path.basename(file)}`,
    icon: path.join(__dirname, 'logo.png'),
    autoHideMenuBar: true,
    backgroundColor: '#121316',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'printPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const wc = win.webContents;
  const id = wc.id;

  const job: PrintJob = {
    name: path.basename(file),
    kind,
    pages: kind === 'image' ? [{ src: pathToFileURL(file).href, width: 0, height: 0 }] : [],
    total: kind === 'image' ? 1 : 0,
    done: kind === 'image'
  };
  jobs.set(id, job);

  // The print screen never leaves its own page.
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    job.child?.kill();
    if (job.tempDir) fs.rm(job.tempDir, { recursive: true, force: true }, () => {});
    jobs.delete(id);
  });

  if (kind === 'pdf') renderPdfPages(file, job, wc);
  await win.loadFile(path.join(__dirname, 'printScreen.html'));
  return win;
}

const PAPER_SIZES = ['A4', 'A3', 'A5', 'Letter', 'Legal'] as const;
const DUPLEX = ['simplex', 'longEdge', 'shortEdge'] as const;

export function registerPrintScreenHandlers() {
  ipcMain.handle('print:get-job', (event) => {
    const job = jobs.get(event.sender.id);
    return job ? publicJob(job) : null;
  });

  ipcMain.handle('print:printers', async (event) => {
    if (!jobs.has(event.sender.id)) return [];
    try {
      const printers = await event.sender.getPrintersAsync();
      return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('print:run', (event, raw: any) => {
    if (!jobs.has(event.sender.id)) return { ok: false, reason: 'No print job' };
    const o = raw && typeof raw === 'object' ? raw : {};
    const system = o.system === true;
    const options: Electron.WebContentsPrintOptions = {
      silent: !system,
      printBackground: true,
      color: o.color !== false,
      landscape: o.landscape === true,
      copies: Math.min(99, Math.max(1, Math.round(Number(o.copies) || 1))),
      collate: true,
      pageSize: PAPER_SIZES.includes(o.pageSize) ? o.pageSize : 'A4',
      duplexMode: DUPLEX.includes(o.duplexMode) ? o.duplexMode : 'simplex',
      margins: { marginType: 'none' }
    };
    if (!system && typeof o.deviceName === 'string' && o.deviceName) options.deviceName = o.deviceName;

    return new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      event.sender.print(options, (success, reason) => resolve({ ok: success, reason: success ? undefined : reason }));
    });
  });

  ipcMain.handle('print:close', (event) => {
    if (!jobs.has(event.sender.id)) return;
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}
