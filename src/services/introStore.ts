import fs from 'fs';
import path from 'path';

/*
 * Phones and browsers that have already been through the intro screens.
 *
 * A phone keeps its own "seen" flag in browser storage, but that storage belongs to one
 * address (scheme + IP + port), so it is lost when the address changes, and in-app QR
 * scanners often throw it away. The host therefore also remembers each visitor's network
 * address, so a person who scans the code again is not shown the intro a second time.
 */
const MAX_ENTRIES = 1000;

export class IntroStore {
  private static instance: IntroStore;
  private filePath: string | null = null;
  // address -> ISO date it was last seen; insertion order doubles as age for trimming
  private seen = new Map<string, string>();

  public static getInstance(): IntroStore {
    if (!IntroStore.instance) IntroStore.instance = new IntroStore();
    return IntroStore.instance;
  }

  public init(filePath: string) {
    this.filePath = filePath;
    this.seen.clear();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data && typeof data === 'object') {
        for (const [addr, when] of Object.entries(data)) {
          if (typeof when === 'string') this.seen.set(addr, when);
        }
      }
    } catch (e) {
      // first run or unreadable file: nobody has seen the intro yet
    }
  }

  public hasSeen(address: string): boolean {
    return !!address && this.seen.has(address);
  }

  public markSeen(address: string) {
    if (!address) return;
    this.seen.delete(address);
    this.seen.set(address, new Date().toISOString());
    while (this.seen.size > MAX_ENTRIES) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.save();
  }

  private save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.seen), null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {
      console.error('[IntroStore] Could not save:', e);
    }
  }
}
