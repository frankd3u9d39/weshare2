import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import { safeJoin, sanitizeFileName, sanitizeRelativePath } from './pathSafety';

/**
 * Total unpacked size the zip says it holds (yauzl checks each entry really matches it),
 * and the single folder everything sits in, if there is one ("Photos/..." only).
 */
export function inspectZip(zipPath: string): Promise<{ unpackedSize: number; singleTopFolder: string | null }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err || new Error('Could not open zip'));
      let total = 0;
      const tops = new Set<string>();
      let hasTopLevelFile = false;
      zip.on('entry', (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        const parts = entry.fileName.split('/').filter(Boolean);
        // macOS adds a "__MACOSX" folder of metadata to zips; it isn't part of the folder.
        if (parts[0] !== '__MACOSX' && parts.length > 0) {
          tops.add(parts[0]);
          if (parts.length === 1 && !entry.fileName.endsWith('/')) hasTopLevelFile = true;
        }
        zip.readEntry();
      });
      zip.on('end', () =>
        resolve({ unpackedSize: total, singleTopFolder: tops.size === 1 && !hasTopLevelFile ? [...tops][0] : null })
      );
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Free bytes on the drive holding `dir`, or Infinity if it can't be told. */
export function freeDiskSpace(dir: string): number {
  try {
    const stats = (fs as any).statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (e) {
    return Infinity;
  }
}

/**
 * Unpacks a zip that arrived from another device, but only when it is safe to: the
 * unpacked size must fit on the disk with 1 GB to spare (so a "zip bomb" can't fill it).
 * Returns the new folder, or null to keep the zip as it is.
 */
export async function unpackReceivedZip(zipPath: string, destFolder: string, baseName: string): Promise<string | null> {
  try {
    const { unpackedSize, singleTopFolder } = await inspectZip(zipPath);
    const free = freeDiskSpace(destFolder);
    if (unpackedSize > free - 1024 * 1024 * 1024) {
      console.warn(`[Unzip] Keeping ${baseName} zipped: it unpacks to ${unpackedSize} bytes, more than the free space allows`);
      return null;
    }
    // "Photos.zip" holding "Photos/..." becomes Downloads/Photos, not Downloads/Photos/Photos.
    if (singleTopFolder) {
      try {
        return await extractZipToUniqueDir(zipPath, destFolder, singleTopFolder, singleTopFolder);
      } catch (e) {
        // fall through: a cleaned-up folder name can't be used, unpack it as it is
      }
    }
    return await extractZipToUniqueDir(zipPath, destFolder, baseName);
  } catch (err) {
    console.warn(`[Unzip] Keeping ${baseName} zipped: it could not be unpacked`, err);
    return null;
  }
}

// Extracts a zip archive into a uniquely-named directory under destFolder (named after
// baseName, with any trailing .zip stripped), then deletes the source zip file.
// Streams entry by entry, so archives of any size extract without loading into memory.
// Every entry path is sanitised and confined to the destination ("zip slip" safe).
// Shared by the folder-upload handler and the native desktop-to-desktop download path.
// `stripTopFolder` drops that leading folder from every entry (used when the whole zip is one folder).
export function extractZipToUniqueDir(zipPath: string, destFolder: string, baseName: string, stripTopFolder?: string): Promise<string> {
  const safeName = sanitizeFileName(baseName);
  const folderName = safeName.toLowerCase().endsWith('.zip') ? safeName.slice(0, -4) || 'folder' : safeName;

  const extractDest = safeJoin(destFolder, folderName);
  let uniqueExtractDest = extractDest;
  for (let counter = 1; fs.existsSync(uniqueExtractDest); counter++) {
    uniqueExtractDest = `${extractDest}-${counter}`;
  }
  fs.mkdirSync(uniqueExtractDest, { recursive: true });

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(openErr || new Error('Could not open zip'));
        return;
      }
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        zip.close();
        // Don't leave a half-unpacked folder behind; the zip itself is kept.
        try {
          fs.rmSync(uniqueExtractDest, { recursive: true, force: true });
        } catch (e) {}
        reject(err);
      };

      zip.on('entry', (entry: yauzl.Entry) => {
        let segments: string[];
        let entryName = entry.fileName;
        if (stripTopFolder) {
          if (entryName.startsWith('__MACOSX/')) {
            zip.readEntry(); // macOS metadata, not part of the folder
            return;
          }
          entryName = entryName.startsWith(`${stripTopFolder}/`) ? entryName.slice(stripTopFolder.length + 1) : entryName;
        }
        try {
          segments = sanitizeRelativePath(entryName);
        } catch (e) {
          zip.readEntry(); // unusable name: skip it
          return;
        }
        if (segments.length === 0) {
          zip.readEntry();
          return;
        }
        const target = safeJoin(uniqueExtractDest, ...segments);

        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(target, { recursive: true });
          zip.readEntry();
          return;
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(streamErr || new Error('Could not read zip entry'));
            return;
          }
          const out = fs.createWriteStream(target);
          out.on('error', fail);
          readStream.on('error', fail);
          out.on('finish', () => zip.readEntry());
          readStream.pipe(out);
        });
      });

      zip.on('end', () => {
        try {
          fs.unlinkSync(zipPath);
        } catch (e) {}
        resolve(uniqueExtractDest);
      });
      zip.on('error', fail);
      zip.readEntry();
    });
  });
}
