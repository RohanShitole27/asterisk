import { useState, useEffect } from 'react';
import type { User, UserRole } from '../types/sip';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

type FormState = { name: string; email: string; password: string; role: UserRole; extension: string; isActive: boolean };
const emptyForm: FormState = { name: '', email: '', password: '', role: 'agent', extension: '', isActive: true };

const ROLE_META: Record<UserRole, { label: string; color: string; bg: string }> = {
  admin:   { label: 'Admin',   color: '#7c3aed', bg: '#f5f3ff' },
  manager: { label: 'Manager', color: '#0891b2', bg: '#ecfeff' },
  agent:   { label: 'Agent',   color: '#16a34a', bg: '#f0fdf4' },
};

export function Users() {
  const [users, setUsers]     = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [editUser, setEditUser]   = useState<User | null>(null);
  const [form, setForm]           = useState<FormState>(emptyForm);
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [teamManager, setTeamManager]   = useState<User | null>(null);
  const [teamSelection, setTeamSelection] = useState<Set<number>>(new Set());
  const [teamSaving, setTeamSaving]     = useState(false);
  const [teamError, setTeamError]       = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try {
      setUsers(await apiFetch<User[]>('/api/users'));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }

  function openAdd() {
    setEditUser(null);
    setForm(emptyForm);
    setFormError(null);
    setShowModal(true);
  }

  function openEdit(u: User) {
    setEditUser(u);
    setForm({ name: u.name, email: u.email, password: '', role: u.role, extension: u.extension ?? '', isActive: u.isActive });
    setFormError(null);
    setShowModal(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || (!editUser && !form.password)) {
      setFormError('Name, email, and password are required'); return;
    }
    setSaving(true); setFormError(null);
    try {
      if (editUser) {
        await apiFetch(`/api/users/${editUser.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name, role: form.role, extension: form.extension || null,
            isActive: form.isActive, password: form.password || undefined,
          }),
        });
      } else {
        await apiFetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name, email: form.email, password: form.password,
            role: form.role, extension: form.extension || null,
          }),
        });
      }
      setShowModal(false);
      await load();
    } catch (e: unknown) {
      setFormError((e as Error).message);
    } finally { setSaving(false); }
  }

  function openTeam(manager: User) {
    setTeamManager(manager);
    setTeamSelection(new Set(users.filter((u) => u.role === 'agent' && u.managerId === manager.id).map((u) => u.id)));
    setTeamError(null);
  }

  function toggleAgent(id: number) {
    setTeamSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function saveTeam() {
    if (!teamManager) return;
    setTeamSaving(true); setTeamError(null);
    try {
      const updated = await apiFetch<User[]>(`/api/users/${teamManager.id}/team`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentIds: Array.from(teamSelection) }),
      });
      setUsers(updated);
      setTeamManager(null);
    } catch (e: unknown) {
      setTeamError((e as Error).message);
    } finally { setTeamSaving(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError(null);
    try {
      await apiFetch(`/api/users/${deleteTarget.id}`, { method: 'DELETE' });
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e: unknown) {
      setDeleteError((e as Error).message);
    } finally { setDeleting(false); }
  }

  const agents = users.filter((u) => u.role === 'agent');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Users</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>Manage employee accounts, roles, and extensions.</p>
        </div>
        <button onClick={openAdd} style={primaryBtn}>+ Add User</button>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--border-light)', borderBottom: '1px solid var(--border)' }}>
                {['Name', 'Email', 'Role', 'Extension', 'Status', 'Team', ''].map((h, i) => (
                  <th key={i} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, idx) => {
                const meta = ROLE_META[u.role];
                const teamCount = u.role === 'manager' ? agents.filter((a) => a.managerId === u.id).length : null;
                const managerName = u.role === 'agent' && u.managerId ? users.find((m) => m.id === u.managerId)?.name : null;
                return (
                  <tr key={u.id} style={{ borderBottom: idx < users.length - 1 ? '1px solid var(--border-light)' : 'none' }}>
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>{u.name}</td>
                    <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{u.email}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{ padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: meta.bg, color: meta.color }}>{meta.label}</span>
                    </td>
                    <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{u.extension ?? '—'}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: u.isActive ? 'var(--green)' : 'var(--text-muted)' }}>
                        {u.isActive ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
                      {teamCount !== null ? `${teamCount} agent${teamCount === 1 ? '' : 's'}` : managerName ?? '—'}
                    </td>
                    <td style={{ padding: '12px 16px', display: 'flex', gap: 8 }}>
                      <button onClick={() => openEdit(u)} style={editBtn}>Edit</button>
                      {u.role === 'manager' && (
                        <button onClick={() => openTeam(u)} style={editBtn}>Manage Team</button>
                      )}
                      <button onClick={() => { setDeleteTarget(u); setDeleteError(null); }} style={deleteBtn}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {users.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 14 }}>No users yet.</div>
          )}
        </div>
      )}

      {showModal && (
        <div style={modalOverlay} onClick={() => setShowModal(false)}>
          <form onSubmit={submit} onClick={(e) => e.stopPropagation()} style={modalBox}>
            <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {editUser ? 'Edit User' : 'Add User'}
            </h3>

            {formError && <div style={errorBox}>{formError}</div>}

            <label style={labelStyle}>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} autoFocus />

            <label style={labelStyle}>Email</label>
            <input
              type="email" value={form.email} disabled={!!editUser}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              style={{ ...inputStyle, opacity: editUser ? 0.6 : 1 }}
            />

            <label style={labelStyle}>{editUser ? 'New Password (leave blank to keep current)' : 'Password'}</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={inputStyle} />

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })} style={inputStyle}>
                  <option value="agent">Agent</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Extension</label>
                <input value={form.extension} onChange={(e) => setForm({ ...form, extension: e.target.value })} placeholder="1001" style={inputStyle} />
              </div>
            </div>

            {editUser && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                Account active
              </label>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
              <button type="button" onClick={() => setShowModal(false)} style={cancelBtn}>Cancel</button>
              <button type="submit" disabled={saving} style={{ ...primaryBtn, flex: 1 }}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {teamManager && (
        <div style={modalOverlay} onClick={() => setTeamManager(null)}>
          <div onClick={(e) => e.stopPropagation()} style={modalBox}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              Manage Team — {teamManager.name}
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
              Select which agents this manager can view calls and recordings for.
            </p>

            {teamError && <div style={errorBox}>{teamError}</div>}

            <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
              {agents.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>No agents exist yet.</div>
              ) : agents.map((a) => {
                const assignedElsewhere = a.managerId !== null && a.managerId !== teamManager.id;
                return (
                  <label
                    key={a.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                      borderBottom: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 13,
                      opacity: assignedElsewhere ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={teamSelection.has(a.id)}
                      onChange={() => toggleAgent(a.id)}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        ext {a.extension ?? '—'}{assignedElsewhere ? ' · currently with another manager' : ''}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button type="button" onClick={() => setTeamManager(null)} style={cancelBtn}>Cancel</button>
              <button type="button" onClick={saveTeam} disabled={teamSaving} style={{ ...primaryBtn, flex: 1 }}>
                {teamSaving ? 'Saving…' : 'Save Team'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={modalOverlay} onClick={() => setDeleteTarget(null)}>
          <div onClick={(e) => e.stopPropagation()} style={modalBox}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Delete User</h3>

            {deleteError && <div style={errorBox}>{deleteError}</div>}

            <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--text-secondary)' }}>
              Delete <strong>{deleteTarget.name}</strong> ({deleteTarget.email})? This cannot be undone.
            </p>
            {deleteTarget.role === 'manager' && (
              <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                Any agents reporting to them will become unassigned.
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button type="button" onClick={() => setDeleteTarget(null)} style={cancelBtn}>Cancel</button>
              <button type="button" onClick={handleDelete} disabled={deleting} style={{ ...primaryBtn, flex: 1, background: 'var(--red)' }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: '9px 18px', background: 'var(--blue)', color: '#fff', border: 'none',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
};
const editBtn: React.CSSProperties = {
  padding: '5px 12px', background: 'transparent', color: 'var(--blue)', border: '1px solid var(--blue-dim)',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
};
const deleteBtn: React.CSSProperties = {
  padding: '5px 12px', background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-dim)',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
};
const cancelBtn: React.CSSProperties = {
  padding: '9px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
};
const errorBox: React.CSSProperties = {
  padding: '10px 14px', background: 'var(--red-light)', color: 'var(--red)', border: '1px solid var(--red-dim)',
  borderRadius: 'var(--radius-md)', marginBottom: 14, fontSize: 13,
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', margin: '12px 0 5px',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', fontSize: 13, border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--surface)', color: 'var(--text-primary)',
  outline: 'none', boxSizing: 'border-box',
};
const modalOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 200, backdropFilter: 'blur(2px)',
};
const modalBox: React.CSSProperties = {
  width: '90%', maxWidth: 420, background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
  padding: '24px 26px', boxShadow: 'var(--shadow-lg)',
};
