import type { CallLogEntry } from '../types/sip';

function fmt(sec: number | null) {
  if (sec === null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const statusColor: Record<CallLogEntry['status'], string> = {
  answered: '#22c55e',
  missed: '#f59e0b',
  failed: '#ef4444',
};

export function CallLogs({ logs }: { logs: CallLogEntry[] }) {
  return (
    <div>
      <h2 style={{ marginBottom: 20, color: '#1e293b' }}>Call Logs</h2>
      {logs.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>No calls yet — make a call from the Softphone tab.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              {['Dir', 'Number', 'Time', 'Duration', 'Status'].map((h) => (
                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#475569', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '10px 12px' }}>
                  <span style={{
                    background: log.direction === 'inbound' ? '#dbeafe' : '#f0fdf4',
                    color: log.direction === 'inbound' ? '#1d4ed8' : '#15803d',
                    padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600,
                  }}>
                    {log.direction === 'inbound' ? '↙ In' : '↗ Out'}
                  </span>
                </td>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace' }}>{log.remoteIdentity}</td>
                <td style={{ padding: '10px 12px', color: '#64748b' }}>
                  {log.startTime.toLocaleTimeString()}
                </td>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace' }}>{fmt(log.duration)}</td>
                <td style={{ padding: '10px 12px' }}>
                  <span style={{ color: statusColor[log.status], fontWeight: 600, textTransform: 'capitalize' }}>
                    {log.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
