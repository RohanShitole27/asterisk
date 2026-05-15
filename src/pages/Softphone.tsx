import { useState } from 'react';
import type { useAsteriskPhone } from '../hooks/useAsteriskPhone';

type PhoneAPI = ReturnType<typeof useAsteriskPhone>;

const KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];

const btn = (bg: string): React.CSSProperties => ({
  padding: '13px 0', fontSize: 18, borderRadius: 8,
  border: 'none', cursor: 'pointer', background: bg,
  color: '#fff', fontWeight: 600, flex: 1,
});

export function Softphone({ phone }: { phone: PhoneAPI }) {
  const [input, setInput] = useState('');
  const { state, makeCall, answerCall, hangUp, toggleMute, sendDtmf } = phone;
  const inCall = state.callStatus !== 'idle';

  const pressKey = (k: string) => {
    if (state.callStatus === 'answered') sendDtmf(k);
    else setInput((p) => p + k);
  };

  const dial = () => {
    const n = input.trim();
    if (!n) return;
    makeCall(n);
    setInput('');
  };

  return (
    <div style={{ maxWidth: 320, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 20, color: '#1e293b' }}>Softphone</h2>

      {state.error && (
        <div style={{
          background: '#fee2e2', color: '#dc2626', borderRadius: 8,
          padding: '10px 14px', marginBottom: 16, fontSize: 13, lineHeight: 1.4,
        }}>
          {state.error}
        </div>
      )}

      {inCall && (
        <div style={{
          background: state.callStatus === 'incoming' ? '#fef3c7' : '#f0fdf4',
          border: `1px solid ${state.callStatus === 'incoming' ? '#fcd34d' : '#86efac'}`,
          borderRadius: 10, padding: '14px 16px', marginBottom: 16, textAlign: 'center',
        }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{state.remoteIdentity}</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
            {state.callStatus === 'incoming' && 'Incoming call…'}
            {state.callStatus === 'ringing' && 'Ringing…'}
            {state.callStatus === 'answered' && (state.muted ? 'On call · muted' : 'On call')}
          </div>
        </div>
      )}

      {!inCall && (
        <input
          type="tel"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dial()}
          placeholder="Extension or number"
          style={{
            width: '100%', padding: '10px 14px', fontSize: 22,
            textAlign: 'center', letterSpacing: 3,
            border: '2px solid #e2e8f0', borderRadius: 8,
            marginBottom: 12, outline: 'none',
          }}
        />
      )}

      {/* Dialpad */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        {KEYS.map((k) => (
          <button
            key={k}
            onClick={() => pressKey(k)}
            style={{
              padding: '16px 0', fontSize: 20, borderRadius: 8,
              border: '1px solid #e2e8f0', cursor: 'pointer',
              background: '#f8fafc', fontWeight: 500,
            }}
          >
            {k}
          </button>
        ))}
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', gap: 8 }}>
        {!inCall && (
          <>
            {input && (
              <button onClick={() => setInput((p) => p.slice(0, -1))} style={btn('#94a3b8')}>
                ⌫
              </button>
            )}
            <button
              onClick={dial}
              disabled={!state.registered || !input.trim()}
              style={{ ...btn('#22c55e'), opacity: (!state.registered || !input.trim()) ? 0.45 : 1 }}
            >
              Call
            </button>
          </>
        )}

        {state.callStatus === 'incoming' && (
          <>
            <button onClick={answerCall} style={btn('#22c55e')}>Answer</button>
            <button onClick={hangUp} style={btn('#ef4444')}>Reject</button>
          </>
        )}

        {(state.callStatus === 'ringing' || state.callStatus === 'answered') && (
          <>
            <button onClick={hangUp} style={btn('#ef4444')}>Hang Up</button>
            {state.callStatus === 'answered' && (
              <button onClick={toggleMute} style={btn(state.muted ? '#f59e0b' : '#64748b')}>
                {state.muted ? 'Unmute' : 'Mute'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
