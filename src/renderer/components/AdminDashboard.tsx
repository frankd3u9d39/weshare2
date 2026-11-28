import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { TelemetryRecord, signIn, signOut, isAdmin, loadTelemetry, hasSession, currentAdminEmail, isFirebaseConfigured } from '../firebaseAdmin';
import {
  BarChart3, Database, LogIn, LogOut, ShieldAlert,
  CheckCircle, RefreshCw,
  FileSpreadsheet, Monitor, Smartphone,
  ArrowUpRight, Clock, Eye, EyeOff,
  ChevronLeft, ChevronRight, ArrowUpDown
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatSize, formatSpeed, normalizeExt, csvCell } from '../utils/format';
import { Toast, ToastState } from './Toast';

const ROWS_PER_PAGE = 25;
const CHART_SLOTS = 4;

// Bar fill classes cycled through for the dynamic file-type chart.
const CHART_FILL_CLASSES = [
  'chart-bar-fill-primary',
  'chart-bar-fill-secondary',
  'chart-bar-fill-tertiary',
  'chart-bar-fill-other'
];

type SortKey = 'created_at' | 'file_size' | 'speed_bytes_sec' | 'file_type';
type TabId = 'analytics' | 'audit';

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'analytics', label: 'Overview Analytics', icon: BarChart3 },
  { id: 'audit', label: 'Transfer Audit Logs', icon: Database }
];

// Stats are anonymous, so a "file" is shown by its type.
const fileLabel = (r: TelemetryRecord) => {
  const ext = normalizeExt(r.file_type);
  return ext === 'unknown' ? 'File (no extension)' : `.${ext.toUpperCase()} file`;
};

export const AdminDashboard: React.FC = () => {
  const configured = isFirebaseConfigured();

  // Auth State
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [checkingSession, setCheckingSession] = useState(hasSession());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Tab State
  const [activeTab, setActiveTab] = useState<TabId>('analytics');

  // Dashboard Data
  const [records, setRecords] = useState<TelemetryRecord[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Audit filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(0);

  // UI state
  const [showPassword, setShowPassword] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [loadError, setLoadError] = useState('');

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ message, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // Signs in to Firebase and checks the account is listed in the admins collection.
  const confirmAdmin = useCallback(async () => {
    if (await isAdmin()) {
      setIsLoggedIn(true);
      return true;
    }
    signOut();
    setIsLoggedIn(false);
    setAuthError('This account is not an admin. Add its user ID to the admins collection in Firestore.');
    return false;
  }, []);

  // A sign-in kept from earlier in this tab
  useEffect(() => {
    if (!configured || !hasSession()) return;
    confirmAdmin()
      .catch((err) => setAuthError(err?.message || 'Your sign-in expired. Sign in again.'))
      .finally(() => setCheckingSession(false));
  }, [configured, confirmAdmin]);

  // Load stats when signed in
  useEffect(() => {
    if (!isLoggedIn) return;
    let cancelled = false;
    setLoadingData(true);
    setLoadError('');
    loadTelemetry()
      .then((rows) => { if (!cancelled) setRecords(rows); })
      .catch((err) => {
        console.error('Failed to load telemetry:', err);
        if (!cancelled) setLoadError(err?.message || 'Could not reach Firebase.');
      })
      .finally(() => { if (!cancelled) setLoadingData(false); });
    return () => { cancelled = true; };
  }, [isLoggedIn, refreshTrigger]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthenticating(true);
    setAuthError('');
    try {
      await signIn(email.trim(), password);
      setPassword('');
      await confirmAdmin();
    } catch (err: any) {
      setAuthError(err?.message || 'Sign-in failed.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleLogout = () => {
    signOut();
    setIsLoggedIn(false);
    setRecords([]);
  };

  // Export logs to CSV
  const handleExportCSV = () => {
    if (filteredRecords.length === 0) return;

    const headers = ['Transfer ID', 'File type', 'Size (Bytes)', 'Sender OS', 'Receiver OS', 'Status', 'Speed (B/s)', 'Duration (s)', 'App version', 'Error Message', 'Created At'];
    const csvRows = [headers.map(csvCell).join(',')];

    filteredRecords.forEach((r) => {
      const values = [
        r.transfer_id,
        r.file_type,
        r.file_size,
        r.sender_os,
        r.receiver_os,
        r.status,
        r.speed_bytes_sec || 0,
        r.duration_sec || 0,
        r.app_version || '',
        r.error_message || '',
        r.created_at
      ];
      csvRows.push(values.map(csvCell).join(','));
    });

    // Build via Blob rather than a data: URI — encodeURI mangles '#' and breaks on large exports.
    const blob = new Blob(['﻿' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `weshare_telemetry_report_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    notify(`Exported ${filteredRecords.length} audit records to CSV.`);
  };

  // Filtered + sorted audit records
  const filteredRecords = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matched = records.filter((r) => {
      const matchesSearch = !query ||
        (r.file_type || '').toLowerCase().includes(query) ||
        (r.sender_os || '').toLowerCase().includes(query) ||
        (r.receiver_os || '').toLowerCase().includes(query);
      const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
      return matchesSearch && matchesStatus;
    });

    const direction = sortDesc ? -1 : 1;
    return [...matched].sort((a, b) => {
      if (sortKey === 'file_type') {
        return (a.file_type || '').localeCompare(b.file_type || '') * direction;
      }
      if (sortKey === 'created_at') {
        return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * direction;
      }
      return (((a[sortKey] as number) || 0) - ((b[sortKey] as number) || 0)) * direction;
    });
  }, [records, searchQuery, statusFilter, sortKey, sortDesc]);

  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / ROWS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedRecords = useMemo(
    () => filteredRecords.slice(currentPage * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE + ROWS_PER_PAGE),
    [filteredRecords, currentPage]
  );

  // Reset to the first page whenever the filters change the result set
  useEffect(() => {
    setPage(0);
  }, [searchQuery, statusFilter, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  // Aggregate metrics
  const metrics = useMemo(() => {
    const totalTransfers = records.length;
    const successful = records.filter((r) => r.status === 'completed');
    const totalBytes = successful.reduce((acc, curr) => acc + (curr.file_size || 0), 0);
    const successRate = totalTransfers > 0 ? Math.round((successful.length / totalTransfers) * 100) : 100;

    const speedRecords = successful.filter((r) => r.speed_bytes_sec > 0);
    const averageSpeed = speedRecords.length > 0
      ? speedRecords.reduce((acc, curr) => acc + curr.speed_bytes_sec, 0) / speedRecords.length
      : 0;
    const peakSpeed = speedRecords.reduce((max, curr) => Math.max(max, curr.speed_bytes_sec), 0);

    return {
      totalTransfers,
      successfulCount: successful.length,
      failedCount: totalTransfers - successful.length,
      totalBytes,
      successRate,
      averageSpeed,
      peakSpeed
    };
  }, [records]);

  // Top sending devices on the network
  const topDevicesList = useMemo(() => {
    const map = new Map<string, { total: number; success: number; deliveredBytes: number; os: string }>();
    records.forEach((r) => {
      const dev = `${r.sender_os || 'Unknown'} → ${r.receiver_os || 'Unknown'}`;
      const os = r.sender_os || 'Unknown OS';
      const stats = map.get(dev) || { total: 0, success: 0, deliveredBytes: 0, os };
      stats.total++;
      if (r.status === 'completed') {
        stats.success++;
        stats.deliveredBytes += r.file_size || 0;
      }
      map.set(dev, stats);
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1].deliveredBytes - a[1].deliveredBytes || b[1].total - a[1].total)
      .slice(0, 5);
  }, [records]);

  // File-type breakdown, derived from whatever formats actually appear in the data.
  // (Previously hardcoded to mp3/zip/png, which never matched because telemetry
  // stores extensions with a leading dot — every file fell into "Other".)
  const chartFormatStats = useMemo(() => {
    const map = new Map<string, { count: number; size: number }>();
    // Only completed transfers count toward the breakdown — a failed 24 GB attempt
    // never moved 24 GB, and counting it here contradicts the Total Network Traffic tile.
    records.filter((r) => r.status === 'completed').forEach((r) => {
      const ext = normalizeExt(r.file_type);
      const current = map.get(ext) || { count: 0, size: 0 };
      current.count++;
      current.size += r.file_size || 0;
      map.set(ext, current);
    });

    const ranked = Array.from(map.entries()).sort((a, b) => b[1].size - a[1].size);
    const top = ranked.slice(0, CHART_SLOTS - 1);
    const rest = ranked.slice(CHART_SLOTS - 1);

    const slots = top.map(([ext, stats]) => ({
      label: ext === 'unknown' ? 'No ext' : `.${ext.toUpperCase()}`,
      count: stats.count,
      size: stats.size
    }));

    if (rest.length > 0) {
      slots.push({
        label: `Other (${rest.length})`,
        count: rest.reduce((acc, [, s]) => acc + s.count, 0),
        size: rest.reduce((acc, [, s]) => acc + s.size, 0)
      });
    }

    const maxSize = slots.reduce((max, s) => Math.max(max, s.size), 0) || 1;
    // Scale against the largest slot so the tallest bar always fills the chart.
    return slots.map((slot) => ({
      ...slot,
      percent: slot.size > 0 ? Math.max(4, Math.round((slot.size / maxSize) * 100)) : 0
    }));
  }, [records]);

  // Helper device icon
  const getDeviceIcon = (os: string) => {
    const lower = (os || '').toLowerCase();
    if (lower.includes('ios') || lower.includes('iphone') || lower.includes('android') || lower.includes('phone') || lower.includes('mobile')) {
      return <Smartphone size={16} />;
    }
    return <Monitor size={16} />;
  };

  // Firebase not set up in this build
  if (!configured) {
    return (
      <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - 120px)', justifyContent: 'center', alignItems: 'center' }}>
        <div className="glass-panel" style={{ padding: '36px', width: '100%', maxWidth: '480px' }}>
          <span className="mono-label">Admin console</span>
          <h3 style={{ fontSize: '22px', margin: '8px 0 10px' }}>Firebase is not set up</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: 1.6 }}>
            Add the Firebase web app's API key to <code>src/services/firebaseConfig.ts</code> and rebuild Weshare.
          </p>
        </div>
      </div>
    );
  }

  if (checkingSession && !isLoggedIn) {
    return <div style={{ minHeight: 'calc(100vh - 120px)' }} />;
  }

  // Render Admin Sign-in Gate
  if (!isLoggedIn) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 'calc(100vh - 120px)', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '400px', height: '400px', background: 'rgba(168, 85, 247, 0.12)', filter: 'blur(100px)', borderRadius: '50%', pointerEvents: 'none' }} />

        <div className="glass-panel primary-glow" style={{ padding: '40px', width: '100%', maxWidth: '420px', borderRadius: '24px', position: 'relative', zIndex: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--primary-light)', marginBottom: '16px' }}>
            <LogIn size={26} />
            <h3 style={{ fontSize: '20px', fontWeight: 600 }}>Console Authorization</h3>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', marginBottom: '24px', lineHeight: '1.5' }}>
            Sign in with a Firebase account that has been added to the admins collection.
          </p>

          {authError && (
            <div style={{ background: 'rgba(244, 63, 94, 0.08)', border: '1px solid var(--error)', padding: '12px', borderRadius: '8px', color: 'var(--error)', fontSize: '12.5px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldAlert size={16} style={{ flexShrink: 0 }} />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginLeft: '4px' }}>ADMIN EMAIL</label>
              <input 
                type="email" 
                className="input-recessed"
                placeholder="admin@weshare.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginLeft: '4px' }}>PASSWORD</label>
                <button 
                  type="button" 
                  onClick={() => setShowPassword(!showPassword)}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10.5px', color: 'var(--text-muted)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                >
                  {showPassword ? <EyeOff size={11} /> : <Eye size={11} />}
                  <span>{showPassword ? 'Hide' : 'Show'}</span>
                </button>
              </div>
              <input 
                type={showPassword ? 'text' : 'password'} 
                className="input-recessed"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>

            <button 
              className="interactive-btn primary" 
              type="submit" 
              disabled={isAuthenticating}
              style={{ width: '100%', padding: '14px', marginTop: '10px', opacity: isAuthenticating ? 0.7 : 1, display: 'flex', gap: '8px', justifyContent: 'center' }}
            >
              {isAuthenticating ? 'Authorizing Profile...' : 'Sign In To Console'}
            </button>
          </form>
        </div>
        <Toast toast={toast} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '24px', flex: 1, minHeight: 0, height: '100%', width: '100%', animation: 'fadeIn 0.3s ease-out', position: 'relative' }}>
      
      {/* Background Soft Glow */}
      <div style={{ position: 'absolute', bottom: '-80px', right: '-80px', width: '380px', height: '380px', background: 'rgba(168, 85, 247, 0.04)', filter: 'blur(90px)', borderRadius: '50%', pointerEvents: 'none' }} />

      {/* Sidebar Navigation */}
      <div className="glass-panel" style={{ width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '16px', padding: '20px', borderRadius: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '12px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', marginBottom: '8px' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(168,85,247,0.15)', color: 'var(--primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Database size={16} />
          </div>
          <div>
            <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 700, display: 'block', lineHeight: 1.2 }}>Console Center</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
              <div className="w-1.5 h-1.5 rounded-full bg-success status-dot-pulse" />
              <span style={{ fontSize: '10px', color: 'var(--success)', fontWeight: 500 }} title={currentAdminEmail()}>{currentAdminEmail() || 'Signed in'}</span>
            </div>
          </div>
        </div>

        <div role="tablist" aria-label="Admin console sections" style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                id={`admin-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`admin-panel-${tab.id}`}
                className={`interactive-btn ${isActive ? 'primary active-tab-glow' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '10px 14px',
                  fontSize: '13px',
                  justifyContent: 'flex-start',
                  width: '100%',
                  background: isActive ? undefined : 'rgba(255,255,255,0.01)'
                }}
              >
                <Icon size={14} />
                {tab.label}
                {tab.id === 'audit' && records.length > 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: '10px', background: 'rgba(255,255,255,0.08)', padding: '1px 6px', borderRadius: '999px', color: 'var(--text-muted)' }}>
                    {records.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Bottom controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
          <button 
            className="interactive-btn"
            onClick={() => setRefreshTrigger(prev => prev + 1)}
            disabled={loadingData}
            style={{ width: '100%', padding: '10px', fontSize: '13px', justifyContent: 'flex-start' }}
          >
            <RefreshCw size={14} className={loadingData ? 'spin-animation' : ''} />
            {loadingData ? 'Syncing...' : 'Refresh Logs'}
          </button>
          
          <button 
            className="interactive-btn"
            onClick={handleLogout}
            style={{ width: '100%', padding: '10px', fontSize: '13px', border: '1px solid rgba(244,63,94,0.15)', color: 'var(--error)', justifyContent: 'flex-start' }}
          >
            <LogOut size={14} />
            Disconnect
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="lumina-scrollbar" style={{ flex: 1, overflowY: 'auto', minWidth: 0, paddingRight: '6px', paddingBottom: '40px' }}>

        {loadError && (
          <div
            role="alert"
            style={{ background: 'rgba(244, 63, 94, 0.08)', border: '1px solid var(--error)', padding: '12px 16px', borderRadius: '12px', color: 'var(--error)', fontSize: '12.5px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}
          >
            <ShieldAlert size={16} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>Could not load telemetry data: {loadError}</span>
            <button
              className="pagination-btn"
              onClick={() => setRefreshTrigger((prev) => prev + 1)}
              style={{ flexShrink: 0 }}
            >
              Retry
            </button>
          </div>
        )}

        {/* TAB 1: OVERVIEW ANALYTICS */}
        {activeTab === 'analytics' && (
          <div role="tabpanel" id="admin-panel-analytics" aria-labelledby="admin-tab-analytics" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            
            {/* 4 Stats Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
              
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '120px', transition: 'border-color 0.25s', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Network Traffic</span>
                  <Database size={15} style={{ color: 'var(--primary-light)' }} />
                </div>
                <div>
                  <h3 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--primary-light)', fontFamily: 'var(--font-title)', margin: 0 }}>
                    {formatSize(metrics.totalBytes)}
                  </h3>
                  <p style={{ fontSize: '10.5px', color: 'var(--tertiary)', margin: '2px 0 0 0', fontWeight: 500 }}>Completed payload volume</p>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '120px', transition: 'border-color 0.25s', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Transfers</span>
                  <ArrowUpRight size={15} style={{ color: 'var(--primary-light)' }} />
                </div>
                <div>
                  <h3 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-title)', margin: 0 }}>
                    {metrics.totalTransfers}
                  </h3>
                  <p style={{ fontSize: '10.5px', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>Success: {metrics.successfulCount} • Fail: {metrics.failedCount}</p>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '120px', transition: 'border-color 0.25s', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Success Rate</span>
                  <CheckCircle size={15} style={{ color: 'var(--primary-light)' }} />
                </div>
                <div>
                  <h3 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-title)', margin: 0 }}>
                    {metrics.successRate}%
                  </h3>
                  <div
                    role="progressbar"
                    aria-valuenow={metrics.successRate}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Transfer success rate"
                    style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '999px', marginTop: '6px', overflow: 'hidden' }}
                  >
                    <div style={{ height: '100%', width: `${metrics.successRate}%`, background: metrics.successRate >= 90 ? 'var(--primary)' : 'var(--error)', borderRadius: '999px', transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '120px', transition: 'border-color 0.25s', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Average Speed</span>
                  <Clock size={15} style={{ color: 'var(--primary-light)' }} />
                </div>
                <div>
                  <h3 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-title)', margin: 0 }}>
                    {formatSpeed(metrics.averageSpeed)}
                  </h3>
                  <p style={{ fontSize: '10.5px', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>Peak {formatSpeed(metrics.peakSpeed)} across LAN peers</p>
                </div>
              </div>

            </div>

            {/* Split Grid: Devices & Breakdown Charts */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.9fr', gap: '16px', minHeight: '340px' }}>
              
              {/* Left Column: Top Devices */}
              <div className="glass-panel" style={{ borderRadius: '16px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Top Routes</h4>
                  <span style={{ fontSize: '10px', background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: '4px', color: 'var(--text-muted)', fontWeight: 600 }}>OS TO OS</span>
                </div>
                <div style={{ flex: 1, padding: '10px', overflowY: 'auto' }} className="lumina-scrollbar">
                  {topDevicesList.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', padding: '30px', textAlign: 'center' }}>No network records found.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {topDevicesList.map(([device, data], index) => (
                        <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: '8px' }} className="table-row-hover">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary-light)', flexShrink: 0 }}>
                              {getDeviceIcon(data.os)}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={device}>
                                {device}
                              </span>
                              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', display: 'block' }}>{data.os}</span>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <span style={{ fontSize: '12px', color: 'var(--primary-light)', fontWeight: 600, display: 'block' }}>{formatSize(data.deliveredBytes)} sent</span>
                            <span style={{ fontSize: '10.5px', color: data.success === data.total ? 'var(--success)' : 'var(--text-muted)' }}>
                              {data.success}/{data.total} delivered
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Format Breakdown Bar Graph */}
              <div className="glass-panel" style={{ borderRadius: '16px', padding: '24px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: '24px' }}>
                  <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Transfer Types Breakdown</h4>
                  <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>Completed payload size by file format</p>
                </div>

                {chartFormatStats.length === 0 ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '12.5px' }}>
                    No transfers recorded yet.
                  </div>
                ) : (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '16px', padding: '0 10px 10px 10px', height: '170px' }}>
                    {chartFormatStats.map((slot, index) => (
                      <div
                        key={slot.label}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}
                        title={`${slot.label}: ${slot.count} file(s), ${formatSize(slot.size)}`}
                      >
                        <div style={{ flex: 1, width: '100%', position: 'relative' }}>
                          <div className="chart-bar-container">
                            <div
                              className={CHART_FILL_CLASSES[index % CHART_FILL_CLASSES.length]}
                              style={{ height: `${slot.percent}%` }}
                            />
                          </div>
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-primary)', fontWeight: 600, marginTop: '8px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {slot.label}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {slot.count} files ({formatSize(slot.size)})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>

            {/* Bottom section: Recent Activity Logs Preview */}
            <div className="glass-panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
              <div style={{ padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Recent Activity Preview</h4>
                <button 
                  onClick={() => setActiveTab('audit')}
                  style={{ background: 'transparent', border: 'none', color: 'var(--primary-light)', fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
                >
                  <FileSpreadsheet size={12} />
                  View Full Audit Logs
                </button>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12.5px' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255, 255, 255, 0.02)', borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                      <th style={{ padding: '12px 20px', color: 'var(--text-muted)' }}>FILE NAME</th>
                      <th style={{ padding: '12px 20px', color: 'var(--text-muted)' }}>SIZE</th>
                      <th style={{ padding: '12px 20px', color: 'var(--text-muted)' }}>SENDER</th>
                      <th style={{ padding: '12px 20px', color: 'var(--text-muted)' }}>RECEIVER</th>
                      <th style={{ padding: '12px 20px', color: 'var(--text-muted)' }}>STATUS</th>
                      <th style={{ padding: '12px 20px', color: 'var(--text-muted)' }} className="px-6">DATE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>No logs synchronized yet.</td>
                      </tr>
                    ) : (
                      records.slice(0, 3).map((r) => (
                        <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }} className="table-row-hover">
                          <td style={{ padding: '12px 20px', fontWeight: 600, color: 'var(--text-primary)', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileLabel(r)}>
                            {fileLabel(r)}
                          </td>
                          <td style={{ padding: '12px 20px', color: 'var(--text-muted)' }}>{formatSize(r.file_size)}</td>
                          <td style={{ padding: '12px 20px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontWeight: 600 }}>{r.sender_os}</span>
                            </div>
                          </td>
                          <td style={{ padding: '12px 20px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontWeight: 600 }}>{r.receiver_os}</span>
                            </div>
                          </td>
                          <td style={{ padding: '12px 20px' }}>
                            <span className={r.status === 'completed' ? 'status-badge-success' : 'status-badge-failed'}>
                              {r.status === 'completed' ? 'SUCCESS' : 'FAILED'}
                            </span>
                          </td>
                          <td style={{ padding: '12px 20px', color: 'var(--text-muted)' }}>
                            {new Date(r.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        )}

        {/* TAB 2: TRANSFER AUDIT LOGS */}
        {activeTab === 'audit' && (
          <div role="tabpanel" id="admin-panel-audit" aria-labelledby="admin-tab-audit" className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', borderRadius: '16px' }}>
            
            {/* Header controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '12px', flex: 1, minWidth: '280px' }}>
                <input 
                  type="text" 
                  className="input-recessed"
                  placeholder="Search file name, sender or receiver..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{ maxWidth: '350px', fontSize: '13px' }}
                />
                
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as any)}
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: '8px',
                    padding: '8px 14px',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    fontSize: '13px',
                    cursor: 'pointer'
                  }}
                >
                  <option value="all">All Statuses</option>
                  <option value="completed">Success Only</option>
                  <option value="failed">Failed Only</option>
                </select>
              </div>

              <button
                className="interactive-btn"
                onClick={handleExportCSV}
                disabled={filteredRecords.length === 0}
                style={{ padding: '8px 16px', fontSize: '13px', display: 'flex', gap: '6px', opacity: filteredRecords.length === 0 ? 0.5 : 1 }}
              >
                <FileSpreadsheet size={14} />
                Export CSV ({filteredRecords.length})
              </button>
            </div>

            {/* Audit Logs Table */}
            <div style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: 'rgba(255, 255, 255, 0.02)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    {([
                      { label: 'FILE TYPE', key: 'file_type' as SortKey },
                      { label: 'SIZE', key: 'file_size' as SortKey },
                      { label: 'SENDER', key: null },
                      { label: 'RECEIVER', key: null },
                      { label: 'STATUS', key: null },
                      { label: 'SPEED', key: 'speed_bytes_sec' as SortKey },
                      { label: 'DATE', key: 'created_at' as SortKey }
                    ]).map((col) => (
                      <th
                        key={col.label}
                        scope="col"
                        className={col.key ? 'sortable-th' : undefined}
                        onClick={col.key ? () => toggleSort(col.key as SortKey) : undefined}
                        aria-sort={col.key && sortKey === col.key ? (sortDesc ? 'descending' : 'ascending') : undefined}
                        style={{ padding: '14px 18px', color: col.key && sortKey === col.key ? 'var(--primary-light)' : 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          {col.label}
                          {col.key && <ArrowUpDown size={11} style={{ opacity: sortKey === col.key ? 1 : 0.3 }} />}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loadingData ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <tr key={`skeleton-${i}`} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.03)' }}>
                        <td colSpan={7} style={{ padding: '14px 18px' }}>
                          <div className="skeleton-block" style={{ height: '18px', width: '100%' }} />
                        </td>
                      </tr>
                    ))
                  ) : filteredRecords.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        {records.length === 0
                          ? 'No audit records synchronized yet.'
                          : 'No audit records match the current filters.'}
                      </td>
                    </tr>
                  ) : (
                    pagedRecords.map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.03)' }} className="table-row-hover">
                        <td style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-primary)', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileLabel(r)}>
                          {fileLabel(r)}
                        </td>
                        <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>{formatSize(r.file_size)}</td>
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontWeight: 600 }}>{r.sender_os}</span>
                          </div>
                        </td>
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontWeight: 600 }}>{r.receiver_os}</span>
                          </div>
                        </td>
                        <td style={{ padding: '14px 18px' }}>
                          <span className={r.status === 'completed' ? 'status-badge-success' : 'status-badge-failed'}>
                            {r.status === 'completed' ? 'SUCCESS' : 'FAILED'}
                          </span>
                        </td>
                        <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                          {r.status === 'completed' ? formatSpeed(r.speed_bytes_sec) : '-'}
                        </td>
                        <td style={{ padding: '14px 18px', color: 'var(--text-muted)' }}>
                          {new Date(r.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {filteredRecords.length > ROWS_PER_PAGE && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Showing {currentPage * ROWS_PER_PAGE + 1}–{Math.min((currentPage + 1) * ROWS_PER_PAGE, filteredRecords.length)} of {filteredRecords.length}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    className="pagination-btn"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                    aria-label="Previous page"
                    style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    <ChevronLeft size={13} />
                    Prev
                  </button>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', minWidth: '80px', textAlign: 'center' }}>
                    Page {currentPage + 1} of {pageCount}
                  </span>
                  <button
                    className="pagination-btn"
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={currentPage >= pageCount - 1}
                    aria-label="Next page"
                    style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    Next
                    <ChevronRight size={13} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

      </div>

      <Toast toast={toast} onDismiss={dismissToast} />

    </div>
  );
};
