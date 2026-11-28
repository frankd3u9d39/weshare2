import fs from 'fs';
import path from 'path';
import yazl from 'yazl';

// Background process: zips a folder by streaming each file into the archive, so memory
// use stays flat no matter how large the folder is (the old in-memory zip failed past ~2 GB).

const sourcePath = process.argv[2];
const zipPath = process.argv[3];

if (!sourcePath || !zipPath) {
  console.error('[Zip Worker] Missing sourcePath or zipPath argument');
  process.exit(1);
}

function addFolder(zip: yazl.ZipFile, dir: string, prefix: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0 && prefix) {
    zip.addEmptyDirectory(prefix);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addFolder(zip, full, name);
    } else if (entry.isFile()) {
      // Store already-compressed media without recompressing; it's faster and no bigger.
      const compress = !/\.(jpe?g|png|gif|webp|heic|mp4|mov|mkv|avi|mp3|aac|m4a|zip|7z|rar|gz|pdf)$/i.test(entry.name);
      zip.addFile(full, name, { compress });
    }
    // Symlinks and special files are skipped so the archive never reaches outside the folder.
  }
}

try {
  console.log(`[Zip Worker] Archiving folder: ${sourcePath} -> ${zipPath}`);
  const zip = new yazl.ZipFile();
  const out = fs.createWriteStream(zipPath);
  out.on('close', () => {
    console.log('[Zip Worker] Archive completed successfully');
    process.exit(0);
  });
  out.on('error', (err) => {
    console.error('[Zip Worker] Write failed:', err.message);
    process.exit(1);
  });
  zip.outputStream.pipe(out);
  addFolder(zip, sourcePath, '');
  zip.end();
} catch (err: any) {
  console.error('[Zip Worker] Failed to archive directory:', err.message || err);
  process.exit(1);
}
