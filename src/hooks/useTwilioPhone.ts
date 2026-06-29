/**
 * useTwilioPhone
 *
 * Wraps the Twilio Voice SDK (@twilio/voice-sdk) to handle:
 *  - Inbound PSTN calls (someone calls your Twilio number)
 *  - Outbound PSTN calls (dial a 10/11-digit number from the browser)
 *
 * The hook fetches a short-lived Access Token from /api/twilio/token,
 * registers a Twilio Device, and exposes call state + control functions
 * that mirror the same shape as useAsteriskPhone so the UI can treat
 * them interchangeably.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Device, Call } from '@twilio/voice-sdk';
import type { CallLogEntry } from '../types/sip';


export type TwilioCallStatus = 'idle' | 'incoming' | 'ringing' | 'answered';

export interface TwilioPhoneState {
  ready:          boolean;
  callStatus:     TwilioCallStatus;
  remoteIdentity: string | null;
  muted:          boolean;
  error:          string | null;
}

// `enabled` lets a role opt out of PSTN entirely — when false, no token is
// fetched and no Device is ever created (used to keep Admin SIP-only).
// `agentExtension` is stamped onto locally-created log entries so the
// Dashboard/CallLogs per-agent filter can match them immediately, without
// waiting for the next server poll to fill it in.
export function useTwilioPhone(enabled: boolean = true, agentExtension: string | null = null) {
  const [state, setState] = useState<TwilioPhoneState>({
    ready:          false,
    callStatus:     'idle',
    remoteIdentity: null,
    muted:          false,
    error:          null,
  });

  const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);
  const activeCallSidRef = useRef<string | null>(null);

  // Load call logs from DB on mount, then keep polling — a manager/admin's
  // dashboard needs to see other people's calls as they happen, not just
  // calls made in this exact browser tab (which update locally via addCallLog).
  useEffect(() => {
    const load = () => {
      fetch('/api/call-logs?source=twilio', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Array<{ id: string; direction: 'inbound' | 'outbound'; remoteIdentity: string; startTime: string; endTime: string | null; duration: number | null; status: 'answered' | 'missed' | 'failed'; recordingSid?: string | null; sipRecordingFile?: string | null; extension?: string | null }>) =>
          setCallLogs(rows.map((r) => ({ ...r, startTime: new Date(r.startTime), endTime: r.endTime ? new Date(r.endTime) : null })))
        )
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
  }, []);

  const deviceRef  = useRef<Device | null>(null);
  const callRef    = useRef<Call | null>(null);
  const callStartTimeRef = useRef<Date | null>(null);
  const pendingCallRef   = useRef<{ direction: 'inbound' | 'outbound'; remoteIdentity: string; callSid: string | null } | null>(null);
  // Stable function refs — updated every render so closures inside the
  // one-time useEffect always see the latest setState without re-running init.
  const resetCallRef    = useRef<() => void>(null!);
  const wireCallRef     = useRef<(call: Call, direction: 'inbound' | 'outbound') => void>(null!);
  const addCallLogRef   = useRef<(status: CallLogEntry['status']) => void>(null!);

  // ── helpers ─────────────────────────────────────────────────────────────────
  const setErr   = (msg: string) => setState((p) => ({ ...p, error: msg }));
  const clearErr = ()            => setState((p) => ({ ...p, error: null }));

  const resetCall = useCallback(() => {
    callRef.current          = null;
    callStartTimeRef.current = null;
    pendingCallRef.current   = null;
    setState((p) => ({
      ...p,
      callStatus:     'idle',
      remoteIdentity: null,
      muted:          false,
    }));
  }, []);

  const addCallLog = useCallback((status: CallLogEntry['status']) => {
    const pending = pendingCallRef.current;
    if (!pending) return;
    const endTime   = new Date();
    const startTime = callStartTimeRef.current ?? endTime;
    const entry: CallLogEntry = {
      id:             pending.callSid ?? `twilio-${Date.now()}-${Math.random()}`,
      direction:      pending.direction,
      remoteIdentity: pending.remoteIdentity,
      startTime,
      endTime,
      duration: status === 'answered'
        ? Math.round((endTime.getTime() - startTime.getTime()) / 1000)
        : null,
      status,
      extension: agentExtension,
    };
    setCallLogs((prev) => [entry, ...prev]);
    fetch('/api/call-logs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...entry, source: 'twilio' }),
    }).catch((err) => console.error('Failed to save call log:', err));
  }, [agentExtension]);

  // Wire event listeners on a Call object
  const wireCall = useCallback((call: Call, direction: 'inbound' | 'outbound') => {
    callRef.current = call;

    // For inbound calls, the agent's leg is REST-initiated from our own Twilio
    // number, so call.parameters['From'] would show OUR number, not the real
    // caller's. The server passes the real caller via a custom parameter instead.
    const from = direction === 'inbound'
      ? (call.customParameters?.get('realCaller') ?? call.parameters['From'] ?? 'Unknown')
      : (call.customParameters?.get('To') ?? 'Unknown');

    const callSid = direction === 'inbound'
      ? (call.customParameters?.get('realCallSid') ?? call.parameters.CallSid ?? null)
      : (call.parameters.CallSid ?? null);

    pendingCallRef.current = { direction, remoteIdentity: from, callSid };

    setState((p) => ({
      ...p,
      callStatus:     direction === 'inbound' ? 'incoming' : 'ringing',
      remoteIdentity: from,
      error:          null,
    }));

    call.on('accept', () => {
      callStartTimeRef.current = new Date();
      // For inbound calls, transfer must act on the real caller's CallSid —
      // not the agent-leg's own CallSid (the REST call that rang this browser).
      activeCallSidRef.current = callSid;
      setState((p) => ({ ...p, callStatus: 'answered', muted: false }));
    });

    call.on('disconnect', () => {
      addCallLogRef.current(callStartTimeRef.current ? 'answered' : (direction === 'inbound' ? 'missed' : 'failed'));
      resetCallRef.current();
    });
    call.on('cancel', () => {
      addCallLogRef.current(direction === 'inbound' ? 'missed' : 'failed');
      resetCallRef.current();
    });
    call.on('reject', () => {
      addCallLogRef.current('missed');
      resetCallRef.current();
    });

    call.on('error', (err: Error) => {
      setErr(`Call error: ${err.message}`);
      addCallLogRef.current(direction === 'inbound' ? 'missed' : 'failed');
      resetCallRef.current();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep refs in sync every render
  resetCallRef.current  = resetCall;
  wireCallRef.current   = wireCall;
  addCallLogRef.current = addCallLog;

  // ── Token fetch + Device init ───────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return; // this role intentionally never registers a Twilio Device

    let device: Device | null = null;
    // Guard against React StrictMode double-mount: if this effect instance has
    // been cleaned up, the incoming handler must not process new calls.
    let mounted = true;

    async function init() {
      try {
        // Identity is derived server-side from the logged-in session — no URL param needed.
        const res = await fetch('/api/twilio/token', { credentials: 'include' });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: res.statusText }));
          setErr(`Token error: ${error}`);
          return;
        }
        const { token } = await res.json();

        if (!mounted) return; // cleaned up before token arrived

        device = new Device(token, {
          logLevel:    1,
          codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
        });

        device.on('registered', () => {
          console.log('[Twilio] Device registered ✓');
          setState((p) => ({ ...p, ready: true, error: null }));
        });

        device.on('unregistered', () => setState((p) => ({ ...p, ready: false })));
        device.on('error', (err: Error) => setErr(`Device error: ${err.message}`));

        // Incoming call
        device.on('incoming', (call: Call) => {
          if (!mounted) return; // stale device from a prior effect run — ignore
          console.log('[Twilio] incoming call from', call.parameters['From']);
          if (callRef.current) {
            console.warn('[Twilio] already in a call — rejecting');
            call.reject();
            return;
          }
          wireCallRef.current(call, 'inbound');
        });

        // Re-register 1 minute before the token expires (token TTL = 3600s)
        device.on('tokenWillExpire', async () => {
          const r = await fetch('/api/twilio/token');
          if (r.ok) {
            const { token: newToken } = await r.json();
            device?.updateToken(newToken);
          }
        });

        device.register();
        deviceRef.current = device;
      } catch (err: unknown) {
        setErr(`Init failed: ${(err as Error).message}`);
      }
    }

    init();

    return () => {
      mounted = false;
      callRef.current          = null;
      callStartTimeRef.current = null;
      pendingCallRef.current   = null;
      device?.unregister();
      device?.destroy();
      deviceRef.current = null;
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Controls ────────────────────────────────────────────────────────────────

  /** Dial a PSTN number (10 or 11 digits) or E.164 */
  const makeCall = useCallback((number: string) => {
    const device = deviceRef.current;
    if (!device) { setErr('Twilio Device not ready'); return; }
    if (callRef.current) { setErr('Already in a call'); return; }

    clearErr();
    device.connect({ params: { To: number } }).then((call) => {
      wireCall(call, 'outbound');
    }).catch((err: Error) => setErr(`Call failed: ${err.message}`));
  }, [wireCall]);

  /** Answer an incoming call */
  const answerCall = useCallback(async () => {
    const call = callRef.current;
    if (!call) { setErr('No incoming call to answer'); return; }
    if (call.status() !== 'pending') {
      setErr(`Cannot answer — call is already ${call.status()}`);
      return;
    }

    // Pre-warm microphone here, inside a user gesture, so the browser
    // grants permission before call.accept() needs it.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      setErr('Microphone access denied — cannot answer call');
      return;
    }

    try {
      call.accept();
    } catch (err: unknown) {
      setErr(`Answer failed: ${(err as Error).message}`);
    }
  }, []);

  /** Hang up or reject */
  const hangUp = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    if (call.status() === 'pending') call.reject();
    else call.disconnect();
  }, []);

  /** Toggle microphone mute */
  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !state.muted;
    call.mute(next);
    setState((p) => ({ ...p, muted: next }));
  }, [state.muted]);

  const clearLogs = useCallback(() => {
    setCallLogs([]);
    fetch('/api/call-logs?source=twilio', { method: 'DELETE' })
      .catch((err) => console.error('Failed to clear call logs:', err));
  }, []);

  const transferCall = useCallback(async (extension: string) => {
    const sid = activeCallSidRef.current;
    if (!sid) { setErr('No active call to transfer'); return; }
    const res = await fetch('/api/twilio/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callSid: sid, extension }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Transfer failed' }));
      setErr(error);
    }
  }, []);

  return { state, callLogs, clearLogs, makeCall, answerCall, hangUp, toggleMute, transferCall, activeCallSid: activeCallSidRef.current };
}
