import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FIREBASE_CONFIG } from '../services/firebaseConfig';
import { BILLING_API_URL, LICENSE_PUBLIC_KEY, isBillingEnabled } from '../services/billingConfig';
import { setAccessActive } from '../services/accessGate';

/*
 * The Weshare account on this computer: sign-in (Firebase email/password), the 3-day trial and
 * the weekly ₦1,000 access bought through Paystack.
 *
 * The server hands back a signed "access pass" with the trial and paid-until dates. It is saved
 * here and checked with the public key, so a café PC keeps working for the whole paid week even
 * when the internet is down, and editing the file can't extend it.
 */

type Pass = { uid: string; email: string; trialEndsAt: number; paidUntil: number; machine: string; issuedAt: number };

export type AccountState = {
  billing: boolean;           // false = payments not set up yet; everything is open
  signedIn: boolean;
  email: string;
  status: 'open' | 'signed-out' | 'checking' | 'trial' | 'paid' | 'expired';
  endsAt: number;             // when the current trial or paid week ends (ms)
  trialEndsAt: number;
  paidUntil: number;
  offline: boolean;           // couldn't reach the server on the last check
  adminDevice: boolean;
};

type Saved = { uid: string; email: string; refreshToken: string };

const REFRESH_EVERY_MS = 30 * 60 * 1000;
const FIREBASE_KEY = encodeURIComponent(FIREBASE_CONFIG.apiKey);

let getWindow: () => BrowserWindow | null = () => null;
let saved: Saved | null = null;
let pass: Pass | null = null;
let idToken: { value: string; expires: number } | null = null;
let offline = false;
let checking = false;
let machineId = '';
let latestSeenTime = 0;
let timer: NodeJS.Timeout | null = null;

const dataFile = (name: string) => path.join(app.getPath('userData'), name);
const isAdminDevice = () => fs.existsSync(dataFile('admin-device'));

// ---------- Saving (the refresh token is encrypted with Windows' own data protection) ----------
function loadSaved() {
  try {
    const raw = fs.readFileSync(dataFile('account.dat'));
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    const s = JSON.parse(text);
    if (s && typeof s.refreshToken === 'string' && typeof s.uid === 'string') saved = s;
  } catch (e) {
    saved = null;
  }
  try {
    pass = readPass(fs.readFileSync(dataFile('access-pass.txt'), 'utf8').trim());
  } catch (e) {
    pass = null;
  }
  try {
    latestSeenTime = Number(fs.readFileSync(dataFile('access-clock.txt'), 'utf8')) || 0;
  } catch (e) {}
}

function storeSaved(s: Saved | null) {
  saved = s;
  try {
    if (!s) {
      fs.rmSync(dataFile('account.dat'), { force: true });
      return;
    }
    const text = JSON.stringify(s);
    fs.writeFileSync(dataFile('account.dat'), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text));
  } catch (e) {
    console.error('[Account] Could not save sign-in:', e);
  }
}

function storePass(token: string | null) {
  try {
    if (token) fs.writeFileSync(dataFile('access-pass.txt'), token);
    else fs.rmSync(dataFile('access-pass.txt'), { force: true });
  } catch (e) {}
}

// ---------- Access pass ----------
const fromB64url = (v: string) => Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const machineHash = () => crypto.createHash('sha256').update(`weshare-machine:${machineId}`).digest('hex');

export function readPass(token: string): Pass | null {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = crypto.verify(null, Buffer.from(body), crypto.createPublicKey(LICENSE_PUBLIC_KEY), fromB64url(sig));
    if (!ok) return null;
    const p = JSON.parse(fromB64url(body).toString('utf8'));
    if (!p || typeof p.uid !== 'string') return null;
    return p;
  } catch (e) {
    return null;
  }
}

// The clock can't be wound back to stretch a week: the latest time this PC has seen is used.
function now() {
  const t = Math.max(Date.now(), latestSeenTime, pass?.issuedAt || 0);
  if (t > latestSeenTime + 60000) {
    latestSeenTime = t;
    try { fs.writeFileSync(dataFile('access-clock.txt'), String(t)); } catch (e) {}
  }
  return t;
}

export function getAccountState(): AccountState {
  const base = {
    billing: isBillingEnabled(),
    signedIn: !!saved,
    email: saved?.email || '',
    trialEndsAt: 0,
    paidUntil: 0,
    endsAt: 0,
    offline,
    adminDevice: isAdminDevice()
  };
  if (!base.billing || base.adminDevice) return { ...base, status: 'open' };
  if (!saved) return { ...base, status: 'signed-out' };

  const usable = pass && pass.uid === saved.uid && (!pass.machine || pass.machine === machineHash()) ? pass : null;
  if (!usable) return { ...base, status: checking ? 'checking' : 'expired' };

  const t = now();
  const info = { ...base, trialEndsAt: usable.trialEndsAt, paidUntil: usable.paidUntil };
  if (usable.paidUntil > t) return { ...info, status: 'paid', endsAt: usable.paidUntil };
  if (usable.trialEndsAt > t) return { ...info, status: 'trial', endsAt: usable.trialEndsAt };
  return { ...info, status: 'expired', endsAt: Math.max(usable.paidUntil, usable.trialEndsAt) };
}

function publish() {
  const state = getAccountState();
  setAccessActive(state.status === 'open' || state.status === 'trial' || state.status === 'paid');
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('account-updated', state);
  return state;
}

// ---------- Firebase sign-in ----------
const FRIENDLY: Record<string, string> = {
  EMAIL_EXISTS: 'An account with this email already exists. Sign in instead.',
  INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
  INVALID_PASSWORD: 'Wrong email or password.',
  EMAIL_NOT_FOUND: 'Wrong email or password.',
  INVALID_EMAIL: 'That email address is not valid.',
  WEAK_PASSWORD: 'Use a password of at least 6 characters.',
  MISSING_PASSWORD: 'Type a password.',
  USER_DISABLED: 'This account has been turned off.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again in a few minutes.',
  OPERATION_NOT_ALLOWED: 'Email sign-in is not turned on in Firebase Authentication.'
};

async function firebaseCall(endpoint: string, body: object) {
  let r: Response;
  try {
    r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${FIREBASE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error('No internet connection. Connect to the internet and try again.');
  }
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = String(json?.error?.message || '').split(' ')[0].split(':')[0];
    throw new Error(FRIENDLY[code] || 'Sign-in failed. Try again.');
  }
  return json;
}

async function currentIdToken(): Promise<string> {
  if (!saved) throw new Error('Sign in first.');
  if (idToken && idToken.expires > Date.now() + 60000) return idToken.value;
  let r: Response;
  try {
    r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refreshToken })
    });
  } catch (e) {
    throw Object.assign(new Error('offline'), { offline: true });
  }
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    // The account was deleted/disabled or the password changed: sign out.
    if (r.status === 400 || r.status === 401) {
      storeSaved(null);
      storePass(null);
      pass = null;
      publish();
    }
    throw new Error('Sign in again.');
  }
  idToken = { value: json.id_token, expires: Date.now() + Number(json.expires_in || 3600) * 1000 };
  if (json.refresh_token && json.refresh_token !== saved.refreshToken) storeSaved({ ...saved, refreshToken: json.refresh_token });
  return idToken.value;
}

// ---------- Weshare payment server ----------
async function billingCall(route: string, body: object) {
  let r: Response;
  try {
    r = await fetch(`${BILLING_API_URL.replace(/\/+$/, '')}/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw Object.assign(new Error('No internet connection. Connect to the internet and try again.'), { offline: true });
  }
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || 'The Weshare server did not answer. Try again.');
  return json;
}

function acceptPass(token: unknown) {
  const p = typeof token === 'string' ? readPass(token) : null;
  if (!p) throw new Error('The server sent an access pass Weshare could not check.');
  pass = p;
  storePass(token as string);
}

/** Asks the server for this account's dates. Keeps the saved pass if offline. */
export async function refreshAccess(): Promise<AccountState> {
  if (!isBillingEnabled() || !saved) return publish();
  checking = true;
  publish();
  try {
    const result = await billingCall('access', { idToken: await currentIdToken(), machine: machineId });
    acceptPass(result.pass);
    offline = false;
  } catch (e: any) {
    offline = !!e?.offline;
    if (!offline) console.error('[Account] Access check failed:', e?.message || e);
  } finally {
    checking = false;
  }
  return publish();
}

async function signInWith(endpoint: 'signUp' | 'signInWithPassword', email: string, password: string) {
  if (typeof email !== 'string' || typeof password !== 'string') throw new Error('Type your email and password.');
  const result = await firebaseCall(endpoint, { email: email.trim(), password, returnSecureToken: true });
  storeSaved({ uid: result.localId, email: result.email, refreshToken: result.refreshToken });
  idToken = { value: result.idToken, expires: Date.now() + Number(result.expiresIn || 3600) * 1000 };
  if (pass && pass.uid !== result.localId) {
    pass = null;
    storePass(null);
  }
  return refreshAccess();
}

// ---------- Paystack checkout window ----------
let payWindow: BrowserWindow | null = null;

async function buyWeek(): Promise<{ paid: boolean; state: AccountState; message?: string }> {
  if (payWindow && !payWindow.isDestroyed()) {
    payWindow.focus();
    return { paid: false, state: getAccountState(), message: 'The payment window is already open.' };
  }
  const start = await billingCall('pay/start', { idToken: await currentIdToken() });
  const reference: string = start.reference;
  const doneUrl = `${BILLING_API_URL.replace(/\/+$/, '')}/api/pay/done`;

  // Paystack's own checkout page: the customer types card or bank details there, never into Weshare.
  await new Promise<void>((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent: getWindow() || undefined,
      modal: false,
      title: 'Pay for Weshare · Paystack',
      icon: path.join(__dirname, 'logo.png'),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'paystack-checkout' }
    });
    payWindow = win;
    const finish = (url: string) => {
      if (url.startsWith(doneUrl) && !win.isDestroyed()) win.close();
    };
    win.webContents.on('will-redirect', (_e, url) => finish(url));
    win.webContents.on('did-navigate', (_e, url) => finish(url));
    // Links that open new windows (e.g. bank pages) stay inside the checkout window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    win.on('closed', () => {
      payWindow = null;
      resolve();
    });
    win.loadURL(start.authorizationUrl).catch(() => {});
  });

  // Whether the window closed by itself or the customer closed it, ask Paystack what happened.
  try {
    const result = await billingCall('pay/verify', { idToken: await currentIdToken(), reference, machine: machineId });
    if (result.paid) {
      acceptPass(result.pass);
      offline = false;
      return { paid: true, state: publish() };
    }
    return { paid: false, state: publish(), message: result.status === 'abandoned' || !result.status ? 'Payment not finished.' : `Payment ${result.status}.` };
  } catch (e: any) {
    return { paid: false, state: publish(), message: e?.message || 'Could not check the payment. If you paid, it will show within a few minutes.' };
  }
}

// ---------- Computer id: stops new emails on the same PC from getting new free trials ----------
function loadMachineId(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = () => {
      const file = dataFile('machine-id');
      try {
        machineId = fs.readFileSync(file, 'utf8').trim();
      } catch (e) {}
      if (!machineId) {
        machineId = crypto.randomUUID();
        try { fs.writeFileSync(file, machineId); } catch (e) {}
      }
      resolve();
    };
    if (process.platform !== 'win32') return fallback();
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true }, (err, out) => {
      const m = !err && /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{20,})/.exec(out || '');
      if (m) {
        machineId = m[1].toLowerCase();
        resolve();
      } else {
        fallback();
      }
    });
  });
}

// ---------- Setup ----------
let initialized = false;
export async function initAccount(windowGetter: () => BrowserWindow | null) {
  getWindow = windowGetter;
  if (initialized) return;
  initialized = true;
  loadSaved();
  await loadMachineId();
  publish();

  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return { ok: true, ...(await fn() as any) };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Something went wrong.', state: getAccountState() };
    }
  };

  ipcMain.handle('account-get', () => getAccountState());
  ipcMain.handle('account-refresh', () => wrap(async () => ({ state: await refreshAccess() })));
  ipcMain.handle('account-sign-up', (_e, email, password) => wrap(async () => ({ state: await signInWith('signUp', email, password) })));
  ipcMain.handle('account-sign-in', (_e, email, password) => wrap(async () => ({ state: await signInWith('signInWithPassword', email, password) })));
  ipcMain.handle('account-reset-password', (_e, email) =>
    wrap(async () => {
      await firebaseCall('sendOobCode', { requestType: 'PASSWORD_RESET', email: String(email || '').trim() });
      return {};
    })
  );
  ipcMain.handle('account-sign-out', () => {
    storeSaved(null);
    storePass(null);
    pass = null;
    idToken = null;
    return publish();
  });
  ipcMain.handle('account-buy-week', () => wrap(() => buyWeek()));

  // Check with the server now and every 30 minutes; re-check the clock every minute so the
  // app locks itself the moment a week or trial runs out.
  refreshAccess();
  if (timer) clearInterval(timer);
  let ticks = 0;
  timer = setInterval(() => {
    ticks++;
    if (ticks % (REFRESH_EVERY_MS / 60000) === 0) refreshAccess();
    else publish();
  }, 60000);
}
