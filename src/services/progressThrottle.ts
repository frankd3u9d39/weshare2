// Throttles per-chunk byte counters down to periodic speed-reporting ticks,
// shared by the Express download handler and the native upload/download IPC handlers.
export interface ProgressThrottle {
  report(bytesTransferred: number): void;
  // Re-anchors the window at `currentBytes` (e.g. after a pause) so the next
  // tick doesn't compute speed across the paused gap.
  reset(currentBytes: number): void;
}

export function createProgressThrottle(
  intervalSec: number,
  onTick: (bytesTransferred: number, speed: number) => void
): ProgressThrottle {
  let lastReportTime = Date.now();
  let lastReportBytes = 0;

  return {
    report(bytesTransferred: number) {
      const now = Date.now();
      const elapsed = (now - lastReportTime) / 1000;
      if (elapsed >= intervalSec) {
        const speed = (bytesTransferred - lastReportBytes) / elapsed;
        lastReportTime = now;
        lastReportBytes = bytesTransferred;
        onTick(bytesTransferred, speed);
      }
    },
    reset(currentBytes: number) {
      lastReportTime = Date.now();
      lastReportBytes = currentBytes;
    }
  };
}
