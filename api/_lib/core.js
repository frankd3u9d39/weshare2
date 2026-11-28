// Shared code for Weshare's payment API (Vercel serverless functions, no extra packages).
//
// Environment variables (set them in Vercel -> Project -> Settings -> Environment Variables):
//   PAYSTACK_SECRET_KEY       sk_test_... while testing, sk_live_... when live. Never put it in the app.
//   FIREBASE_SERVICE_ACCOUNT  the whole JSON file from Firebase -> Project settings -> Service accounts.
//   LICENSE_PRIVATE_KEY       the Ed25519 private key (PEM) that signs access passes. The desktop app
//                             holds only the matching public key, so passes can't be faked.
//   SITE_URL                  optional, e.g. https://weshare.vercel.app (used for Paystack's return page).
//   FIREBASE_API_KEY          optional; defaults to the project's public web key.
const crypto = require('crypto');

const PRICE_KOBO = 100000; // ₦1,000
const CURRENCY = 'NGN';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TRIAL_MS = 3 * 24 * 60 * 60 * 1000;
const PROJECT_ID = 'weshare-83260';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyD7NA0TlavIftqqD62vTgcJeVs8VTWt54U';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- HTTP helpers ----------
async function readBody(req) {
  let raw = '';
  try {
    for await (const chunk of req) raw += chunk;
  } catch (e) {}
  if (!raw && req.body) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  let json = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw new HttpError(400, 'Bad request');
  }
  return { raw, json };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function handler(fn) {
  return async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    try {
      await fn(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'Something went wrong. Try again.' : e.message });
    }
  };
}

// ---------- Who is calling: a Firebase sign-in token from the app ----------
async function userFromIdToken(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 20) throw new HttpError(401, 'Sign in again.');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!r.ok) throw new HttpError(401, 'Sign in again.');
  const user = (await r.json()).users?.[0];
  if (!user?.localId || !user.email) throw new HttpError(401, 'Sign in again.');
  return { uid: user.localId, email: user.email };
}

// ---------- Firestore with the service account (bypasses the public rules) ----------
let cachedToken = null;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function googleAccessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  let sa;
  try {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is missing or not valid JSON');
  }
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` })
  });
  if (!r.ok) throw new Error(`Google token failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  cachedToken = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

async function firestore(pathAndQuery, method = 'GET', body) {
  const r = await fetch(`${FIRESTORE}${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${await googleAccessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 404) return null;
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Firestore ${method} ${pathAndQuery.split('?')[0]} failed: ${r.status} ${text.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// Plain values <-> Firestore field values (numbers are whole milliseconds or kobo).
const toFields = (obj) => {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') fields[k] = { integerValue: String(Math.round(v)) };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else fields[k] = { stringValue: String(v ?? '') };
  }
  return fields;
};
const fromFields = (doc) => {
  const out = {};
  for (const [k, v] of Object.entries(doc?.fields || {})) {
    if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('doubleValue' in v) out[k] = Number(v.doubleValue);
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else out[k] = v.stringValue ?? '';
  }
  return out;
};
const docName = (rel) => `projects/${PROJECT_ID}/databases/(default)/documents/${rel}`;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// ---------- Accounts ----------
// The first time an account is seen it gets a 3-day trial, unless this computer already gave
// a trial to another account (so making new emails on the same PC doesn't give more free days).
async function getOrCreateAccount(uid, email, machine) {
  const existing = await firestore(`/users/${uid}`);
  if (existing) return fromFields(existing);

  const now = Date.now();
  let trialEndsAt = now + TRIAL_MS;
  const machineKey = machine ? sha256(`weshare-machine:${machine}`) : '';
  if (machineKey) {
    const m = await firestore(`/machines/${machineKey}`);
    if (m && fromFields(m).trialUid !== uid) trialEndsAt = now;
  }
  const account = { email, createdAt: now, trialEndsAt, paidUntil: 0 };
  const writes = [{ update: { name: docName(`users/${uid}`), fields: toFields(account) }, currentDocument: { exists: false } }];
  if (machineKey && trialEndsAt > now) {
    writes.push({ update: { name: docName(`machines/${machineKey}`), fields: toFields({ trialUid: uid, at: now }) } });
  }
  try {
    await firestore(':commit', 'POST', { writes });
  } catch (e) {
    // Made at the same moment by another request: use that one.
    if (e.status === 409 || e.status === 400) {
      const again = await firestore(`/users/${uid}`);
      if (again) return fromFields(again);
    }
    throw e;
  }
  return account;
}

// Adds a week for a confirmed Paystack payment. Each payment reference counts once,
// even if the app and Paystack's webhook both report it.
async function creditPayment(reference, uid, paystack) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { transaction } = await firestore(':beginTransaction', 'POST', {});
    const t = encodeURIComponent(transaction);
    const paid = await firestore(`/payments/${encodeURIComponent(reference)}?transaction=${t}`);
    if (paid) {
      await firestore(':rollback', 'POST', { transaction });
      return { credited: false };
    }
    const userDoc = await firestore(`/users/${uid}?transaction=${t}`);
    const user = userDoc ? fromFields(userDoc) : { email: paystack.email, createdAt: Date.now(), trialEndsAt: Date.now(), paidUntil: 0 };
    const now = Date.now();
    // A week bought early starts when the current week or free trial ends, so no days are lost.
    const paidUntil = Math.max(now, user.paidUntil || 0, user.trialEndsAt || 0) + WEEK_MS;
    try {
      await firestore(':commit', 'POST', {
        transaction,
        writes: [
          {
            update: {
              name: docName(`payments/${reference}`),
              fields: toFields({ uid, email: paystack.email, amount: paystack.amount, currency: paystack.currency, paidAt: now, weekEndsAt: paidUntil })
            },
            currentDocument: { exists: false }
          },
          { update: { name: docName(`users/${uid}`), fields: toFields({ ...user, paidUntil, updatedAt: now }) } }
        ]
      });
      return { credited: true, paidUntil };
    } catch (e) {
      if (e.status !== 409 && e.status !== 400 && e.status !== 412) throw e; // retry on contention
    }
  }
  throw new Error('Could not save the payment after several tries');
}

// ---------- Paystack ----------
async function paystack(pathname, method = 'GET', body) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY is not set');
  const r = await fetch(`https://api.paystack.co${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.status === false) {
    const err = new HttpError(r.status === 404 ? 404 : 502, json.message || 'Paystack did not answer. Try again.');
    throw err;
  }
  return json.data;
}

// Asks Paystack directly whether a payment really went through (never trusts the caller).
async function confirmPayment(reference) {
  if (typeof reference !== 'string' || !/^[A-Za-z0-9_.=-]{6,100}$/.test(reference)) throw new HttpError(400, 'Bad payment reference');
  const data = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  const ok = data.status === 'success' && data.currency === CURRENCY && Number(data.amount) >= PRICE_KOBO;
  const uid = data.metadata?.uid || '';
  return { ok, uid, status: data.status, email: data.customer?.email || '', amount: Number(data.amount), currency: data.currency };
}

// ---------- Access pass: signed, so a café PC keeps working offline for the paid week ----------
function signPass(account, uid, machine) {
  const key = process.env.LICENSE_PRIVATE_KEY;
  if (!key) throw new Error('LICENSE_PRIVATE_KEY is not set');
  const payload = {
    v: 1,
    uid,
    email: account.email,
    trialEndsAt: account.trialEndsAt || 0,
    paidUntil: account.paidUntil || 0,
    machine: machine ? sha256(`weshare-machine:${machine}`) : '',
    issuedAt: Date.now()
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(key.replace(/\\n/g, '\n'))));
  return { pass: `${body}.${sig}`, account: { email: account.email, trialEndsAt: payload.trialEndsAt, paidUntil: payload.paidUntil } };
}

module.exports = {
  PRICE_KOBO, CURRENCY, WEEK_MS, HttpError, readBody, send, handler,
  userFromIdToken, getOrCreateAccount, creditPayment, paystack, confirmPayment, signPass, firestore, fromFields
};
