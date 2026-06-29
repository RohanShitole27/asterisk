import { useState, useEffect, useRef } from 'react';
import type { useAsteriskPhone } from '../hooks/useAsteriskPhone';
import type { useTwilioPhone }   from '../hooks/useTwilioPhone';
import { useContacts } from '../hooks/useContacts';

type AsteriskAPI = ReturnType<typeof useAsteriskPhone>;
type TwilioAPI   = ReturnType<typeof useTwilioPhone>;

interface Props { asterisk: AsteriskAPI; twilio: TwilioAPI; pstnEnabled: boolean; }

const KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

function useCallTimer(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (active) {
      setSeconds(0);
      ref.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      if (ref.current) clearInterval(ref.current);
      setSeconds(0);
    }
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [active]);
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function Avatar({ name }: { name: string | null }) {
  const initials = name
    ? name.replace(/[^0-9a-zA-Z+]/g, '').slice(0, 2).toUpperCase()
    : '?';
  return (
    <div style={{
      width: 64, height: 64, borderRadius: '50%',
      background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 22, fontWeight: 700, color: '#fff',
      boxShadow: '0 0 0 3px rgba(99,102,241,0.3), 0 8px 24px rgba(99,102,241,0.4)',
      flexShrink: 0,
    }}>
      {initials}
    </div>
  );
}

function SignalBars({ quality }: { quality: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 }}>
      {[3, 5, 8, 11, 14].map((h, i) => (
        <div key={i} style={{
          width: 3, height: h,
          borderRadius: 2,
          background: i < quality
            ? (quality >= 4 ? '#22c55e' : quality >= 2 ? '#f59e0b' : '#ef4444')
            : 'rgba(255,255,255,0.15)',
          transition: 'background 0.3s',
        }} />
      ))}
    </div>
  );
}

export function Softphone({ asterisk, twilio, pstnEnabled }: Props) {
  const { lookupName } = useContacts();
  const [input, setInput]       = useState('');
  const [addInput, setAddInput]         = useState('');
  const [showAdd, setShowAdd]           = useState(false);
  const [showKeypad, setShowKeypad]     = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferInput, setTransferInput] = useState('');
  const [held, setHeld] = useState(false);

  const twilioActive   = twilio.state.callStatus   !== 'idle';
  const asteriskActive = asterisk.state.callStatus !== 'idle';
  const inCall = twilioActive || asteriskActive;

  const isIncoming =
    twilio.state.callStatus   === 'incoming' ||
    asterisk.state.callStatus === 'incoming';

  const isAnswered =
    twilio.state.callStatus   === 'answered' ||
    asterisk.state.callStatus === 'answered';

  const timer = useCallTimer(isAnswered);

  // Reset held state when call ends
  useEffect(() => {
    if (!asteriskActive) setHeld(false);
  }, [asteriskActive]);

  const [pulse, setPulse] = useState(false);
  const pulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (isIncoming) {
      pulseRef.current = setInterval(() => setPulse((p) => !p), 800);
    } else {
      if (pulseRef.current) clearInterval(pulseRef.current);
      setPulse(false);
    }
    return () => { if (pulseRef.current) clearInterval(pulseRef.current); };
  }, [isIncoming]);

  const conf            = asterisk.confStatus;
  const inConference    = conf !== 'none';
  const activeChannel   = twilioActive ? 'twilio' : 'asterisk';
  const remoteId        = activeChannel === 'twilio' ? twilio.state.remoteIdentity   : asterisk.state.remoteIdentity;
  const callStatus      = activeChannel === 'twilio' ? twilio.state.callStatus        : asterisk.state.callStatus;
  const muted           = activeChannel === 'twilio' ? twilio.state.muted             : asterisk.state.muted;
  const channelLabel    = activeChannel === 'twilio' ? 'PSTN' : 'SIP';
  const displayId       = remoteId ? (lookupName(remoteId) ?? remoteId) : null;

  const handleAnswer  = () => twilioActive ? twilio.answerCall()  : asterisk.answerCall();
  const handleHangUp  = () => twilioActive ? twilio.hangUp()      : asterisk.hangUp();
  const handleMute    = () => twilioActive ? twilio.toggleMute()  : asterisk.toggleMute();

  const pressKey = (k: string) => {
    if (twilio.state.callStatus === 'answered') return;
    if (asterisk.state.callStatus === 'answered') asterisk.sendDtmf(k);
    else setInput((p) => p + k);
  };

  const dialAddCall = () => {
    const n = addInput.trim();
    if (!n) return;
    asterisk.holdAndAddCall(n);
    setAddInput('');
    setShowAdd(false);
  };

  const dial = () => {
    const n = input.trim();
    if (!n) return;
    const digits = n.replace(/\D/g, '');
    if (digits.length >= 10 && pstnEnabled) twilio.makeCall(n);
    else if (digits.length < 10)            asterisk.makeCall(n);
    // 10+ digit number but PSTN disabled for this role — no-op rather than
    // attempting a call through a Device that was never registered.
    setInput('');
  };

  const canCall = (asterisk.state.registered || (pstnEnabled && twilio.state.ready)) && !inCall && input.trim();

  const getStatusLabel = () => {
    if (callStatus === 'ringing')  return 'Ringing…';
    if (callStatus === 'incoming') return 'Incoming Call';
    if (callStatus === 'answered') return `On call · ${channelLabel}`;
    return '';
  };

  return (
    <div style={{
      maxWidth: 420,
      margin: '0 auto',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>

      {/* ── Error banners ── */}
      {asterisk.state.error && <ErrorBanner msg={`SIP: ${asterisk.state.error}`} />}
      {twilio.state.error   && <ErrorBanner msg={`PSTN: ${twilio.state.error}`} />}

      {/* ── INCOMING CALL CARD ── */}
      {isIncoming && (
        <div style={{
          background: 'linear-gradient(135deg, #0f2027 0%, #1a1a2e 50%, #16213e 100%)',
          borderRadius: 24,
          padding: '32px 28px',
          marginBottom: 20,
          textAlign: 'center',
          border: '1px solid rgba(34,197,94,0.3)',
          boxShadow: `0 0 0 ${pulse ? '8px' : '3px'} rgba(34,197,94,0.15), 0 24px 64px rgba(0,0,0,0.5)`,
          transition: 'box-shadow 0.4s ease',
          animation: 'softphone-fadeIn 0.3s ease-out',
        }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: '#22c55e',
            margin: '0 auto 20px',
            boxShadow: '0 0 0 4px rgba(34,197,94,0.2)',
            animation: 'softphone-ping 1.5s ease-out infinite',
          }} />
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <Avatar name={remoteId} />
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            Incoming Call
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px', marginBottom: 8 }}>
            {displayId ?? 'Unknown'}
          </div>
          <ChannelBadge label={channelLabel} />

          <div style={{ display: 'flex', gap: 16, marginTop: 28, justifyContent: 'center' }}>
            <ActionCircle
              icon="✕"
              label="Decline"
              color="#ef4444"
              glow="rgba(239,68,68,0.4)"
              size={64}
              fontSize={22}
              onClick={handleHangUp}
            />
            <ActionCircle
              icon="✆"
              label="Answer"
              color="#22c55e"
              glow="rgba(34,197,94,0.4)"
              size={64}
              fontSize={22}
              onClick={handleAnswer}
              pulse={pulse}
            />
          </div>
        </div>
      )}

      {/* ── ACTIVE CALL CARD ── */}
      {!isIncoming && inCall && (
        <div style={{
          background: 'linear-gradient(135deg, #0f2027 0%, #1a1a2e 50%, #16213e 100%)',
          borderRadius: 24,
          padding: '28px 24px 24px',
          marginBottom: 16,
          border: `1px solid ${conf === 'conference' ? 'rgba(139,92,246,0.4)' : 'rgba(34,197,94,0.2)'}`,
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          animation: 'softphone-fadeIn 0.3s ease-out',
        }}>
          {/* Live call badge */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 7, height: 7, borderRadius: '50%', background: '#22c55e',
                animation: isAnswered ? 'softphone-ping 2s ease-out infinite' : 'none',
              }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {callStatus === 'ringing' ? 'Ringing' : callStatus === 'answered' ? 'Live Call' : 'Connecting'}
              </span>
            </div>
            <SignalBars quality={4} />
          </div>

          {/* Caller info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <Avatar name={remoteId} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayId ?? 'Unknown'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>{getStatusLabel()}</span>
                {isAnswered && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>
                    · {timer}
                  </span>
                )}
              </div>
            </div>
            <ChannelBadge label={channelLabel} />
          </div>

          {/* Conference second leg */}
          {inConference && (
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 12,
              padding: '12px 16px',
              marginBottom: 16,
              border: '1px solid rgba(139,92,246,0.3)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 700, color: '#fff', flexShrink: 0,
              }}>
                {(asterisk.secondRemoteIdentity ?? '?').slice(0, 2)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>
                  {asterisk.secondRemoteIdentity ?? 'Dialing…'}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                  {conf === 'ringing2'   && 'Ringing…'}
                  {conf === 'answered2'  && 'Connected — ready to merge'}
                  {conf === 'conference' && (asterisk.secondMuted ? '🔴 Muted' : '🟢 Active')}
                  {conf === 'held'       && '⏸ On Hold'}
                </div>
              </div>
            </div>
          )}

          {conf === 'conference' && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(124,58,237,0.2), rgba(168,85,247,0.1))',
              border: '1px solid rgba(139,92,246,0.4)',
              borderRadius: 10, padding: '8px 14px',
              fontSize: 11, fontWeight: 700, color: '#c4b5fd',
              textAlign: 'center', letterSpacing: '0.06em', marginBottom: 16,
            }}>
              ☎ 3-WAY CONFERENCE ACTIVE
            </div>
          )}

          {/* ── In-call action row ── */}
          <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 20 }}>
            {/* Hold — SIP only */}
            {asteriskActive && !twilioActive ? (
              <ActionCircle
                icon="⏸"
                label={held ? 'Resume' : 'Hold'}
                color={held ? 'rgba(245,158,11,0.35)' : 'rgba(255,255,255,0.12)'}
                borderColor={held ? 'rgba(245,158,11,0.6)' : undefined}
                size={52} fontSize={18}
                onClick={() => {
                  asterisk.toggleHold();
                  setHeld((v) => !v);
                }}
                disabled={callStatus !== 'answered'}
              />
            ) : (
              <ActionCircle icon="⏸" label="Hold" color="rgba(255,255,255,0.06)" size={52} fontSize={18} onClick={() => {}} disabled />
            )}

            {/* Keypad */}
            <ActionCircle
              icon="⌨"
              label="Keypad"
              color={showKeypad ? 'rgba(59,130,246,0.35)' : 'rgba(255,255,255,0.12)'}
              borderColor={showKeypad ? 'rgba(59,130,246,0.6)' : undefined}
              size={52} fontSize={18}
              onClick={() => setShowKeypad((v) => !v)}
            />

            {/* Add Call / Conference — SIP only */}
            {asteriskActive && !twilioActive ? (
              <ActionCircle
                icon="✚"
                label={inConference ? 'Conference' : 'Add Call'}
                color={showAdd ? 'rgba(34,197,94,0.35)' : inConference ? 'rgba(139,92,246,0.35)' : 'rgba(255,255,255,0.12)'}
                borderColor={showAdd ? 'rgba(34,197,94,0.6)' : inConference ? 'rgba(139,92,246,0.6)' : undefined}
                size={52} fontSize={16}
                onClick={() => setShowAdd((v) => !v)}
                disabled={callStatus !== 'answered'}
              />
            ) : twilioActive ? (
              <ActionCircle
                icon="↗"
                label="Transfer"
                color={showTransfer ? 'rgba(139,92,246,0.35)' : 'rgba(255,255,255,0.12)'}
                borderColor={showTransfer ? 'rgba(139,92,246,0.6)' : undefined}
                size={52} fontSize={18}
                onClick={() => { setShowTransfer((v) => !v); setShowKeypad(false); }}
                disabled={twilio.state.callStatus !== 'answered'}
              />
            ) : (
              <ActionCircle icon="✚" label="Add Call" color="rgba(255,255,255,0.06)" size={52} fontSize={16} onClick={() => {}} disabled />
            )}
          </div>

          {/* In-call keypad */}
          {showKeypad && isAnswered && (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16,
              background: 'rgba(0,0,0,0.2)', borderRadius: 14, padding: 12,
            }}>
              {KEYS.map(({ digit, sub }) => (
                <button
                  key={digit}
                  onClick={() => pressKey(digit)}
                  style={darkKeyStyle()}
                >
                  <span style={{ fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{digit}</span>
                  {sub && <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em' }}>{sub}</span>}
                </button>
              ))}
            </div>
          )}

          {/* Transfer panel — PSTN only */}
          {showTransfer && twilioActive && (
            <div style={{
              background: 'rgba(0,0,0,0.25)', borderRadius: 14, padding: '14px 16px', marginBottom: 16,
              border: '1px solid rgba(139,92,246,0.3)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Transfer to Extension
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="tel"
                  value={transferInput}
                  onChange={(e) => setTransferInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && transferInput.trim()) {
                      twilio.transferCall(transferInput.trim());
                      setShowTransfer(false);
                      setTransferInput('');
                    }
                  }}
                  placeholder="Extension (e.g. 1002)"
                  autoFocus
                  style={{
                    flex: 1, padding: '9px 12px', fontSize: 14,
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 8, background: 'rgba(255,255,255,0.05)',
                    color: '#fff', outline: 'none',
                  }}
                />
                <button
                  onClick={() => {
                    if (transferInput.trim()) {
                      twilio.transferCall(transferInput.trim());
                      setShowTransfer(false);
                      setTransferInput('');
                    }
                  }}
                  style={{ ...inCallActionBtn('#7c3aed'), padding: '9px 16px', borderRadius: 8 }}
                >
                  Transfer
                </button>
                <button onClick={() => { setShowTransfer(false); setTransferInput(''); }} style={{ ...inCallActionBtn('rgba(255,255,255,0.1)'), padding: '9px 12px', borderRadius: 8 }}>✕</button>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 8 }}>
                The caller will be connected to that extension. You will be dropped.
              </div>
            </div>
          )}

          {/* Add call panel */}
          {showAdd && (
            <div style={{
              background: 'rgba(0,0,0,0.25)', borderRadius: 14, padding: '14px 16px', marginBottom: 16,
              border: '1px solid rgba(255,255,255,0.08)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Add to Conference
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="tel"
                  value={addInput}
                  onChange={(e) => setAddInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && dialAddCall()}
                  placeholder="SIP extension (e.g. 1002)"
                  autoFocus
                  style={{
                    flex: 1, padding: '9px 12px', fontSize: 14,
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 8, background: 'rgba(255,255,255,0.05)',
                    color: '#fff', outline: 'none',
                  }}
                />
                <button onClick={dialAddCall} style={{ ...inCallActionBtn('#22c55e'), padding: '9px 16px', borderRadius: 8 }}>Call</button>
                <button onClick={() => { setShowAdd(false); setAddInput(''); }} style={{ ...inCallActionBtn('rgba(255,255,255,0.1)'), padding: '9px 12px', borderRadius: 8 }}>✕</button>
              </div>
            </div>
          )}

          {/* Conference controls */}
          {inConference && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {conf === 'answered2' && (
                <button onClick={asterisk.mergeToConference} style={confBtn('#7c3aed')}>Merge</button>
              )}
              {(conf === 'answered2' || conf === 'conference') && (
                <button onClick={asterisk.swapCalls} style={confBtn('#0e7490')}>Swap</button>
              )}
              {conf === 'conference' && (
                <>
                  <button onClick={handleMute} style={confBtn(muted ? '#d97706' : '#475569')}>
                    {muted ? 'Un-P1' : 'Mute P1'}
                  </button>
                  <button onClick={asterisk.toggleMuteSecond} style={confBtn(asterisk.secondMuted ? '#d97706' : '#475569')}>
                    {asterisk.secondMuted ? 'Un-P2' : 'Mute P2'}
                  </button>
                </>
              )}
              {conf !== 'held' && (
                <button onClick={asterisk.hangUpSecond} style={confBtn('#92400e')}>End Call 2</button>
              )}
              <button onClick={asterisk.hangUpAll} style={confBtn('#dc2626')}>End All</button>
            </div>
          )}

          {/* Primary in-call buttons */}
          {!isIncoming && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleHangUp}
                style={{
                  flex: 1, padding: '15px 0',
                  background: 'linear-gradient(135deg, #dc2626, #b91c1c)',
                  border: 'none', borderRadius: 14, cursor: 'pointer',
                  color: '#fff', fontSize: 15, fontWeight: 700,
                  boxShadow: '0 4px 20px rgba(220,38,38,0.4)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  transition: 'transform 0.1s, box-shadow 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.02)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                &#9742; Hang Up
              </button>
              {callStatus === 'answered' && !inConference && (
                <button
                  onClick={handleMute}
                  style={{
                    padding: '15px 22px',
                    background: muted ? 'rgba(217,119,6,0.2)' : 'rgba(255,255,255,0.08)',
                    border: `1px solid ${muted ? 'rgba(217,119,6,0.5)' : 'rgba(255,255,255,0.12)'}`,
                    borderRadius: 14, cursor: 'pointer',
                    color: muted ? '#fbbf24' : 'rgba(255,255,255,0.7)',
                    fontSize: 13, fontWeight: 600,
                    display: 'flex', alignItems: 'center', gap: 6,
                    transition: 'all 0.15s',
                  }}
                >
                  {muted ? '🔇' : '🎤'} {muted ? 'Unmute' : 'Mute'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── IDLE DIALPAD ── */}
      {!inCall && (
        <div style={{
          background: 'linear-gradient(135deg, #0f2027 0%, #1a1a2e 50%, #16213e 100%)',
          borderRadius: 24,
          padding: '28px 24px',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ position: 'relative' }}>
              <input
                type="tel"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && dial()}
                placeholder={pstnEnabled ? 'Enter number or extension' : 'Enter extension (SIP only)'}
                style={{
                  width: '100%', padding: '14px 48px 14px 18px',
                  fontSize: 20, textAlign: 'center',
                  letterSpacing: 2, fontFamily: "'SF Mono', 'Fira Code', monospace",
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 14,
                  background: 'rgba(255,255,255,0.05)',
                  color: '#fff',
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color 0.15s',
                  caretColor: '#3b82f6',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)'; }}
                onBlur={(e)  => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
              />
              {input && (
                <button
                  onClick={() => setInput((p) => p.slice(0, -1))}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(255,255,255,0.35)', fontSize: 18, padding: 4,
                  }}
                >⌫</button>
              )}
            </div>
          </div>

          {/* Dialpad grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 20,
          }}>
            {KEYS.map(({ digit, sub }) => (
              <button
                key={digit}
                onClick={() => pressKey(digit)}
                style={darkKeyStyle()}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              >
                <span style={{ fontSize: 20, fontWeight: 600, color: '#fff', lineHeight: 1 }}>{digit}</span>
                {sub && <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.12em' }}>{sub}</span>}
              </button>
            ))}
          </div>

          {/* Call button */}
          <button
            onClick={dial}
            disabled={!canCall}
            style={{
              width: '100%', padding: '16px 0',
              background: canCall
                ? 'linear-gradient(135deg, #16a34a, #15803d)'
                : 'rgba(255,255,255,0.06)',
              border: 'none', borderRadius: 14, cursor: canCall ? 'pointer' : 'not-allowed',
              color: canCall ? '#fff' : 'rgba(255,255,255,0.2)',
              fontSize: 16, fontWeight: 700,
              boxShadow: canCall ? '0 4px 20px rgba(22,163,74,0.4)' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { if (canCall) e.currentTarget.style.transform = 'scale(1.01)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
          >
            ✆ Call
          </button>
        </div>
      )}

      {/* Channel legend */}
      <div style={{
        marginTop: 16,
        display: 'flex', gap: 16, justifyContent: 'center',
        fontSize: 11, color: 'rgba(255,255,255,0.25)', flexWrap: 'wrap',
      }}>
        <span>SIP ext → Asterisk</span>
        {pstnEnabled && (
          <>
            <span>·</span>
            <span>10-digit → Twilio PSTN</span>
          </>
        )}
        <span>·</span>
        <span>Conference: SIP only</span>
      </div>

      <style>{`
        @keyframes softphone-fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes softphone-ping {
          0%   { box-shadow: 0 0 0 0   rgba(34,197,94,0.6); }
          70%  { box-shadow: 0 0 0 10px rgba(34,197,94,0); }
          100% { box-shadow: 0 0 0 0   rgba(34,197,94,0); }
        }
      `}</style>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────────── */

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div style={{
      background: 'rgba(220,38,38,0.1)', color: '#fca5a5',
      border: '1px solid rgba(220,38,38,0.3)', borderRadius: 10,
      padding: '10px 14px', marginBottom: 12, fontSize: 13,
    }}>
      {msg}
    </div>
  );
}

function ChannelBadge({ label }: { label: string }) {
  const isPstn = label === 'PSTN';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: isPstn ? 'rgba(139,92,246,0.15)' : 'rgba(59,130,246,0.15)',
      color: isPstn ? '#c4b5fd' : '#93c5fd',
      border: `1px solid ${isPstn ? 'rgba(139,92,246,0.3)' : 'rgba(59,130,246,0.3)'}`,
      fontSize: 10, fontWeight: 700, padding: '3px 10px',
      borderRadius: 99, letterSpacing: '0.06em', textTransform: 'uppercase' as const,
      flexShrink: 0,
    }}>
      {isPstn ? '☁' : '☎'} {label}
    </span>
  );
}

interface ActionCircleProps {
  icon: string;
  label: string;
  color: string;
  borderColor?: string;
  glow?: string;
  size?: number;
  fontSize?: number;
  onClick: () => void;
  disabled?: boolean;
  pulse?: boolean;
}

function ActionCircle({ icon, label, color, borderColor, glow, size = 52, fontSize = 18, onClick, disabled, pulse }: ActionCircleProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          width: size, height: size, borderRadius: '50%',
          background: color,
          border: borderColor ? `1.5px solid ${borderColor}` : '1.5px solid transparent',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize, color: '#fff',
          boxShadow: glow ? `0 0 0 0 ${glow}` : 'none',
          opacity: disabled ? 0.25 : 1,
          transition: 'transform 0.15s, opacity 0.15s',
          animation: pulse ? 'softphone-ping 1s ease-out infinite' : 'none',
        }}
        onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.transform = 'scale(1.08)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        {icon}
      </button>
      <span style={{ fontSize: 10, color: borderColor ? '#fff' : 'rgba(255,255,255,0.35)', fontWeight: 500 }}>{label}</span>
    </div>
  );
}

/* ── Style helpers ───────────────────────────────────────────────────────────── */

function darkKeyStyle(): React.CSSProperties {
  return {
    padding: '16px 0',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'background 0.12s',
    color: '#fff',
  };
}

function inCallActionBtn(bg: string): React.CSSProperties {
  return {
    background: bg, border: 'none', cursor: 'pointer',
    color: '#fff', fontSize: 13, fontWeight: 600,
    transition: 'opacity 0.15s',
  };
}

function confBtn(bg: string): React.CSSProperties {
  return {
    flex: 1, padding: '9px 0',
    background: bg, border: 'none', borderRadius: 8,
    cursor: 'pointer', color: '#fff',
    fontSize: 12, fontWeight: 600,
    minWidth: 70,
  };
}
