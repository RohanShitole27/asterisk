import { useState, useEffect, useRef } from 'react';
import type { CallLogEntry } from '../types/sip';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(d: Date) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(sec: number | null) {
  if (sec === null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function extractNumber(identity: string): string {
  const match = identity.match(/sip:([^@]+)@/);
  return match ? match[1] : identity;
}

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#06b6d4'];
function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({
  icon, iconBg, label, value, delta, deltaUp,
}: {
  icon: string; iconBg: string; label: string; value: string;
  delta: string; deltaUp: boolean;
}) {
  return (
    <div style={{
      flex: 1,
      background: 'var(--surface)',
      borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--border)',
      padding: '24px 28px',
      display: 'flex',
      alignItems: 'center',
      gap: 20,
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: '50%',
        background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 12, marginTop: 6 }}>
          <span style={{ color: deltaUp ? '#4ade80' : '#f87171', fontWeight: 600 }}>
            {deltaUp ? '▲' : '▼'} {delta}
          </span>
          <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>vs yesterday</span>
        </div>
      </div>
    </div>
  );
}

// ── Recent Activity Row ───────────────────────────────────────────────────────
function ActivityRow({ log, onCall }: { log: CallLogEntry; onCall: (n: string) => void }) {
  const num = extractNumber(log.remoteIdentity);
  const color = avatarColor(num);
  const abbr = num.replace(/\D/g, '').slice(-4);

  const statusColor =
    log.status === 'answered' ? { bg: '#dcfce7', text: '#16a34a' }
    : log.status === 'missed'  ? { bg: '#fee2e2', text: '#dc2626' }
    : { bg: '#fef9c3', text: '#ca8a04' };

  const statusLabel =
    log.status === 'answered'
      ? log.direction === 'inbound' ? 'Completed' : 'Completed'
      : log.status === 'missed' ? 'Missed'
      : 'Failed';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0',
      borderBottom: '1px solid var(--border-light)',
    }}>
      {/* Direction arrow */}
      <span style={{ fontSize: 16, color: log.direction === 'inbound' ? '#60a5fa' : '#4ade80', width: 20, textAlign: 'center' }}>
        {log.direction === 'inbound' ? '↙' : '↗'}
      </span>

      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: '50%', background: color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0,
      }}>
        {abbr}
      </div>

      {/* Number */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{num}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDuration(log.duration)}</div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 8 }}>{fmtTime(log.startTime)}</div>

      <span style={{
        padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700,
        background: statusColor.bg, color: statusColor.text,
      }}>
        {statusLabel}
      </span>

      <button
        onClick={() => onCall(num)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, color: 'var(--text-muted)', padding: '4px 6px',
          borderRadius: 'var(--radius-sm)',
        }}
        title="Call back"
      >
        📞
      </button>
    </div>
  );
}

// ── Notification Item ─────────────────────────────────────────────────────────
interface NotifItem {
  id: string;
  type: 'call' | 'voicemail' | 'missed' | 'system' | 'report';
  title: string;
  body: string;
  ago: string;
  unread: boolean;
}

function NotifRow({ n }: { n: NotifItem }) {
  const iconMap: Record<NotifItem['type'], { bg: string; icon: string }> = {
    call:      { bg: '#dcfce7', icon: '📞' },
    voicemail: { bg: '#ede9fe', icon: '📬' },
    missed:    { bg: '#fee2e2', icon: '📵' },
    system:    { bg: '#dbeafe', icon: '🖥️' },
    report:    { bg: '#d1fae5', icon: '📊' },
  };
  const meta = iconMap[n.type];

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '10px 0', borderBottom: '1px solid var(--border-light)',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%', background: meta.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 15, flexShrink: 0,
      }}>
        {meta.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{n.title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{n.body}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{n.ago}</span>
        {n.unread && (
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3b82f6', display: 'block' }} />
        )}
      </div>
    </div>
  );
}

// ── Live Status Panel ─────────────────────────────────────────────────────────
function StatusRow({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border-light)' }}>
      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />}
        {value}
      </span>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
interface DashboardProps {
  logs: CallLogEntry[];
  unreadVoicemails: number;
  onCall: (ext: string) => void;
  onViewAllLogs: () => void;
  twilioReady: boolean;
  registered: boolean;
  isMobile?: boolean;
}

export function Dashboard({
  logs,
  unreadVoicemails,
  onCall,
  onViewAllLogs,
  twilioReady,
  registered,
  isMobile = false,
}: DashboardProps) {
  const [notifications, setNotifications] = useState<NotifItem[]>([]);
  const prevLogsLenRef = useRef(logs.length);
  const prevVmRef = useRef(unreadVoicemails);
  const prevRegisteredRef = useRef(registered);
  const prevTwilioReadyRef = useRef(twilioReady);

  // Push notification only for missed or failed calls — never for answered/completed
  useEffect(() => {
    if (logs.length > prevLogsLenRef.current) {
      const newest = logs[0];
      if (newest && (newest.status === 'missed' || newest.status === 'failed')) {
        const num = extractNumber(newest.remoteIdentity);
        const isFailed = newest.status === 'failed';
        const notif: NotifItem = {
          id: `log-${newest.id}`,
          type: isFailed ? 'missed' : 'missed',
          title: isFailed ? 'Failed Call' : 'Missed Call',
          body: `${newest.direction === 'inbound' ? 'From' : 'To'} ${num}`,
          ago: 'Just now',
          unread: true,
        };
        setNotifications((prev) => [notif, ...prev].slice(0, 10));
      }
    }
    prevLogsLenRef.current = logs.length;
  }, [logs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push notification when voicemail count increases
  useEffect(() => {
    if (unreadVoicemails > prevVmRef.current) {
      const notif: NotifItem = {
        id: `vm-${Date.now()}`,
        type: 'voicemail',
        title: 'New Voicemail',
        body: `You have ${unreadVoicemails} unread voicemail${unreadVoicemails > 1 ? 's' : ''}`,
        ago: 'Just now',
        unread: true,
      };
      setNotifications((prev) => [notif, ...prev].slice(0, 10));
    }
    prevVmRef.current = unreadVoicemails;
  }, [unreadVoicemails]);

  // Push notification when SIP registration is lost (service outage)
  useEffect(() => {
    if (prevRegisteredRef.current && !registered) {
      const notif: NotifItem = {
        id: `sip-down-${Date.now()}`,
        type: 'system',
        title: 'Service Outage',
        body: 'SIP registration lost — internal calling is unavailable',
        ago: 'Just now',
        unread: true,
      };
      setNotifications((prev) => [notif, ...prev].slice(0, 10));
    }
    prevRegisteredRef.current = registered;
  }, [registered]);

  // Push notification when PSTN (Twilio) connection drops
  useEffect(() => {
    if (prevTwilioReadyRef.current && !twilioReady) {
      const notif: NotifItem = {
        id: `pstn-down-${Date.now()}`,
        type: 'system',
        title: 'Service Outage',
        body: 'PSTN connection lost — outside calling is unavailable',
        ago: 'Just now',
        unread: true,
      };
      setNotifications((prev) => [notif, ...prev].slice(0, 10));
    }
    prevTwilioReadyRef.current = twilioReady;
  }, [twilioReady]);

  const markAllRead = () =>
    setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));

  // Stats derived from today's logs
  const today = new Date().toDateString();
  const todayLogs = logs.filter((l) => l.startTime.toDateString() === today);
  const callsMade = todayLogs.length;
  const answered = todayLogs.filter((l) => l.status === 'answered');
  const avgSec = answered.length
    ? Math.round(answered.reduce((s, l) => s + (l.duration ?? 0), 0) / answered.length)
    : 0;
  const avgDur = `${String(Math.floor(avgSec / 60)).padStart(2, '0')}:${String(avgSec % 60).padStart(2, '0')}`;

  const unreadCount = notifications.filter((n) => n.unread).length;
  const sipStatus = registered ? 'Connected' : 'Disconnected';
  const sipColor = registered ? '#4ade80' : '#f87171';

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'flex-start' : 'center', justifyContent: 'space-between', marginBottom: 28, gap: isMobile ? 12 : 0 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' }}>Dashboard</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            Monitor and manage your calls in real-time.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Availability badge */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '7px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--surface)', border: '1px solid var(--border)',
            fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: registered ? '#4ade80' : '#f87171' }} />
            {registered ? 'Available' : 'Offline'}
          </div>

          {/* Notification bell */}
          <div style={{ position: 'relative' }}>
            <button style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'var(--surface)', border: '1px solid var(--border)',
              cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              🔔
            </button>
            {unreadCount > 0 && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                background: '#ef4444', color: '#fff',
                borderRadius: 99, fontSize: 9, fontWeight: 700,
                padding: '1px 5px', minWidth: 16, textAlign: 'center',
              }}>
                {unreadCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 18, marginBottom: 24 }}>
        <StatCard
          icon="📞" iconBg="#1e3a5f"
          label="Calls Made Today" value={String(callsMade)}
          delta={`${callsMade} total`} deltaUp={callsMade > 0}
        />
        <StatCard
          icon="⏱️" iconBg="#2d1b69"
          label="Avg. Duration (Today)" value={avgDur}
          delta={answered.length > 0 ? `${answered.length} answered` : 'No answered calls'} deltaUp={answered.length > 0}
        />
        <StatCard
          icon="📬" iconBg="#7c2d12"
          label="Voicemails Today" value={String(unreadVoicemails)}
          delta={unreadVoicemails > 0 ? `${unreadVoicemails} unread` : 'All read'} deltaUp={false}
        />
      </div>

      {/* Bottom Three Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 18 }}>

        {/* Recent Activity */}
        <div style={{
          background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)', padding: '20px 20px 8px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Recent Activity</div>
            <span style={{ fontSize: 12, color: '#60a5fa', cursor: 'pointer' }} onClick={onViewAllLogs}>View all</span>
          </div>

          {logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              No recent activity
            </div>
          ) : (
            logs.slice(0, 5).map((log) => (
              <ActivityRow key={log.id} log={log} onCall={onCall} />
            ))
          )}

          {logs.length > 5 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 0 4px', textAlign: 'center' }}>
              Showing 5 of {logs.length} activities
            </div>
          )}
        </div>

        {/* Live System Status */}
        <div style={{
          background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)', padding: '20px 20px 8px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>System Status</div>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#4ade80', animation: 'pulse 2s infinite' }} />
              <span style={{ color: '#4ade80', fontWeight: 600 }}>Live</span>
            </span>
          </div>
          <StatusRow label="SIP / WebRTC" value={registered ? 'Connected' : 'Offline'} dot={registered ? '#4ade80' : '#f87171'} />
          <StatusRow label="PSTN (Twilio)" value={twilioReady ? 'Connected' : 'Offline'} dot={twilioReady ? '#4ade80' : '#f87171'} />
          <StatusRow label="Calls Today" value={String(todayLogs.length)} />
          <StatusRow label="Answered" value={String(answered.length)} dot="#4ade80" />
          <StatusRow label="Missed" value={String(todayLogs.filter((l) => l.status === 'missed').length)} dot={todayLogs.some((l) => l.status === 'missed') ? '#f87171' : undefined} />
          <StatusRow label="Failed / Not Connected" value={String(todayLogs.filter((l) => l.status === 'failed').length)} dot={todayLogs.some((l) => l.status === 'failed') ? '#f97316' : undefined} />
          <StatusRow label="Answer Rate" value={todayLogs.length ? `${Math.round((answered.length / todayLogs.length) * 100)}%` : '—'} />
          <StatusRow label="Voicemails" value={unreadVoicemails > 0 ? `${unreadVoicemails} unread` : 'None'} dot={unreadVoicemails > 0 ? '#f59e0b' : undefined} />
        </div>

        {/* Notifications */}
        <div style={{
          background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)', padding: '20px 20px 8px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Notifications</div>
            <span
              style={{ fontSize: 12, color: '#60a5fa', cursor: 'pointer' }}
              onClick={markAllRead}
            >
              Mark all as read
            </span>
          </div>

          {notifications.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              No notifications
            </div>
          ) : (
            notifications.map((n) => <NotifRow key={n.id} n={n} />)
          )}
        </div>
      </div>

      {/* Footer SIP status */}
      <div style={{
        marginTop: 20, display: 'flex', justifyContent: 'space-between',
        fontSize: 12, color: 'var(--text-muted)',
      }}>
        <span>© 2024 VoIP Monitor. All rights reserved.</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: sipColor, display: 'inline-block' }} />
          SIP Trunk: <span style={{ color: sipColor, fontWeight: 600, marginLeft: 3 }}>{sipStatus}</span>
          {twilioReady && (
            <span style={{ marginLeft: 10, color: '#c084fc', fontWeight: 600 }}>· PSTN: Connected</span>
          )}
        </span>
      </div>
    </div>
  );
}
