// Downloads a file inside the page (fetch), in pieces, instead of handing the URL to the
// browser's download manager. On phones the download manager runs outside the tab and
// doesn't accept the computer's self-made certificate, so it just sits "paused". The tab
// already trusts it. Each piece is a Range request, so a dropped piece is retried from
// where it stopped. When everything has arrived the pieces become one Blob to save.

const PIECE_SIZE = 8 * 1024 * 1024;
const MAX_RETRIES = 6;

export interface PageDownloadProgress {
  received: number;
  total: number;
}

export interface PageDownloadHandle {
  promise: Promise<Blob>;
  abort: () => void;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function downloadInPage(url: string, onProgress: (p: PageDownloadProgress) => void): PageDownloadHandle {
  const controller = new AbortController();

  const promise = (async () => {
    const parts: Blob[] = [];
    let received = 0;
    let total = -1; // learnt from the first response
    let failures = 0;

    while (total < 0 || received < total) {
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const end = received + PIECE_SIZE - 1;
      try {
        const res = await fetch(url, { headers: { Range: `bytes=${received}-${end}` }, signal: controller.signal });

        if (res.status === 206) {
          const range = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') || '');
          if (range) total = parseInt(range[1], 10);
          const piece = await res.blob();
          if (piece.size === 0) throw new Error('Empty piece');
          parts.push(piece);
          received += piece.size;
        } else if (res.status === 200) {
          // The server sent the whole file in one go (no resume support for this URL).
          // Stream it so progress still shows.
          const length = parseInt(res.headers.get('Content-Length') || '0', 10);
          total = length > 0 ? length : -1;
          parts.length = 0;
          received = 0;
          const reader = res.body?.getReader();
          if (!reader) {
            const whole = await res.blob();
            parts.push(whole);
            received = whole.size;
          } else {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parts.push(new Blob([value]));
              received += value.length;
              onProgress({ received, total: total > 0 ? total : received });
            }
          }
          total = received;
        } else if (res.status === 416 && total >= 0) {
          break; // asked past the end: we already have everything
        } else {
          let message = `Error ${res.status}`;
          try {
            message = (await res.json()).error || message;
          } catch (e) {}
          // Refusals (not accepted, file gone) won't fix themselves by retrying.
          if (res.status === 401 || res.status === 403 || res.status === 404) throw Object.assign(new Error(message), { fatal: true });
          throw new Error(message);
        }
        failures = 0;
        onProgress({ received, total: total >= 0 ? total : received });
      } catch (err: any) {
        if (controller.signal.aborted || err?.name === 'AbortError') throw err;
        if (err?.fatal || ++failures > MAX_RETRIES) throw err;
        await wait(Math.min(1000 * 2 ** (failures - 1), 8000));
      }
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  })();

  return { promise, abort: () => controller.abort() };
}

/** Saves a Blob as a file with the given name. Works on Android Chrome, iOS Safari 13+ and desktop. */
export function saveBlob(blobUrl: string, name: string) {
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 1000);
}
