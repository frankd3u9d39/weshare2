import React, { useEffect, useRef, useState } from 'react';
import { Lock, Mail, KeyRound, LogOut, RefreshCw, CreditCard, Check, WifiOff, ShieldCheck } from 'lucide-react';
import type { AccountState } from '../electron.d';
import LogoImg from '../logo.png';

/*
 * Weekly access on the desktop app: sign in (or create an account, which starts the 3-day free
 * trial), and once the trial or paid week runs out, a screen to pay ₦1,000 for 7 more days.
 * Payment happens on Paystack's own page in a separate window.
 */

const PRICE = '₦1,000';

const formatDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export const timeLeft = (ms: number) => {
  const left = ms - Date.now();
  if (left <= 0) return 'ended';
  const hours = Math.floor(left / 3600000);
  if (hours >= 48) return `${Math.floor(hours / 24)} days left`;
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`;
  return `${Math.max(1, Math.ceil(left / 60000))} min left`;
};

/** Keeps the account state in sync with the main process. */
export function useAccount(enabled: boolean) {
  const [account, setAccount] = useState<AccountState | null>(null);
  useEffect(() => {
    if (!enabled || !window.electronAPI?.getAccount) return;
    window.electronAPI.getAccount().then(setAccount).catch(() => {});
    return window.electronAPI.onAccountUpdated(setAccount);
  }, [enabled]);
  return account;
}

export const accountBlocksApp = (a: AccountState | null) =>
  !!a && a.billing && (a.status === 'signed-out' || a.status === 'expired' || a.status === 'checking');

// ---------- Shared frame ----------
const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 16px', background: 'var(--bg-base)', overflowY: 'auto' }}>
    <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', padding: '32px 28px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <img src={LogoImg} alt="" style={{ width: '26px', height: '26px' }} />
        <span style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '15px', letterSpacing: '0.02em', textTransform: 'uppercase' }}>Weshare</span>
      </div>
      {children}
    </div>
  </div>
);

const fieldStyle: React.CSSProperties = {
  padding: '11px 12px', fontSize: '14px', width: '100%', boxSizing: 'border-box',
  background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--line-2)', outline: 'none'
};
const ErrorLine: React.FC<{ text: string }> = ({ text }) =>
  text ? <span role="alert" style={{ fontSize: '12.5px', color: 'var(--error)', lineHeight: 1.45 }}>{text}</span> : null;

// ---------- Sign in / create account ----------
export const AccountScreen: React.FC = () => {
  const [mode, setMode] = useState<'sign-in' | 'sign-up' | 'reset'>('sign-up');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setInfo('');
    const api = window.electronAPI;
    const result =
      mode === 'sign-up' ? await api.signUp(email, password) :
      mode === 'sign-in' ? await api.signIn(email, password) :
      await api.resetPassword(email);
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'That did not work.');
    } else if (mode === 'reset') {
      setInfo('Check your email for a link to set a new password, then sign in.');
      setMode('sign-in');
    }
  };

  return (
    <Frame>
      <div>
        <span className="mono-label">{mode === 'sign-up' ? 'Create account' : mode === 'sign-in' ? 'Sign in' : 'Reset password'}</span>
        <h2 style={{ fontSize: '24px', marginTop: '6px', fontFamily: 'var(--font-title)' }}>
          {mode === 'sign-up' ? 'Start your free 3 days' : mode === 'sign-in' ? 'Welcome back' : 'Forgot your password?'}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: 1.55, marginTop: '8px' }}>
          {mode === 'sign-up'
            ? `Everything in Weshare is free for 3 days. After that it's ${PRICE} for 7 days. Your account works on any computer.`
            : mode === 'sign-in'
              ? 'Sign in to use your Weshare account on this computer.'
              : "Type your account's email and we'll send you a link to set a new password."}
        </p>
      </div>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <label className="mono-label" htmlFor="acct-email" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Mail size={12} /> Email</label>
        <input id="acct-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={fieldStyle} required />
        {mode !== 'reset' && (
          <>
            <label className="mono-label" htmlFor="acct-password" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><KeyRound size={12} /> Password</label>
            <input
              id="acct-password"
              type="password"
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={fieldStyle}
              minLength={6}
              required
            />
            {mode === 'sign-up' && <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>At least 6 characters.</span>}
          </>
        )}
        <ErrorLine text={error} />
        {info && <span role="status" style={{ fontSize: '12.5px', color: 'var(--success)', lineHeight: 1.45 }}>{info}</span>}
        <button type="submit" className="interactive-btn primary" disabled={busy} style={{ padding: '12px', marginTop: '4px' }}>
          {busy ? 'Please wait…' : mode === 'sign-up' ? 'Create account · start free trial' : mode === 'sign-in' ? 'Sign in' : 'Send reset link'}
        </button>
      </form>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
        {mode !== 'sign-in' && (
          <span>Already have an account? <button className="link-btn" onClick={() => { setMode('sign-in'); setError(''); }}>Sign in</button></span>
        )}
        {mode !== 'sign-up' && (
          <span>New to Weshare? <button className="link-btn" onClick={() => { setMode('sign-up'); setError(''); }}>Create an account</button></span>
        )}
        {mode === 'sign-in' && (
          <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => { setMode('reset'); setError(''); }}>Forgot password?</button>
        )}
      </div>
    </Frame>
  );
};

// ---------- Pay for a week ----------
export const PayScreen: React.FC<{ account: AccountState }> = ({ account }) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (account.status === 'checking') {
    return (
      <Frame>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--text-secondary)' }}>
          <RefreshCw size={16} style={{ animation: 'ring-spin 1.5s linear infinite' }} /> Checking your account…
        </div>
      </Frame>
    );
  }

  const neverChecked = !account.trialEndsAt && !account.paidUntil;
  const hadTrialOnly = account.paidUntil === 0 && account.trialEndsAt > 0;

  const pay = async () => {
    setBusy(true);
    setError('');
    setMessage('Paystack is opening in a new window…');
    const result = await window.electronAPI.buyWeek();
    setBusy(false);
    setMessage('');
    if (!result.ok) setError(result.error || 'The payment could not start.');
    else if (!result.paid) setMessage(result.message || 'Payment not finished.');
  };

  const checkAgain = async () => {
    setBusy(true);
    setError('');
    const result = await window.electronAPI.refreshAccount();
    setBusy(false);
    if (!result.ok) setError(result.error || 'Could not check.');
    else if (result.state?.offline) setError('No internet connection. Connect and try again.');
    else if (result.state?.status === 'expired') setMessage('No payment found yet. If you just paid, wait a minute and check again.');
  };

  return (
    <Frame>
      {neverChecked && account.offline ? (
        <div>
          <span className="mono-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><WifiOff size={12} /> Offline</span>
          <h2 style={{ fontSize: '22px', marginTop: '6px', fontFamily: 'var(--font-title)' }}>Connect to the internet once</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: 1.55, marginTop: '8px' }}>
            Weshare needs the internet to start your account on this computer. After that, a paid week keeps working even when the internet is off.
          </p>
        </div>
      ) : (
        <div>
          <span className="mono-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Lock size={12} /> {hadTrialOnly ? 'Free trial ended' : 'Week ended'}</span>
          <h2 style={{ fontSize: '24px', marginTop: '6px', fontFamily: 'var(--font-title)' }}>Keep using Weshare</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: 1.55, marginTop: '8px' }}>
            {hadTrialOnly ? 'Your 3 free days are over.' : 'Your paid week is over.'} Pay {PRICE} to unlock everything for the next 7 days, on any computer you sign in to.
          </p>
        </div>
      )}

      <div style={{ border: '1px solid var(--line-2)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ whiteSpace: 'nowrap' }}>
          <span style={{ fontFamily: 'var(--font-title)', fontSize: '28px', fontWeight: 800 }}>{PRICE}</span>
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}> for 7 days</span>
        </div>
        <span className="mono-label">Card · Bank transfer · USSD</span>
      </div>

      <button className="interactive-btn primary" onClick={pay} disabled={busy} style={{ padding: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
        <CreditCard size={15} /> {busy ? 'Waiting for payment…' : `Pay ${PRICE} with Paystack`}
      </button>
      <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.5, display: 'flex', gap: '6px' }}>
        <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
        You pay on Paystack's secure page. Weshare never sees your card or bank details.
      </span>

      {message && <span role="status" style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{message}</span>}
      <ErrorLine text={error} />

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{account.email}</span>
        <div style={{ display: 'flex', gap: '14px' }}>
          <button className="link-btn" onClick={checkAgain} disabled={busy}>I already paid · check</button>
          <button className="link-btn" onClick={() => window.electronAPI.signOut()}>Sign out</button>
        </div>
      </div>
    </Frame>
  );
};

// ---------- Header badge + account menu ----------
export const AccountBadge: React.FC<{ account: AccountState }> = ({ account }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!account.billing || account.status === 'open') return null;
  const trial = account.status === 'trial';
  const soon = account.endsAt - Date.now() < 24 * 3600000;

  const extend = async () => {
    setBusy(true);
    setNote('');
    const result = await window.electronAPI.buyWeek();
    setBusy(false);
    if (!result.ok) setNote(result.error || 'The payment could not start.');
    else if (result.paid) setNote('Thanks! 7 days added.');
    else setNote(result.message || 'Payment not finished.');
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="connection-status-badge"
        title="Your Weshare account"
        style={{ cursor: 'pointer', color: soon ? 'var(--warning)' : trial ? 'var(--primary-light)' : 'var(--success)', display: 'flex', alignItems: 'center', gap: '6px' }}
      >
        {trial ? 'Free trial' : 'Active'} · {timeLeft(account.endsAt)}
      </button>
      {open && (
        <div className="glass-panel" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: '290px', padding: '16px', zIndex: 50, display: 'flex', flexDirection: 'column', gap: '12px', background: 'var(--bg-card)' }}>
          <div>
            <span className="mono-label">Signed in as</span>
            <div style={{ fontSize: '13.5px', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{account.email}</div>
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {trial ? 'Free trial' : 'Paid week'} ends <strong style={{ color: 'var(--text-primary)' }}>{formatDate(account.endsAt)}</strong>.
            {account.offline && <span style={{ display: 'block', color: 'var(--text-muted)' }}>Offline · will re-check when the internet is back.</span>}
          </div>
          <button className="interactive-btn primary" onClick={extend} disabled={busy} style={{ padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            {busy ? 'Waiting for payment…' : <><CreditCard size={14} /> {trial ? `Pay ${PRICE} now · 7 days` : `Add 7 days · ${PRICE}`}</>}
          </button>
          {!trial && <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>Paying early adds 7 days after your current week.</span>}
          {note && <span role="status" style={{ fontSize: '12px', color: note.startsWith('Thanks') ? 'var(--success)' : 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center' }}>{note.startsWith('Thanks') && <Check size={13} />}{note}</span>}
          <button className="interactive-btn" onClick={() => window.electronAPI.signOut()} style={{ padding: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
};
