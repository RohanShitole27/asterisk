import { useState, useEffect, useCallback } from 'react';
import type { IvrEvent } from '../types/sip';

// ── helpers ───────────────────────────────────────────────────────────────────
async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  const isToday = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return isToday ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + t;
}

// ── event metadata ────────────────────────────────────────────────────────────
const EVENT_META: Record<string, { label: string; color: string; bg: string }> = {
  ivr_entered:           { label: 'IVR Entered',           color: '#2563eb', bg: '#eff6ff' },
  ivr_option_selected:   { label: 'Option Selected',        color: '#16a34a', bg: '#f0fdf4' },
  ivr_replayed:          { label: 'Menu Replayed',          color: '#7c3aed', bg: '#f5f3ff' },
  ivr_timeout:           { label: 'Timeout',                color: '#d97706', bg: '#fffbeb' },
  ivr_invalid_input:     { label: 'Invalid Input',          color: '#dc2626', bg: '#fef2f2' },
  agent_ringing:         { label: 'Agent Ringing',          color: '#0891b2', bg: '#ecfeff' },
  agent_answered:        { label: 'Agent Answered',         color: '#16a34a', bg: '#f0fdf4' },
  voicemail_started:     { label: 'Voicemail Started',      color: '#d97706', bg: '#fffbeb' },
  voicemail_completed:   { label: 'Voicemail Saved',        color: '#16a34a', bg: '#f0fdf4' },
  transcription_completed:{ label: 'Transcribed',           color: '#7c3aed', bg: '#f5f3ff' },
  caller_hangup:         { label: 'Caller Hung Up',         color: '#64748b', bg: '#f1f5f9' },
};

function eventMeta(type: string) {
  return EVENT_META[type] ?? { label: type, color: '#64748b', bg: '#f1f5f9' };
}

// ── FlowNode ──────────────────────────────────────────────────────────────────
function FlowBox({
  label, sub, color, bg, border,
}: { label: string; sub?: string; color: string; bg: string; border: string }) {
  return (
    <div style={{
      background: bg, border: `1.5px solid ${border}`,
      borderRadius: 'var(--radius-md)', padding: '12px 18px',
      textAlign: 'center', boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontWeight: 700, fontSize: 13, color }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: color + 'aa', marginTop: 3, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );
}

function VLine({ color = 'var(--border)' }: { color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: 2, height: 22, background: color }} />
    </div>
  );
}

function Arrow() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '2px 0' }}>
      <div style={{ width: 2, height: 18, background: 'var(--border)' }} />
      <div style={{ width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '7px solid var(--border)' }} />
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────
export function IVRMenu() {
  const [tab,     setTab]     = useState<'flow' | 'events' | 'setup'>('flow');
  const [events,  setEvents]  = useState<IvrEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [filterSid, setFilterSid] = useState('');

  const loadEvents = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const url = filterSid.trim()
        ? `/api/ivr-events?call_sid=${encodeURIComponent(filterSid.trim())}`
        : '/api/ivr-events';
      setEvents(await apiFetch<IvrEvent[]>(url));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [filterSid]);

  useEffect(() => {
    if (tab === 'events') loadEvents();
  }, [tab, loadEvents]);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 26 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
          IVR Menu
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          All inbound PSTN calls are routed through this Interactive Voice Response system.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 26 }}>
        {(['flow', 'events', 'setup'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', fontSize: 13,
            fontWeight: tab === t ? 700 : 400,
            border: 'none', background: 'transparent',
            color: tab === t ? 'var(--blue)' : 'var(--text-secondary)',
            borderBottom: tab === t ? '2px solid var(--blue)' : '2px solid transparent',
            cursor: 'pointer', marginBottom: -1, transition: 'color 0.15s',
            textTransform: 'capitalize',
          }}>
            {t === 'flow' ? 'Call Flow' : t === 'events' ? 'Live Events' : 'Setup'}
          </button>
        ))}
      </div>

      {/* ── Call Flow ───────────────────────────────────────────────────────── */}
      {tab === 'flow' && (
        <div>
          {/* Entry */}
          <FlowBox label="Inbound PSTN Call" sub="POST /webhooks/voice/incoming" color="#0f172a" bg="#f8fafc" border="#cbd5e1" />
          <Arrow />

          {/* IVR Menu */}
          <FlowBox
            label="IVR Menu Greeting"
            sub={'"Welcome to ABC Company. Press 1 for an agent · Press 2 for voicemail · Press 9 to replay"'}
            color="#1e3a5f" bg="#eff6ff" border="#2563eb"
          />

          {/* Retry note */}
          <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 6px' }}>
            No input / Invalid key → retry (max 3×) → hangup
          </div>

          {/* Branch row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 6 }}>
            {/* Option 1 */}
            <div>
              <div style={{ textAlign: 'center', marginBottom: 6 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, borderRadius: '50%',
                  background: '#f0fdf4', border: '2px solid #16a34a',
                  fontWeight: 700, fontSize: 15, color: '#16a34a',
                }}>1</span>
              </div>
              <VLine color="#16a34a" />
              <FlowBox label="Connect to Agent" sub="Conference room created · Rings softphone client" color="#14532d" bg="#f0fdf4" border="#16a34a" />
              <VLine color="#16a34a" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <FlowBox label="Agent Answers" sub="Joins conference" color="#14532d" bg="#dcfce7" border="#86efac" />
                <FlowBox label="No Answer (20s)" sub="Press 1 hold · Press 2 voicemail" color="#92400e" bg="#fffbeb" border="#fcd34d" />
              </div>
            </div>

            {/* Option 2 */}
            <div>
              <div style={{ textAlign: 'center', marginBottom: 6 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, borderRadius: '50%',
                  background: '#fffbeb', border: '2px solid #d97706',
                  fontWeight: 700, fontSize: 15, color: '#d97706',
                }}>2</span>
              </div>
              <VLine color="#d97706" />
              <FlowBox label="Record Voicemail" sub='"Please leave a message after the tone"' color="#92400e" bg="#fffbeb" border="#d97706" />
              <VLine color="#d97706" />
              <FlowBox label="Save Recording" sub="Stored to DB · URL preserved" color="#92400e" bg="#fef3c7" border="#fcd34d" />
              <VLine color="#d97706" />
              <FlowBox label="Transcription" sub="Async callback when ready" color="#7c3aed" bg="#f5f3ff" border="#a78bfa" />
              <VLine color="#d97706" />
              <FlowBox label="Thank You · Hangup" sub={''} color="#475569" bg="#f8fafc" border="#cbd5e1" />
            </div>

            {/* Option 9 */}
            <div>
              <div style={{ textAlign: 'center', marginBottom: 6 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, borderRadius: '50%',
                  background: '#f5f3ff', border: '2px solid #7c3aed',
                  fontWeight: 700, fontSize: 15, color: '#7c3aed',
                }}>9</span>
              </div>
              <VLine color="#7c3aed" />
              <FlowBox label="Replay Menu" sub="Returns to greeting" color="#4a1d96" bg="#f5f3ff" border="#7c3aed" />
              <div style={{ textAlign: 'center', fontSize: 20, color: '#7c3aed', marginTop: 8 }}>↑</div>
            </div>
          </div>

          {/* Webhook config hint */}
          <div style={{
            marginTop: 24, padding: '12px 16px',
            background: 'var(--blue-light)', border: '1px solid var(--blue-dim)',
            borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--blue)',
            fontFamily: 'var(--font-mono)',
          }}>
            Twilio webhook (POST): <strong>{'https://<your-host>/webhooks/voice/incoming'}</strong>
          </div>
        </div>
      )}

      {/* ── Live Events ─────────────────────────────────────────────────────── */}
      {tab === 'events' && (
        <div>
          {/* Filter + Refresh */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={filterSid}
              onChange={(e) => setFilterSid(e.target.value)}
              placeholder="Filter by Call SID (CA…)"
              style={{
                flex: 1, padding: '8px 12px', fontSize: 13,
                border: '1.5px solid var(--border)', borderRadius: 'var(--radius-md)',
                background: 'var(--surface)', color: 'var(--text-primary)', outline: 'none',
              }}
              onKeyDown={(e) => e.key === 'Enter' && loadEvents()}
            />
            <button onClick={loadEvents} style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              background: 'var(--blue)', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
            }}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {error && (
            <div style={{ padding: '10px 14px', background: 'var(--red-light)', color: 'var(--red)', border: '1px solid var(--red-dim)', borderRadius: 'var(--radius-md)', marginBottom: 14, fontSize: 13 }}>
              {error}
            </div>
          )}

          {!loading && events.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 20px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)', fontSize: 14 }}>
              No IVR events yet. Events appear here as inbound calls arrive.
            </div>
          )}

          {events.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--border-light)', borderBottom: '1px solid var(--border)' }}>
                    {['Time', 'Call SID', 'Event', 'Option'].map((h) => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev, idx) => {
                    const meta = eventMeta(ev.event_type);
                    return (
                      <tr key={ev.id} style={{ borderBottom: idx < events.length - 1 ? '1px solid var(--border-light)' : 'none' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#fafafa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {fmtTime(ev.created_at)}
                        </td>
                        <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ev.call_sid}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center',
                            padding: '2px 10px', borderRadius: 99,
                            fontSize: 11, fontWeight: 700,
                            background: meta.bg, color: meta.color,
                          }}>
                            {meta.label}
                          </span>
                        </td>
                        <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {ev.selected_option ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Setup ───────────────────────────────────────────────────────────── */}
      {tab === 'setup' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SetupStep n={1} title="Start the server">
            <code style={codeStyle}>npm run server</code>
          </SetupStep>
          <SetupStep n={2} title="Expose via ngrok">
            <code style={codeStyle}>ngrok http 3001</code>
            <p style={noteStyle}>Copy the <em>https</em> forwarding URL.</p>
          </SetupStep>
          <SetupStep n={3} title="Set Twilio webhook">
            <p style={noteStyle}>
              Twilio Console → Phone Numbers → your number → Voice &amp; Fax →
              A Call Comes In → Webhook (HTTP POST):
            </p>
            <code style={codeStyle}>{'https://<ngrok-host>/webhooks/voice/incoming'}</code>
          </SetupStep>
          <SetupStep n={4} title="Optional: status callbacks">
            <p style={noteStyle}>Set the same number's Status Callback to:</p>
            <code style={codeStyle}>{'https://<ngrok-host>/webhooks/voice/caller-hangup'}</code>
            <p style={noteStyle}>This updates call records when callers hang up.</p>
          </SetupStep>

          {/* env vars */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--border-light)' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>.env</span>
            </div>
            <pre style={{ margin: 0, padding: 16, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', background: '#f8fafc', lineHeight: 1.8 }}>
{`TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=your_api_secret
TWILIO_TWIML_APP_SID=APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
PUBLIC_URL=https://<ngrok-host>   # optional — for status callbacks`}
            </pre>
          </div>

          {/* DB note */}
          <div style={{ padding: '12px 16px', background: 'var(--amber-light)', border: '1px solid var(--amber-dim)', borderRadius: 'var(--radius-md)', fontSize: 13, color: '#78350f', lineHeight: 1.6 }}>
            <strong>Database:</strong> New tables/columns are created automatically on server start.
            No manual migration needed.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Setup step card ───────────────────────────────────────────────────────────
function SetupStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          width: 24, height: 24, borderRadius: '50%', background: 'var(--blue)', color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, flexShrink: 0,
        }}>{n}</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{title}</span>
      </div>
      <div style={{ paddingLeft: 34 }}>{children}</div>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  background: '#f8fafc',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 12px',
  color: 'var(--text-primary)',
  marginTop: 6,
};

const noteStyle: React.CSSProperties = {
  margin: '6px 0 4px',
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
};
