import { useState, useEffect, useRef } from 'react';

interface VoicemailMessage {
  id: number;
  caller: string;
  duration: number | null;
  received_at: string;
  is_read: boolean;
  notes: string | null;
  recording_sid:          string | null;
  recording_url:          string | null;
  transcript:             string | null;
  transcript_confidence:  number | null;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

function fmtDuration(sec: number | null) {
  if (sec === null) return '\u2014';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const isToday = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today \u00b7 ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' \u00b7 ' + time;
}

export function Voicemail({ onCall }: { onCall: (ext: string) => void }) {
  const [messages, setMessages] = useState<VoicemailMessage[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const [showAdd, setShowAdd]     = useState(false);
  const [form, setForm]           = useState({ caller: '', duration: '', notes: '' });
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<VoicemailMessage | null>(null);
  const [deleting, setDeleting]         = useState(false);

  const callerRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadMessages(); }, []);
  useEffect(() => { if (showAdd) callerRef.current?.focus(); }, [showAdd]);

  async function loadMessages() {
    setLoading(true); setError(null);
    try {
      setMessages(await apiFetch<VoicemailMessage[]>('/api/voicemails'));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }

  async function markRead(id: number) {
    try {
      const updated = await apiFetch<VoicemailMessage>(`/api/voicemails/${id}/read`, { method: 'PATCH' });
      setMessages((prev) => prev.map((m) => (m.id === id ? updated : m)));
    } catch { /* non-critical */ }
  }

  async function handleAdd() {
    if (!form.caller.trim()) { setFormError('Caller is required.'); return; }
    setSaving(true); setFormError(null);
    try {
      const created = await apiFetch<VoicemailMessage>('/api/voicemails', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caller: form.caller.trim(),
          duration: form.duration ? Number(form.duration) : null,
          notes: form.notes.trim() || null,
        }),
      });
      setMessages((prev) => [created, ...prev]);
      setShowAdd(false);
      setForm({ caller: '', duration: '', notes: '' });
    } catch (e: unknown) {
      setFormError((e as Error).message);
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await fetch(`/api/voicemails/${deleteTarget.id}`, { method: 'DELETE' });
      setMessages((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch { /* ignore */ } finally { setDeleting(false); }
  }

  const unread = messages.filter((m) => !m.is_read).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Voicemail</h2>
          {unread > 0 && (
            <span style={{
              background: 'var(--red)', color: '#fff',
              borderRadius: 99, padding: '1px 9px', fontSize: 11, fontWeight: 700,
            }}>
              {unread} new
            </span>
          )}
        </div>
        <button
          onClick={() => { setShowAdd(true); setFormError(null); setForm({ caller: '', duration: '', notes: '' }); }}
          style={primaryBtn}
        >
          + Add Message
        </button>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading&hellip;</div>}
      {error && <div style={errorBlock}>Error: {error}</div>}

      {!loading && !error && messages.length === 0 && (
        <div style={emptyState}>
          <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.25 }}>&#9990;</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>No voicemail messages.</div>
        </div>
      )}

      <div style={{
        background: messages.length ? 'var(--surface)' : 'transparent',
        borderRadius: 'var(--radius-lg)',
        border: messages.length ? '1px solid var(--border)' : 'none',
        boxShadow: messages.length ? 'var(--shadow-sm)' : 'none',
        overflow: 'hidden',
      }}>
        {messages.map((m, idx) => (
          <div
            key={m.id}
            style={{
              display: 'flex', alignItems: 'center',
              padding: '14px 18px',
              borderBottom: idx < messages.length - 1 ? '1px solid var(--border-light)' : 'none',
              background: m.is_read ? 'transparent' : 'var(--blue-light)',
              transition: 'background 0.1s',
            }}
          >
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: m.is_read ? 'transparent' : 'var(--blue)',
              flexShrink: 0, marginRight: 14,
            }} />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-primary)' }}>
                  {m.caller}
                </span>
                {!m.is_read && (
                  <span style={{
                    background: 'var(--blue)', color: '#fff',
                    borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700,
                    letterSpacing: '0.05em',
                  }}>NEW</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-muted)' }}>
                <span>{fmtDate(m.received_at)}</span>
                <span>{fmtDuration(m.duration)}</span>
              </div>
              {m.notes && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, fontStyle: 'italic' }}>
                  {m.notes}
                </div>
              )}
              {/* Transcript */}
              {m.transcript && (
                <div style={{
                  marginTop: 8, padding: '8px 10px',
                  background: '#f5f3ff', border: '1px solid #ddd6fe',
                  borderRadius: 'var(--radius-sm)', fontSize: 12,
                  color: '#4a1d96', lineHeight: 1.5,
                }}>
                  <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: '0.05em', textTransform: 'uppercase', opacity: 0.7 }}>
                    Transcript{m.transcript_confidence != null ? ` · ${Math.round(m.transcript_confidence * 100)}%` : ''}
                  </span>
                  <div style={{ marginTop: 3 }}>"{m.transcript}"</div>
                </div>
              )}
              {/* Recording */}
              {m.recording_sid && (
                <div style={{ marginTop: 6 }}>
                  <audio
                    controls
                    src={`/api/recordings/${m.recording_sid}`}
                    style={{ height: 28, maxWidth: 260 }}
                  />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 12 }}>
              <button onClick={() => onCall(m.caller)} style={callBtn}>Call Back</button>
              {!m.is_read && (
                <button onClick={() => markRead(m.id)} style={ghostBtn}>Mark Read</button>
              )}
              <button onClick={() => setDeleteTarget(m)} style={dangerGhostBtn}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* Add Modal */}
      {showAdd && (
        <div style={overlay}>
          <div style={modal}>
            <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              Add Voicemail Message
            </h3>
            <label style={label}>Caller (number / extension)</label>
            <input ref={callerRef} value={form.caller}
              onChange={(e) => setForm((f) => ({ ...f, caller: e.target.value }))}
              placeholder="e.g. 1001" style={inputStyle} />
            <label style={{ ...label, marginTop: 14 }}>Duration (seconds, optional)</label>
            <input value={form.duration} type="number" min="0"
              onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
              placeholder="e.g. 45" style={inputStyle} />
            <label style={{ ...label, marginTop: 14 }}>Notes (optional)</label>
            <input value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="e.g. Please call back" style={inputStyle} />
            {formError && <div style={formErr}>{formError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 22, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAdd(false)} disabled={saving} style={cancelBtn}>Cancel</button>
              <button onClick={handleAdd} disabled={saving} style={primaryBtn}>
                {saving ? 'Saving\u2026' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {deleteTarget && (
        <div style={overlay}>
          <div style={modal}>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              Delete Voicemail
            </h3>
            <p style={{ color: 'var(--text-secondary)', margin: '0 0 22px', fontSize: 14 }}>
              Delete voicemail from <strong>{deleteTarget.caller}</strong>? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} style={cancelBtn}>Cancel</button>
              <button onClick={handleDelete} disabled={deleting}
                style={{ ...primaryBtn, background: 'var(--red)' }}>
                {deleting ? 'Deleting\u2026' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const primaryBtn: React.CSSProperties = {
  padding: '8px 18px', background: 'var(--blue)', color: '#fff',
  border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontWeight: 600, fontSize: 13,
};

const callBtn: React.CSSProperties = {
  padding: '6px 14px', background: 'var(--green-light)', color: 'var(--green)',
  border: '1px solid var(--green-dim)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontWeight: 600, fontSize: 12,
};

const ghostBtn: React.CSSProperties = {
  padding: '6px 14px', background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontWeight: 500, fontSize: 12,
};

const dangerGhostBtn: React.CSSProperties = {
  padding: '6px 14px', background: 'transparent', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontWeight: 500, fontSize: 12,
};

const cancelBtn: React.CSSProperties = {
  padding: '8px 18px', background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontWeight: 500, fontSize: 13,
};

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
  backdropFilter: 'blur(2px)',
};

const modal: React.CSSProperties = {
  background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '28px 30px',
  minWidth: 380, boxShadow: 'var(--shadow-lg)',
  animation: 'fadeIn 0.15s ease-out',
};

const label: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'var(--text-secondary)', marginBottom: 6, letterSpacing: '0.02em',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px',
  border: '1.5px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontSize: 14, outline: 'none', boxSizing: 'border-box',
  color: 'var(--text-primary)', background: 'var(--surface)',
  transition: 'border-color 0.15s',
};

const formErr: React.CSSProperties = {
  color: 'var(--red)', fontSize: 12, marginTop: 10,
};

const errorBlock: React.CSSProperties = {
  color: 'var(--red)', background: 'var(--red-light)',
  border: '1px solid var(--red-dim)',
  padding: '10px 14px', borderRadius: 'var(--radius-md)',
  fontSize: 13, marginBottom: 16,
};

const emptyState: React.CSSProperties = {
  textAlign: 'center', padding: '60px 20px',
  background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--border)',
};
