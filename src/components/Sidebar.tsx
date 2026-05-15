import type { CallStatus } from '../types/sip';

type Page = 'softphone' | 'logs' | 'contacts';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  registered: boolean;
  registering: boolean;
  callStatus: CallStatus;
}

const NAV: { key: Page; label: string }[] = [
  { key: 'softphone', label: 'Softphone' },
  { key: 'logs', label: 'Call Logs' },
  { key: 'contacts', label: 'Contacts' },
];

export function Sidebar({ currentPage, onNavigate, registered, registering, callStatus }: SidebarProps) {
  const dotColor = registered ? '#22c55e' : registering ? '#f59e0b' : '#ef4444';
  const statusLabel =
    callStatus !== 'idle'
      ? callStatus.charAt(0).toUpperCase() + callStatus.slice(1)
      : registered
      ? 'Registered'
      : registering
      ? 'Connecting…'
      : 'Unregistered';

  return (
    <nav style={{
      width: 200,
      background: '#1e293b',
      color: '#f1f5f9',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid #334155' }}>
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 10 }}>VoIP Softphone</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span style={{
            width: 9, height: 9, borderRadius: '50%',
            background: dotColor, flexShrink: 0,
            boxShadow: registered ? `0 0 6px ${dotColor}` : 'none',
          }} />
          <span style={{ color: '#94a3b8' }}>{statusLabel}</span>
        </div>
      </div>
      <div style={{ flex: 1, paddingTop: 8 }}>
        {NAV.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onNavigate(key)}
            style={{
              display: 'block', width: '100%', padding: '12px 16px',
              textAlign: 'left',
              background: currentPage === key ? '#334155' : 'transparent',
              color: currentPage === key ? '#f1f5f9' : '#94a3b8',
              border: 'none', cursor: 'pointer', fontSize: 14,
              borderLeft: currentPage === key ? '3px solid #6366f1' : '3px solid transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ padding: '12px 16px', borderTop: '1px solid #334155', fontSize: 11, color: '#475569' }}>
        ext 1001 · 127.0.0.1:8089
      </div>
    </nav>
  );
}
