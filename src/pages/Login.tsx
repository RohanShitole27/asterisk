import { useState } from 'react';
import type { User, UserRole } from '../types/sip';

interface RoleOption {
  role: UserRole;
  label: string;
  desc: string;
  icon: string;
  color: string;
}

const ROLES: RoleOption[] = [
  { role: 'admin',   label: 'Admin',   desc: 'Manage users, extensions & routing', icon: '🛡️', color: '#7c3aed' },
  { role: 'manager', label: 'Manager', desc: 'View team calls & reports',          icon: '📊', color: '#0891b2' },
  { role: 'agent',   label: 'User',    desc: 'Make and receive calls',             icon: '☎️', color: '#16a34a' },
];

interface LoginProps {
  onLogin:  (email: string, password: string) => Promise<User>;
  onLogout: () => Promise<void>;
}

export function Login({ onLogin, onLogout }: LoginProps) {
  const [selected, setSelected] = useState<RoleOption | null>(null);
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    setLoading(true);
    try {
      const user = await onLogin(email.trim(), password);
      if (user.role !== selected.role) {
        // onLogin already established a real session for this account — since
        // the role doesn't match what the user picked, undo that and block access.
        await onLogout();
        setError(`This account is not a ${selected.label} account.`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #0f2027 0%, #1a1a2e 50%, #16213e 100%)',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      padding: 20,
    }}>
      <div style={{
        width: '100%', maxWidth: selected ? 360 : 640,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20,
        padding: '36px 32px', boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        transition: 'max-width 0.2s ease',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', margin: '0 auto 16px',
            background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, boxShadow: '0 8px 24px rgba(99,102,241,0.4)',
          }}>☎</div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#fff' }}>VoIP Monitor</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>
            {selected ? `Sign in as ${selected.label}` : 'Select how you want to sign in'}
          </p>
        </div>

        {!selected ? (
          // ── Step 1: role selection ──────────────────────────────────────────
          <div style={{ display: 'flex', gap: 14 }}>
            {ROLES.map((r) => (
              <button
                key={r.role}
                onClick={() => { setSelected(r); setError(null); }}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                  padding: '28px 14px', borderRadius: 16, cursor: 'pointer',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = `${r.color}1a`; e.currentTarget.style.borderColor = r.color; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
              >
                <span style={{ fontSize: 30 }}>{r.icon}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: r.color }}>{r.label}</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textAlign: 'center', lineHeight: 1.4 }}>{r.desc}</span>
              </button>
            ))}
          </div>
        ) : (
          // ── Step 2: credentials ─────────────────────────────────────────────
          <form onSubmit={submit}>
            <button
              type="button"
              onClick={() => { setSelected(null); setError(null); setEmail(''); setPassword(''); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, marginBottom: 18,
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: 600, padding: 0,
              }}
            >
              ← Choose a different role
            </button>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20,
              padding: '10px 14px', borderRadius: 10,
              background: `${selected.color}1a`, border: `1px solid ${selected.color}55`,
            }}>
              <span style={{ fontSize: 18 }}>{selected.icon}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: selected.color }}>{selected.label} Login</span>
            </div>

            {error && (
              <div style={{
                marginBottom: 16, padding: '10px 14px', borderRadius: 10,
                background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                color: '#fca5a5', fontSize: 13,
              }}>
                {error}
              </div>
            )}

            <label style={labelStyle}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              style={inputStyle}
              placeholder="you@company.com"
            />

            <label style={{ ...labelStyle, marginTop: 14 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={inputStyle}
              placeholder="••••••••"
            />

            <button type="submit" disabled={loading} style={{
              width: '100%', marginTop: 24, padding: '12px 0',
              background: loading ? `${selected.color}80` : selected.color,
              color: '#fff', border: 'none', borderRadius: 10,
              fontSize: 14, fontWeight: 700, cursor: loading ? 'default' : 'pointer',
              boxShadow: `0 8px 20px ${selected.color}4d`,
            }}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'rgba(255,255,255,0.5)', marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '11px 14px', fontSize: 14,
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10, color: '#fff', outline: 'none', boxSizing: 'border-box',
};
