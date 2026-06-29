import { useState, useMemo, useEffect } from 'react';
import type { CallLogEntry, IvrEvent, User } from '../types/sip';
import { useContacts } from '../hooks/useContacts';

function fmt(sec: number | null) {
  if (sec === null) return '\u2014';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtTime(d: Date) {
  const isToday = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + '\u00a0' + time;
}

function fmtTimestamp(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function extractNumber(identity: string): string {
  const match = identity.match(/sip:([^@]+)@/);
  return match ? match[1] : identity;
}

const IVR_PATH: Record<string, string> = {
  '1': 'Option 1 → Agent',
  '2': 'Option 2 → Voicemail',
  '9': 'Option 9 → Replay',
};

const EVENT_LABEL: Record<string, { label: string; color: string }> = {
  ivr_entered:            { label: 'IVR Entered',     color: '#2563eb' },
  ivr_option_selected:    { label: 'Option Selected', color: '#16a34a' },
  ivr_replayed:           { label: 'Replayed',        color: '#7c3aed' },
  ivr_timeout:            { label: 'Timeout',         color: '#d97706' },
  ivr_invalid_input:      { label: 'Invalid Key',     color: '#dc2626' },
  agent_ringing:          { label: 'Agent Ringing',   color: '#0891b2' },
  agent_answered:         { label: 'Agent Answered',  color: '#16a34a' },
  voicemail_started:      { label: 'VM Started',      color: '#d97706' },
  voicemail_completed:    { label: 'VM Saved',        color: '#16a34a' },
  transcription_completed:{ label: 'Transcribed',     color: '#7c3aed' },
  caller_hangup:          { label: 'Hung Up',         color: '#64748b' },
};

/** Returns who actually dialed whom, regardless of inbound/outbound framing. */
function fromTo(log: CallLogEntry, agentName: string, remoteDisplay: string): { from: string; to: string } {
  return log.direction === 'outbound'
    ? { from: agentName, to: remoteDisplay }
    : { from: remoteDisplay, to: agentName };
}

// ── Detail drawer ─────────────────────────────────────────────────────────────
function DetailDrawer({ log, onClose, lookupName, agentName }: { log: CallLogEntry; onClose: () => void; lookupName: (n: string) => string | null; agentName: string }) {
  const [events,  setEvents]  = useState<IvrEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sipFile, setSipFile] = useState<string | null>(log.sipRecordingFile ?? null);
  // Twilio recordings finish processing asynchronously after the call ends —
  // the in-memory log entry from the moment the call hung up may predate that,
  // so refetch this single row to pick up a recordingSid that's since arrived.
  const [recordingSid, setRecordingSid] = useState<string | null>(log.recordingSid ?? null);

  const load = async () => {
    setLoading(true);
    try {
      const [ivrRes, freshRes, recRes] = await Promise.all([
        fetch(`/api/ivr-events?call_sid=${encodeURIComponent(log.id)}`),
        fetch(`/api/call-logs/${encodeURIComponent(log.id)}`),
        // Only fetch SIP recordings list for SIP (non-Twilio) calls without a known file
        (!log.recordingSid && !log.sipRecordingFile)
          ? fetch('/api/sip-recordings')
          : Promise.resolve(null),
      ]);
      if (ivrRes.ok) setEvents(await ivrRes.json());
      if (freshRes.ok) {
        const fresh: CallLogEntry = await freshRes.json();
        if (fresh.recordingSid)     setRecordingSid(fresh.recordingSid);
        if (fresh.sipRecordingFile) setSipFile(fresh.sipRecordingFile);
      }
      if (recRes && recRes.ok) {
        const files: Array<{ filename: string; createdAt: string; caller: string | null; callee: string | null }> = await recRes.json();
        const logTime = log.startTime.getTime();
        const remoteNum = extractNumber(log.remoteIdentity);
        // Find a recording within 60s of the call start that involves the remote number
        const match = files.find((f) => {
          const diff = Math.abs(new Date(f.createdAt).getTime() - logTime);
          const involves = f.caller === remoteNum || f.callee === remoteNum ||
                           f.caller?.includes(remoteNum) || f.callee?.includes(remoteNum);
          return diff < 60_000 && involves;
        }) ?? (files.find((f) => {
          // Fallback: within 2 minutes, any file
          return Math.abs(new Date(f.createdAt).getTime() - logTime) < 120_000;
        }));
        if (match) setSipFile(match.filename);
      }
    } finally { setLoading(false); }
  };

  useState(() => { load(); });

  const ivrPath = log.ivrOption
    ? (IVR_PATH[log.ivrOption] ?? `Option ${log.ivrOption}`)
    : null;

  const remoteDisplay = lookupName(extractNumber(log.remoteIdentity)) ?? extractNumber(log.remoteIdentity);
  const { from, to } = fromTo(log, agentName, remoteDisplay);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 200,
      backdropFilter: 'blur(2px)',
    }} onClick={onClose}>
      <div
        style={{
          background: 'var(--surface)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          width: '100%', maxWidth: 680, maxHeight: '70vh', overflowY: 'auto',
          padding: '24px 28px', boxShadow: 'var(--shadow-lg)',
          animation: 'fadeIn 0.15s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 2 }}>
              <span>{from}</span>
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>→</span>
              <span>{to}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {log.direction === 'inbound' ? '↗ Inbound' : '↙ Outbound'} · {fmtTime(log.startTime)} · {fmt(log.duration)}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)', padding: '4px 8px' }}>×</button>
        </div>

        {/* IVR Path */}
        <div style={{ marginBottom: 18, padding: '12px 14px', background: 'var(--border-light)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 6 }}>IVR Path</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13 }}>
            <PathChip label="Incoming" color="#475569" />
            {ivrPath ? (
              <>
                <span style={{ color: 'var(--text-muted)' }}>→</span>
                <PathChip label={ivrPath} color="#2563eb" />
                <span style={{ color: 'var(--text-muted)' }}>→</span>
                <PathChip label={log.ivrCompleted ? 'Completed' : 'In Progress'} color={log.ivrCompleted ? '#16a34a' : '#d97706'} />
              </>
            ) : (
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No IVR data (SIP call or pre-IVR)</span>
            )}
          </div>
        </div>

        {/* ── Recording player ── */}
        {(recordingSid || sipFile) && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>
              Call Recording
            </div>
            <div style={{
              background: 'var(--border-light)', borderRadius: 'var(--radius-md)',
              padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{ fontSize: 18 }}>🎙️</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  {recordingSid ? 'PSTN Recording (Twilio)' : 'SIP Recording (Asterisk)'}
                </div>
                <audio
                  controls
                  src={recordingSid
                    ? `/api/recordings/${recordingSid}`
                    : `/api/sip-recordings/${sipFile}`
                  }
                  style={{ width: '100%', height: 36 }}
                />
              </div>
            </div>
          </div>
        )}
        {!recordingSid && !sipFile && log.status === 'answered' && !loading && (
          <div style={{ marginBottom: 18, fontSize: 12, color: 'var(--text-muted)' }}>
            🎙️ Recording not yet available — it may still be processing. Reopen this call in a moment.
          </div>
        )}

        {/* IVR Events timeline */}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 10 }}>Event Timeline</div>
        {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        {!loading && events !== null && events.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No IVR events recorded for this call.</div>
        )}
        {!loading && events && events.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {events.map((ev) => {
              const meta = EVENT_LABEL[ev.event_type] ?? { label: ev.event_type, color: '#64748b' };
              return (
                <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', width: 64, flexShrink: 0 }}>
                    {fmtTimestamp(ev.created_at)}
                  </span>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, color: meta.color }}>{meta.label}</span>
                  {ev.selected_option && (
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>· key {ev.selected_option}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PathChip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 99, fontSize: 12, fontWeight: 700,
      background: color + '18', color,
    }}>{label}</span>
  );
}

// ── Mobile card ───────────────────────────────────────────────────────────────
function MobileLogCard({ log, onCall, onClick, lookupName, agentName }: { log: CallLogEntry; onCall: (n: string) => void; onClick: () => void; lookupName: (n: string) => string | null; agentName: string }) {
  const num = extractNumber(log.remoteIdentity);
  const display = lookupName(num) ?? num;
  const { from, to } = fromTo(log, agentName, display);
  const statusColor =
    log.status === 'answered' ? 'var(--green)'
    : log.status === 'missed' ? 'var(--amber)'
    : 'var(--red)';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 16px',
        borderBottom: '1px solid var(--border-light)',
        cursor: 'pointer',
        background: 'var(--surface)',
      }}
    >
      <span style={{ fontSize: 20, width: 24, textAlign: 'center', flexShrink: 0 }}>
        {log.direction === 'inbound' ? '↙' : '↗'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{from}</span>
          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>→</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{to}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
          {fmtTime(log.startTime)} · {fmt(log.duration)}
        </div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: statusColor, textTransform: 'capitalize', flexShrink: 0 }}>
        {log.status}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onCall(num); }}
        style={{ ...callBackBtn, flexShrink: 0 }}
      >
        📞
      </button>
    </div>
  );
}

type FilterStatus = 'all' | 'answered' | 'missed' | 'failed';
type FilterDir    = 'all' | 'inbound' | 'outbound';
type SortKey      = 'time' | 'duration' | 'number';
type SortDir      = 'asc' | 'desc';

function exportCsv(logs: CallLogEntry[]) {
  const header = ['Direction', 'Number', 'Date', 'Time', 'Duration (s)', 'Status', 'Channel'];
  const rows = logs.map((l) => [
    l.direction,
    extractNumber(l.remoteIdentity),
    l.startTime.toLocaleDateString(),
    l.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    l.duration ?? '',
    l.status,
    l.remoteIdentity.includes('@') ? 'SIP' : 'PSTN',
  ]);
  const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `call-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main component ────────────────────────────────────────────────────────────
export function CallLogs({
  logs,
  onCall,
  isMobile = false,
  user,
  initialExtFilter = null,
}: {
  logs: CallLogEntry[];
  onCall: (ext: string) => void;
  isMobile?: boolean;
  user: User;
  initialExtFilter?: { extensions: string[]; label: string } | null;
}) {
  const { lookupName } = useContacts();
  const [selected,    setSelected]    = useState<CallLogEntry | null>(null);
  const [extFilter,   setExtFilter]   = useState(initialExtFilter);

  // Roster of other users — only needed to resolve "who handled this call"
  // for manager/admin views; an agent's calls are always their own.
  const [roster, setRoster] = useState<User[]>([]);
  useEffect(() => {
    if (user.role === 'agent') return;
    fetch('/api/users', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setRoster)
      .catch(() => {});
  }, [user.role]);

  const agentNameFor = (ext: string | null | undefined): string => {
    if (!ext) return '—';
    if (ext === user.extension) return user.name;
    return roster.find((u) => u.extension === ext)?.name ?? `Ext ${ext}`;
  };

  // Agents the current viewer can pick from in the "filter by agent" dropdown —
  // for a manager that's their own team; for admin it's everyone in the roster.
  const agentOptions = roster.filter((u) => u.role === 'agent' && u.extension);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [filterDir,    setFilterDir]    = useState<FilterDir>('all');
  const [search,       setSearch]       = useState('');
  const [sortKey,      setSortKey]      = useState<SortKey>('time');
  const [sortDir,      setSortDir]      = useState<SortDir>('desc');

  const filtered = useMemo(() => {
    let out = [...logs];
    if (extFilter)               out = out.filter((l) => l.extension && extFilter.extensions.includes(l.extension));
    if (filterStatus !== 'all') out = out.filter((l) => l.status === filterStatus);
    if (filterDir    !== 'all') out = out.filter((l) => l.direction === filterDir);
    if (search.trim())          out = out.filter((l) => extractNumber(l.remoteIdentity).includes(search.trim()));
    out.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'time')     cmp = a.startTime.getTime() - b.startTime.getTime();
      if (sortKey === 'duration') cmp = (a.duration ?? -1) - (b.duration ?? -1);
      if (sortKey === 'number')   cmp = extractNumber(a.remoteIdentity).localeCompare(extractNumber(b.remoteIdentity));
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return out;
  }, [logs, extFilter, filterStatus, filterDir, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? <span style={{ marginLeft: 3, fontSize: 10 }}>{sortDir === 'desc' ? '▼' : '▲'}</span> : null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Call Logs</h2>
        <button
          onClick={() => exportCsv(filtered)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          ⬇ Export CSV
        </button>
      </div>

      {extFilter && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
          padding: '8px 14px', borderRadius: 'var(--radius-md)',
          background: '#1e3a5f', border: '1px solid #3b82f6', width: 'fit-content',
        }}>
          <span style={{ fontSize: 13, color: '#fff' }}>
            Showing calls for <strong>{extFilter.label}</strong>
          </span>
          <button
            onClick={() => setExtFilter(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#60a5fa', fontSize: 13, fontWeight: 700, padding: 0 }}
          >
            × Clear
          </button>
        </div>
      )}

      {/* Filters row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, width: 160 }}
        />
        {agentOptions.length > 0 && (
          <select
            value={extFilter?.extensions[0] ?? ''}
            onChange={(e) => {
              const ext = e.target.value;
              if (!ext) { setExtFilter(null); return; }
              const agent = agentOptions.find((a) => a.extension === ext);
              if (agent) setExtFilter({ extensions: [ext], label: agent.name });
            }}
            style={{ padding: '6px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13 }}
          >
            <option value="">All Agents</option>
            {agentOptions.map((a) => (
              <option key={a.id} value={a.extension!}>{a.name}</option>
            ))}
          </select>
        )}
        {(['all','answered','missed','failed'] as FilterStatus[]).map((s) => (
          <button key={s} onClick={() => setFilterStatus(s)} style={{
            padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid',
            background: filterStatus === s ? statusBtnColor(s).bg : 'transparent',
            color: filterStatus === s ? statusBtnColor(s).text : 'var(--text-muted)',
            borderColor: filterStatus === s ? statusBtnColor(s).border : 'var(--border)',
          }}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />
        {(['all','inbound','outbound'] as FilterDir[]).map((d) => (
          <button key={d} onClick={() => setFilterDir(d)} style={{
            padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid',
            background: filterDir === d ? '#1e3a5f' : 'transparent',
            color: filterDir === d ? '#60a5fa' : 'var(--text-muted)',
            borderColor: filterDir === d ? '#3b82f6' : 'var(--border)',
          }}>
            {d.charAt(0).toUpperCase() + d.slice(1)}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          Sort:
          {(['time','duration','number'] as SortKey[]).map((k) => (
            <button key={k} onClick={() => toggleSort(k)} style={{
              padding: '5px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid',
              background: sortKey === k ? '#1e3a5f' : 'transparent',
              color: sortKey === k ? '#60a5fa' : 'var(--text-muted)',
              borderColor: sortKey === k ? '#3b82f6' : 'var(--border)',
            }}>
              {k.charAt(0).toUpperCase() + k.slice(1)}<SortIcon k={k} />
            </button>
          ))}
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Showing {filtered.length} of {logs.length} calls
      </div>

      {filtered.length === 0 ? (
        <div style={emptyState}>
          <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.3 }}>&#9990;</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {logs.length === 0 ? 'No calls yet. Make a call from the Softphone tab.' : 'No calls match the current filters.'}
          </div>
        </div>
      ) : isMobile ? (
        // ── Mobile: card list ──
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
          {filtered.map((log) => (
            <MobileLogCard key={log.id} log={log} onCall={onCall} onClick={() => setSelected(log)} lookupName={lookupName} agentName={agentNameFor(log.extension)} />
          ))}
        </div>
      ) : (
        // ── Desktop: table ──
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--border-light)', borderBottom: '1px solid var(--border)' }}>
                {['Direction', 'Call', 'Time', 'Duration', 'Status', 'IVR', ''].map((h, i) => (
                  <th key={i} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((log, idx) => {
                const remoteDisplay = lookupName(extractNumber(log.remoteIdentity)) ?? extractNumber(log.remoteIdentity);
                const { from, to } = fromTo(log, agentNameFor(log.extension), remoteDisplay);
                return (
                <tr
                  key={log.id}
                  style={{ borderBottom: idx < filtered.length - 1 ? '1px solid var(--border-light)' : 'none', transition: 'background 0.1s', cursor: 'pointer' }}
                  onClick={() => setSelected(log)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#fafafa')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '12px 16px' }}>
                    {log.direction === 'inbound'
                      ? <span style={{ ...dirBadge, background: 'var(--blue-light)', color: 'var(--blue)' }}>↗ In</span>
                      : <span style={{ ...dirBadge, background: 'var(--green-light)', color: 'var(--green)' }}>↙ Out</span>
                    }
                  </td>
                  <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--text-primary)' }}>
                    <span>{from}</span>
                    <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>→</span>
                    <span>{to}</span>
                  </td>
                  <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{fmtTime(log.startTime)}</td>
                  <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{fmt(log.duration)}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ fontWeight: 600, fontSize: 12, textTransform: 'capitalize',
                      color: log.status === 'answered' ? 'var(--green)' : log.status === 'missed' ? 'var(--amber)' : 'var(--red)' }}>
                      {log.status}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {log.ivrOption ? (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                        background: log.ivrOption === '1' ? '#f0fdf4' : log.ivrOption === '2' ? '#fffbeb' : '#f5f3ff',
                        color: log.ivrOption === '1' ? '#16a34a' : log.ivrOption === '2' ? '#d97706' : '#7c3aed',
                      }}>
                        {IVR_PATH[log.ivrOption] ?? `Opt ${log.ivrOption}`}
                      </span>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                  </td>
                  <td style={{ padding: '12px 16px' }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => onCall(extractNumber(log.remoteIdentity))} style={callBackBtn}>Call Back</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && <DetailDrawer log={selected} onClose={() => setSelected(null)} lookupName={lookupName} agentName={agentNameFor(selected.extension)} />}
    </div>
  );
}

const dirBadge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 9px',
  borderRadius: 99,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.02em',
};

const callBackBtn: React.CSSProperties = {
  padding: '5px 12px',
  background: 'transparent',
  color: 'var(--blue)',
  border: '1px solid var(--blue-dim)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  transition: 'background 0.1s',
};

function statusBtnColor(s: string) {
  if (s === 'answered') return { bg: '#dcfce7', text: '#16a34a', border: '#86efac' };
  if (s === 'missed')   return { bg: '#fee2e2', text: '#dc2626', border: '#fca5a5' };
  if (s === 'failed')   return { bg: '#fff7ed', text: '#ea580c', border: '#fdba74' };
  return { bg: '#1e3a5f', text: '#60a5fa', border: '#3b82f6' };
}

const emptyState: React.CSSProperties = {
  textAlign: 'center',
  padding: '60px 20px',
  background: 'var(--surface)',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--border)',
};
