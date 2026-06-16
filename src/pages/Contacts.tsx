import { useState, useEffect } from 'react';
import type { Contact } from '../types/sip';

type FormState = { name: string; extension: string };
const emptyForm: FormState = { name: '', extension: '' };

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

function initials(name: string) {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = ['#2563eb','#7c3aed','#db2777','#059669','#d97706','#0891b2'];
function avatarColor(id: number) { return AVATAR_COLORS[id % AVATAR_COLORS.length]; }

export function Contacts({ onCall }: { onCall: (ext: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const [showModal, setShowModal]     = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [form, setForm]               = useState<FormState>(emptyForm);
  const [saving, setSaving]           = useState(false);
  const [formError, setFormError]     = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting]         = useState(false);

  useEffect(() => { loadContacts(); }, []);

  async function loadContacts() {
    setLoading(true); setError(null);
    try {
      setContacts(await apiFetch<Contact[]>('/api/contacts'));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }

  function openAdd() {
    setEditContact(null); setForm(emptyForm); setFormError(null); setShowModal(true);
  }

  function openEdit(c: Contact) {
    setEditContact(c); setForm({ name: c.name, extension: c.extension }); setFormError(null); setShowModal(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.extension.trim()) {
      setFormError('Name and extension are required.'); return;
    }
    setSaving(true); setFormError(null);
    try {
      if (editContact) {
        const updated = await apiFetch<Contact>(`/api/contacts/${editContact.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
        });
        setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      } else {
        const created = await apiFetch<Contact>('/api/contacts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
        });
        setContacts((prev) => [...prev, created]);
      }
      setShowModal(false);
    } catch (e: unknown) {
      setFormError((e as Error).message);
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/contacts/${deleteTarget.id}`, { method: 'DELETE' });
      setContacts((prev) => prev.filter((c) => c.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e: unknown) {
      alert((e as Error).message);
    } finally { setDeleting(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Contacts</h2>
          {!loading && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{contacts.length} contact{contacts.length !== 1 ? 's' : ''}</div>}
        </div>
        <button onClick={openAdd} style={primaryBtn}>+ Add Contact</button>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading\u2026</div>}
      {error && <div style={errorBlock}>Error: {error}</div>}

      {!loading && !error && contacts.length === 0 && (
        <div style={emptyState}>
          <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.25 }}>&#9993;</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>No contacts yet. Click &ldquo;+ Add Contact&rdquo; to create one.</div>
        </div>
      )}

      <div style={{
        background: 'var(--surface)',
        borderRadius: 'var(--radius-lg)',
        border: contacts.length ? '1px solid var(--border)' : 'none',
        boxShadow: contacts.length ? 'var(--shadow-sm)' : 'none',
        overflow: 'hidden',
      }}>
        {contacts.map((c, idx) => (
          <div
            key={c.id}
            style={{
              display: 'flex', alignItems: 'center',
              padding: '14px 18px',
              borderBottom: idx < contacts.length - 1 ? '1px solid var(--border-light)' : 'none',
              transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#fafafa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            {/* Avatar */}
            <div style={{
              width: 38, height: 38, borderRadius: '50%',
              background: avatarColor(c.id),
              color: '#fff', fontWeight: 700, fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, marginRight: 14, letterSpacing: '0.02em',
            }}>
              {initials(c.name)}
            </div>

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{c.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>{c.extension}</div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button onClick={() => onCall(c.extension)} style={callBtn}>Call</button>
              <button onClick={() => openEdit(c)} style={ghostBtn}>Edit</button>
              <button onClick={() => setDeleteTarget(c)} style={dangerGhostBtn}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* Add / Edit Modal */}
      {showModal && (
        <div style={overlay}>
          <div style={modal}>
            <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {editContact ? 'Edit Contact' : 'New Contact'}
            </h3>
            <label style={label}>Name</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Alice" style={input} autoFocus />
            <label style={{ ...label, marginTop: 14 }}>Extension</label>
            <input value={form.extension} onChange={(e) => setForm((f) => ({ ...f, extension: e.target.value }))}
              placeholder="e.g. 1001" style={input} />
            {formError && <div style={formErr}>{formError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 22, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowModal(false)} disabled={saving} style={cancelBtn}>Cancel</button>
              <button onClick={handleSave} disabled={saving} style={primaryBtn}>{saving ? 'Saving\u2026' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {deleteTarget && (
        <div style={overlay}>
          <div style={modal}>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Delete Contact</h3>
            <p style={{ color: 'var(--text-secondary)', margin: '0 0 22px', fontSize: 14 }}>
              Delete <strong>{deleteTarget.name}</strong> ({deleteTarget.extension})? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} style={cancelBtn}>Cancel</button>
              <button onClick={handleDelete} disabled={deleting} style={{ ...primaryBtn, background: 'var(--red)' }}>
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
  background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '28px 24px',
  width: '90%', maxWidth: 420, boxShadow: 'var(--shadow-lg)',
  animation: 'fadeIn 0.15s ease-out',
};

const label: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'var(--text-secondary)', marginBottom: 6, letterSpacing: '0.02em',
};

const input: React.CSSProperties = {
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
