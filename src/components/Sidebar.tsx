import { useEffect, useState } from 'react';
import type { CallStatus, User, UserRole } from '../types/sip';

type Page = 'dashboard' | 'softphone' | 'logs' | 'contacts' | 'voicemail' | 'users';

interface SidebarProps {
  currentPage:      Page;
  onNavigate:       (page: Page) => void;
  registered:       boolean;
  registering:      boolean;
  twilioReady:      boolean;
  callStatus:       CallStatus;
  unreadVoicemails: number;
  isMobile:         boolean;
  user:             User;
  onLogout:         () => void;
}

const NAV: { key: Page; label: string; icon: string; visibleFor?: UserRole[] }[] = [
  { key: 'dashboard', label: 'Dashboard',  icon: '▦' },
  { key: 'logs',      label: 'Call Logs',  icon: '≡' },
  { key: 'voicemail', label: 'Voicemails', icon: '▶' },
  { key: 'contacts',  label: 'Contacts',   icon: '◎' },
  { key: 'softphone', label: 'Softphone',  icon: '⌨' },
  { key: 'users',      label: 'Users',      icon: '👤', visibleFor: ['admin'] },
];

export function Sidebar({
  currentPage, onNavigate,
  registered, registering, twilioReady,
  callStatus, unreadVoicemails, isMobile,
  user, onLogout,
}: SidebarProps) {
  const nav = NAV.filter((n) => !n.visibleFor || n.visibleFor.includes(user.role));
  const sipColor = registered ? '#4ade80' : registering ? '#fbbf24' : '#f87171';
  const sipLabel =
    callStatus !== 'idle'
      ? callStatus.charAt(0).toUpperCase() + callStatus.slice(1)
      : registered  ? 'SIP · Ready'
      : registering ? 'SIP · Connecting'
      : 'SIP · Offline';

  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (callStatus !== 'incoming') { setBlink(false); return; }
    const id = setInterval(() => setBlink((b) => !b), 600);
    return () => clearInterval(id);
  }, [callStatus]);

  // ── Mobile: top bar (user + logout) + bottom tab bar ────────────────────────
  if (isMobile) {
    return (
      <>
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: 48,
          background: '#0f172a', borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 14px', zIndex: 100,
          paddingTop: 'env(safe-area-inset-top)',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user.name}
            </div>
            <div style={{ fontSize: 10, color: 'var(--sidebar-muted)' }}>
              {user.role.charAt(0).toUpperCase() + user.role.slice(1)}{user.extension ? ` · ext ${user.extension}` : ''}
            </div>
          </div>
          <button
            onClick={onLogout}
            style={{
              flexShrink: 0, padding: '6px 12px', fontSize: 11, fontWeight: 600,
              background: 'rgba(255,255,255,0.06)', border: '1px solid var(--sidebar-border)',
              borderRadius: 6, color: 'var(--sidebar-muted)', cursor: 'pointer',
            }}
          >
            Log Out
          </button>
        </div>

        <nav style={{
          position: 'fixed',
          bottom: 0, left: 0, right: 0,
          height: 64,
          background: '#0f172a',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'stretch',
          zIndex: 100,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}>
        {nav.map(({ key, label, icon }) => {
          const isActive  = currentPage === key;
          const isRinging = key === 'softphone' && callStatus === 'incoming';
          return (
            <button
              key={key}
              onClick={() => onNavigate(key)}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                background: isRinging
                  ? (blink ? 'rgba(22,163,74,0.25)' : 'rgba(22,163,74,0.12)')
                  : 'transparent',
                border: 'none',
                borderTop: isActive
                  ? '2px solid #60a5fa'
                  : isRinging
                  ? '2px solid #4ade80'
                  : '2px solid transparent',
                cursor: 'pointer',
                padding: '6px 0 4px',
                position: 'relative',
              }}
            >
              <span style={{
                fontSize: 18,
                color: isRinging ? '#4ade80' : isActive ? '#60a5fa' : 'rgba(255,255,255,0.45)',
              }}>
                {icon}
              </span>
              <span style={{
                fontSize: 9,
                fontWeight: isActive ? 700 : 400,
                color: isRinging ? '#4ade80' : isActive ? '#60a5fa' : 'rgba(255,255,255,0.4)',
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
              }}>
                {label}
              </span>
              {key === 'voicemail' && unreadVoicemails > 0 && (
                <span style={{
                  position: 'absolute', top: 4, right: '50%', marginRight: -18,
                  background: '#ef4444', color: '#fff',
                  borderRadius: 99, fontSize: 8, fontWeight: 700,
                  padding: '1px 5px', minWidth: 14, textAlign: 'center',
                  lineHeight: '14px',
                }}>
                  {unreadVoicemails}
                </span>
              )}
              {isRinging && (
                <span style={{
                  position: 'absolute', top: 4, right: '50%', marginRight: -18,
                  background: '#4ade80', color: '#fff',
                  borderRadius: 99, fontSize: 7, fontWeight: 700,
                  padding: '1px 4px', lineHeight: '13px',
                }}>
                  ●
                </span>
              )}
            </button>
          );
        })}
        </nav>
      </>
    );
  }

  // ── Desktop: left sidebar ───────────────────────────────────────────────────
  return (
    <nav style={{
      width: 220,
      background: 'var(--sidebar-bg)',
      color: 'var(--sidebar-text)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      userSelect: 'none',
    }}>
      {/* Brand */}
      <div style={{ padding: '22px 20px 18px', borderBottom: '1px solid var(--sidebar-border)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.01em', marginBottom: 14 }}>
          VoIP Monitor
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', background: sipColor, flexShrink: 0,
            boxShadow: registered ? `0 0 6px ${sipColor}` : 'none', transition: 'background 0.3s',
          }} />
          <span style={{ fontSize: 12, color: 'var(--sidebar-muted)' }}>{sipLabel}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: twilioReady ? '#c084fc' : '#334155', flexShrink: 0,
            boxShadow: twilioReady ? '0 0 6px #c084fc' : 'none', transition: 'background 0.3s',
          }} />
          <span style={{ fontSize: 12, color: 'var(--sidebar-muted)' }}>
            {twilioReady ? 'PSTN · Ready' : 'PSTN · Offline'}
          </span>
        </div>
      </div>

      {/* Nav */}
      <div style={{ flex: 1, padding: '10px 0' }}>
        {nav.map(({ key, label, icon }) => {
          const isActive  = currentPage === key;
          const isRinging = key === 'softphone' && callStatus === 'incoming';
          return (
            <button
              key={key}
              onClick={() => onNavigate(key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', padding: '11px 20px', textAlign: 'left',
                background: isRinging
                  ? (blink ? 'rgba(22,163,74,0.25)' : 'rgba(22,163,74,0.15)')
                  : isActive ? 'rgba(255,255,255,0.07)' : 'transparent',
                color: isRinging ? '#4ade80' : isActive ? '#f1f5f9' : 'var(--sidebar-text)',
                border: 'none',
                borderLeft: isActive || isRinging
                  ? `2px solid ${isRinging ? '#4ade80' : '#60a5fa'}`
                  : '2px solid transparent',
                cursor: 'pointer', fontSize: 13,
                fontWeight: isActive ? 600 : 400,
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              <span style={{ fontSize: 15, opacity: 0.7 }}>{icon}</span>
              <span style={{ flex: 1 }}>{label}</span>
              {isRinging && (
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', color: '#4ade80', textTransform: 'uppercase' }}>
                  Ring
                </span>
              )}
              {key === 'voicemail' && unreadVoicemails > 0 && (
                <span style={{
                  background: '#ef4444', color: '#fff',
                  borderRadius: 99, padding: '1px 7px', fontSize: 10, fontWeight: 700,
                  minWidth: 18, textAlign: 'center',
                }}>
                  {unreadVoicemails}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 20px', borderTop: '1px solid var(--sidebar-border)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', marginBottom: 1 }}>{user.name}</div>
        <div style={{ fontSize: 11, color: 'var(--sidebar-muted)', marginBottom: 8 }}>
          {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
          {user.extension ? ` · ext ${user.extension}` : ''}
        </div>
        <button
          onClick={onLogout}
          style={{
            width: '100%', padding: '6px 0', fontSize: 11, fontWeight: 600,
            background: 'transparent', border: '1px solid var(--sidebar-border)',
            borderRadius: 6, color: 'var(--sidebar-muted)', cursor: 'pointer',
          }}
        >
          Log Out
        </button>
      </div>
    </nav>
  );
}
