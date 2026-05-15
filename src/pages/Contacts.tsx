import type { Contact } from '../types/sip';

const CONTACTS: Contact[] = [
  { name: 'Extension 1001', extension: '1001' },
  { name: 'Extension 1002', extension: '1002' },
];

export function Contacts({ onCall }: { onCall: (ext: string) => void }) {
  return (
    <div>
      <h2 style={{ marginBottom: 20, color: '#1e293b' }}>Contacts</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {CONTACTS.map((c) => (
          <div
            key={c.extension}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 16px', border: '1px solid #e2e8f0',
              borderRadius: 10, background: '#fff',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, color: '#1e293b' }}>{c.name}</div>
              <div style={{ fontSize: 13, color: '#64748b', fontFamily: 'monospace', marginTop: 2 }}>
                {c.extension}
              </div>
            </div>
            <button
              onClick={() => onCall(c.extension)}
              style={{
                padding: '8px 18px', background: '#22c55e', color: '#fff',
                border: 'none', borderRadius: 6, cursor: 'pointer',
                fontWeight: 600, fontSize: 14,
              }}
            >
              Call
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
