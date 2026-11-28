import { FIREBASE_CONFIG, TELEMETRY_COLLECTION, firestoreDocumentsUrl, isFirebaseConfigured } from '../services/firebaseConfig';

/*
 * Admin console access to Firebase over its REST API (no SDK needed):
 * email/password sign-in, token refresh, the admin check and reading transfer stats.
 * The sign-in is kept in sessionStorage, so it ends when the browser tab is closed.
 */

export { isFirebaseConfigured };

export interface TelemetryRecord {
  id: string;
  transfer_id: string;
  file_size: number;
  file_type: string;
  sender_os: string;
  receiver_os: string;
  status: 'completed' | 'failed';
  speed_bytes_sec: number;
  duration_sec: number;
  error_message: string;
  app_version: string;
  created_at: string;
}

interface Session {
  uid: string;
  email: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

const SESSION_KEY = 'weshare_admin_session';
const key = () => encodeURIComponent(FIREBASE_CONFIG.apiKey);

let session: Session | null = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    return saved && typeof saved.refreshToken === 'string' ? saved : null;
  } catch {
    return null;
  }
})();

const storeSession = (s: Session | null) => {
  session = s;
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {}
};

const FRIENDLY_ERRORS: Record<string, string> = {
  INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
  INVALID_PASSWORD: 'Wrong email or password.',
  EMAIL_NOT_FOUND: 'Wrong email or password.',
  INVALID_EMAIL: 'That email address is not valid.',
  USER_DISABLED: 'This account has been turned off in Firebase.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again in a few minutes.',
  OPERATION_NOT_ALLOWED: 'Email/password sign-in is not turned on in Firebase Authentication.'
};

async function firebaseError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json();
    const code = String(body?.error?.message || '').split(' ')[0];
    return new Error(FRIENDLY_ERRORS[code] || body?.error?.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export const currentAdminEmail = () => session?.email || '';
export const hasSession = () => !!session;

export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  if (!res.ok) throw await firebaseError(res, 'Sign-in failed.');
  const data = await res.json();
  storeSession({
    uid: data.localId,
    email: data.email,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000
  });
}

export function signOut() {
  storeSession(null);
}

async function idToken(): Promise<string> {
  if (!session) throw new Error('Not signed in.');
  if (Date.now() < session.expiresAt - 60_000) return session.idToken;
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${key()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
  });
  if (!res.ok) {
    storeSession(null);
    throw await firebaseError(res, 'Your sign-in expired. Sign in again.');
  }
  const data = await res.json();
  storeSession({
    ...session,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
  });
  return session!.idToken;
}

/** True when the signed-in account has a document in the `admins` collection. */
export async function isAdmin(): Promise<boolean> {
  if (!session) return false;
  const res = await fetch(`${firestoreDocumentsUrl()}/admins/${encodeURIComponent(session.uid)}`, {
    headers: { Authorization: `Bearer ${await idToken()}` }
  });
  if (res.ok) return true;
  if (res.status === 403 || res.status === 404) return false;
  throw await firebaseError(res, 'Could not check admin access.');
}

const fieldValue = (f: any): any => {
  if (!f) return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return Number(f.doubleValue);
  if ('timestampValue' in f) return f.timestampValue;
  if ('booleanValue' in f) return f.booleanValue;
  return undefined;
};

/** Newest stats first. */
export async function loadTelemetry(limit = 5000): Promise<TelemetryRecord[]> {
  const res = await fetch(`${firestoreDocumentsUrl()}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await idToken()}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: TELEMETRY_COLLECTION }],
        orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
        limit
      }
    })
  });
  if (!res.ok) throw await firebaseError(res, 'Could not load transfer stats.');
  const rows: any[] = await res.json();
  return rows
    .filter((row) => row.document)
    .map((row) => {
      const f = row.document.fields || {};
      const get = (name: string) => fieldValue(f[name]);
      return {
        id: String(row.document.name).split('/').pop() || '',
        transfer_id: get('transfer_id') || '',
        file_size: get('file_size') || 0,
        file_type: get('file_type') || 'unknown',
        sender_os: get('sender_os') || 'Unknown',
        receiver_os: get('receiver_os') || 'Unknown',
        status: get('status') === 'completed' ? 'completed' : 'failed',
        speed_bytes_sec: get('speed_bytes_sec') || 0,
        duration_sec: get('duration_sec') || 0,
        error_message: get('error_message') || '',
        app_version: get('app_version') || '',
        created_at: get('created_at') || ''
      } as TelemetryRecord;
    });
}
