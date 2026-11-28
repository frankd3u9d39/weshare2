/*
 * Whether this computer's Weshare is paid up (or in its free trial). When it isn't, phones and
 * other computers can't connect to it or send it files. The computer itself (loopback) is never
 * blocked, so its own window keeps working enough to show the pay screen.
 */
let active = true;
const listeners = new Set<(active: boolean) => void>();

export const isAccessActive = () => active;

export function setAccessActive(value: boolean) {
  if (value === active) return;
  active = value;
  for (const fn of listeners) {
    try { fn(value); } catch (e) {}
  }
}

export function onAccessChange(fn: (active: boolean) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const ACCESS_ENDED_MESSAGE = "This computer's Weshare week has ended. Ask the staff to renew it, then try again.";
