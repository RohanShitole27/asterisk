import { useEffect, useRef, useCallback, useState } from 'react';
import { UA, WebSocketInterface } from 'jssip';
import type { RTCSession as JsSipRTCSession } from 'jssip';
import type { PhoneState, CallLogEntry } from '../types/sip';

// JsSIP's bundled type declarations omit hold/unhold/isOnHold even though
// they exist at runtime (documented JsSIP RTCSession API).
type RTCSession = JsSipRTCSession & {
  hold(): void;
  unhold(): void;
  isOnHold(): { local: boolean; remote: boolean };
};

export type ConferenceStatus = 'none' | 'held' | 'ringing2' | 'answered2' | 'conference';

const ASTERISK_HOST = '127.0.0.1';
const WSS_URL       = `wss://${ASTERISK_HOST}:8089/ws`;
const SIP_PASSWORD  = '1234';

// Uncomment to enable verbose JsSIP logging for debugging:
// import { debug } from 'jssip';
// debug.enable('JsSIP:*');

// ── Hook ───────────────────────────────────────────────────────────────────────
// `extension` comes from the logged-in user's assigned extension (see useAuth) —
// no longer read from a URL param, since identity now comes from the session.
// `enabled` lets a role opt out of SIP entirely (distinct from "no extension
// assigned", which is a misconfiguration; enabled=false means it's intentional).
export function useAsteriskPhone(extension: string | null, enabled: boolean = true) {
  const [state, setState] = useState<PhoneState>({
    registered:    false,
    registering:   false,
    error:         null,
    callStatus:    'idle',
    callDirection: null,
    remoteIdentity: null,
    muted:         false,
  });

  const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);

  // Load call logs from DB on mount, then keep polling — a manager/admin's
  // dashboard needs to see other people's calls as they happen, not just
  // calls made in this exact browser tab (which update locally via addCallLog).
  useEffect(() => {
    const load = () => {
      fetch('/api/call-logs?source=asterisk', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Array<{ id: string; direction: 'inbound' | 'outbound'; remoteIdentity: string; startTime: string; endTime: string | null; duration: number | null; status: 'answered' | 'missed' | 'failed'; recordingSid?: string | null; sipRecordingFile?: string | null; extension?: string | null }>) =>
          setCallLogs(rows.map((r) => ({ ...r, startTime: new Date(r.startTime), endTime: r.endTime ? new Date(r.endTime) : null })))
        )
        .catch(() => {}); // fail silently — UI still works without logs
    };
    load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
  }, []);

  // ── Conference state ──────────────────────────────────────────────────────
  const [confStatus, setConfStatus]                 = useState<ConferenceStatus>('none');
  const [secondRemoteIdentity, setSecondRemoteId]   = useState<string | null>(null);
  const [secondMuted, setSecondMuted]               = useState(false);

  const uaRef              = useRef<UA | null>(null);
  const sessionRef         = useRef<RTCSession | null>(null);
  const secondSessionRef   = useRef<RTCSession | null>(null);
  const audioRef           = useRef<HTMLAudioElement | null>(null);
  const audio2Ref          = useRef<HTMLAudioElement | null>(null);
  const callStartTimeRef   = useRef<Date | null>(null);
  const callStartTime2Ref  = useRef<Date | null>(null);

  const ensureAudioElement = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  const ensureAudio2Element = useCallback(() => {
    if (!audio2Ref.current) {
      const audio = new Audio();
      audio.autoplay = true;
      audio2Ref.current = audio;
    }
    return audio2Ref.current;
  }, []);

  const attachRemoteStream = useCallback((session: RTCSession) => {
    const audio = ensureAudioElement();
    const pc    = session.connection;
    const buildAndAttach = () => {
      const stream = new MediaStream();
      pc.getReceivers().forEach((r) => { if (r.track) stream.addTrack(r.track); });
      if (stream.getTracks().length > 0) audio.srcObject = stream;
    };
    pc.addEventListener('track', buildAndAttach);
    buildAndAttach();
  }, [ensureAudioElement]);

  const attachRemoteStream2 = useCallback((session: RTCSession) => {
    const audio = ensureAudio2Element();
    const pc    = session.connection;
    const buildAndAttach = () => {
      const stream = new MediaStream();
      pc.getReceivers().forEach((r) => { if (r.track) stream.addTrack(r.track); });
      if (stream.getTracks().length > 0) audio.srcObject = stream;
    };
    pc.addEventListener('track', buildAndAttach);
    buildAndAttach();
  }, [ensureAudio2Element]);

  const addCallLog = useCallback((session: RTCSession, status: CallLogEntry['status']) => {
    const endTime   = new Date();
    const startTime = callStartTimeRef.current ?? endTime;
    const entry: CallLogEntry = {
      id:             `asterisk-${Date.now()}-${Math.random()}`,
      direction:      session.direction === 'incoming' ? 'inbound' : 'outbound',
      remoteIdentity: session.remote_identity?.uri?.toString() ?? 'unknown',
      startTime,
      endTime,
      duration: status === 'answered'
        ? Math.round((endTime.getTime() - startTime.getTime()) / 1000)
        : null,
      status,
      extension,
    };
    setCallLogs((prev) => [entry, ...prev]);
    fetch('/api/call-logs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...entry, source: 'asterisk' }),
    }).catch((err) => console.error('Failed to save call log:', err));
  }, [extension]);

  const resetConferenceState = useCallback(() => {
    secondSessionRef.current  = null;
    callStartTime2Ref.current = null;
    if (audio2Ref.current) audio2Ref.current.srcObject = null;
    setConfStatus('none');
    setSecondRemoteId(null);
    setSecondMuted(false);
  }, []);

  const resetCallState = useCallback(() => {
    sessionRef.current       = null;
    callStartTimeRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setState((prev) => ({
      ...prev,
      callStatus:    'idle',
      callDirection: null,
      remoteIdentity: null,
      muted:         false,
    }));
    // Also clean up any conference leg
    if (secondSessionRef.current && !secondSessionRef.current.isEnded()) {
      secondSessionRef.current.terminate();
    }
    resetConferenceState();
  }, [resetConferenceState]);

  const markCallAnswered = useCallback((session: RTCSession) => {
    if (!callStartTimeRef.current) callStartTimeRef.current = new Date();
    attachRemoteStream(session);
    setState((prev) => ({ ...prev, callStatus: 'answered', muted: false }));
  }, [attachRemoteStream]);

  const wireSessionEvents = useCallback((session: RTCSession) => {
    sessionRef.current = session;
    const remoteId = session.remote_identity?.uri?.user ?? 'unknown';

    setState((prev) => ({ ...prev, remoteIdentity: remoteId, error: null }));

    session.on('accepted', () => {
      if (session.direction === 'outgoing') markCallAnswered(session);
    });

    session.on('confirmed', () => {
      if (session.direction === 'incoming') {
        markCallAnswered(session);
      } else {
        attachRemoteStream(session);
      }
    });

    session.on('ended', () => {
      // If callStartTimeRef was set, the call was answered.
      // Otherwise: incoming → missed, outgoing → failed.
      const wasAnswered = callStartTimeRef.current !== null;
      const status: CallLogEntry['status'] = wasAnswered
        ? 'answered'
        : session.direction === 'incoming' ? 'missed' : 'failed';
      addCallLog(session, status);
      resetCallState();
    });

    session.on('failed', (data: unknown) => {
      const cause = (data as { cause?: string })?.cause ?? 'unknown';
      const wasAnswered = callStartTimeRef.current !== null;
      const status: CallLogEntry['status'] = wasAnswered
        ? 'answered'
        : session.direction === 'incoming' ? 'missed' : 'failed';
      addCallLog(session, status);
      resetCallState();
      setState((prev) => ({ ...prev, error: `Call failed: ${cause}` }));
    });
  }, [addCallLog, attachRemoteStream, markCallAnswered, resetCallState]);

  useEffect(() => {
    if (!enabled) return; // this role intentionally never registers SIP
    if (!extension) {
      setState((p) => ({ ...p, error: 'No extension assigned to your account — ask an admin to assign one' }));
      return;
    }
    const socket = new WebSocketInterface(WSS_URL);
    const ua = new UA({
      sockets:          [socket],
      uri:              `sip:${extension}@${ASTERISK_HOST}`,
      password:         SIP_PASSWORD,
      register:         true,
      register_expires: 300,
      user_agent:       'SoftPhone/1.0',
      // Prevents 422 "Session Interval Too Small" — Asterisk min is 90s.
      session_timers:   false,
    });

    uaRef.current = ua;

    ua.on('connecting',  () => setState((p) => ({ ...p, registering: true,  error: null })));
    ua.on('registered',  () => setState((p) => ({ ...p, registered: true,   registering: false, error: null })));
    ua.on('unregistered',() => setState((p) => ({ ...p, registered: false,  registering: false })));

    ua.on('disconnected', () =>
      setState((p) => ({
        ...p,
        registered:   false,
        registering:  false,
        error: 'WebSocket disconnected — is Asterisk running? Did you trust the cert at https://127.0.0.1:8089?',
      }))
    );

    ua.on('registrationFailed', (data: unknown) => {
      const d    = data as { cause?: string; response?: { status_code?: number } };
      const code = d.response?.status_code ?? '';
      setState((p) => ({
        ...p,
        registered:  false,
        registering: false,
        error: `Registration failed: ${code} ${d.cause ?? ''}`.trim(),
      }));
    });

    ua.on('newRTCSession', (data: unknown) => {
      const { session } = data as { session: RTCSession };
      if (session.direction !== 'incoming') return;
      if (sessionRef.current && !sessionRef.current.isEnded()) {
        session.terminate();
        return;
      }
      wireSessionEvents(session);
      setState((p) => ({ ...p, callStatus: 'incoming', callDirection: 'inbound' }));
    });

    ua.start();

    return () => {
      if (sessionRef.current && !sessionRef.current.isEnded()) sessionRef.current.terminate();
      ua.stop();
      uaRef.current = null;
    };
  }, [extension, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const makeCall = useCallback((number: string) => {
    const ua = uaRef.current;
    if (!ua || !ua.isRegistered()) {
      setState((p) => ({ ...p, error: 'Not registered — wait for the green indicator' }));
      return;
    }
    if (sessionRef.current && !sessionRef.current.isEnded()) {
      setState((p) => ({ ...p, error: 'Already in a call' }));
      return;
    }
    const session = ua.call(`sip:${number}@${ASTERISK_HOST}`, {
      mediaConstraints:    { audio: true, video: false },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      pcConfig:            { iceServers: [] },
    }) as RTCSession;
    wireSessionEvents(session);
    setState((p) => ({ ...p, callStatus: 'ringing', callDirection: 'outbound', error: null }));
  }, [wireSessionEvents]);

  const answerCall  = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.direction !== 'incoming') return;
    s.answer({ mediaConstraints: { audio: true, video: false } });
  }, []);

  const toggleHold = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.isEstablished()) return;
    try {
      if (s.isOnHold().local) s.unhold();
      else s.hold();
      setState((p) => ({ ...p })); // trigger re-render
    } catch { /* ignore */ }
  }, []);

  const isOnHold = useCallback(() => {
    const s = sessionRef.current;
    return s?.isEstablished() ? s.isOnHold().local : false;
  }, []);

  const hangUp      = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.isEnded()) return;
    s.terminate();
  }, []);

  const toggleMute  = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.isEstablished()) return;
    const { audio: isMuted } = s.isMuted();
    if (isMuted) s.unmute({ audio: true }); else s.mute({ audio: true });
    setState((p) => ({ ...p, muted: !isMuted }));
  }, []);

  const sendDtmf    = useCallback((tone: string) => {
    const s = sessionRef.current;
    if (!s || !s.isEstablished()) return;
    s.sendDTMF(tone);
  }, []);

  const clearLogs = useCallback(() => {
    setCallLogs([]);
    fetch('/api/call-logs?source=asterisk', { method: 'DELETE' })
      .catch((err) => console.error('Failed to clear call logs:', err));
  }, []);

  // ── Conference controls ────────────────────────────────────────────────────

  /** Hold the active call and dial a second SIP extension. */
  const holdAndAddCall = useCallback((number: string) => {
    const ua       = uaRef.current;
    const session1 = sessionRef.current;
    if (!ua || !session1 || !session1.isEstablished()) return;
    if (secondSessionRef.current) return; // already have a second leg

    try { session1.hold(); } catch { /* ignore race */ }
    setConfStatus('held');

    const session2 = ua.call(`sip:${number}@${ASTERISK_HOST}`, {
      mediaConstraints:    { audio: true, video: false },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      pcConfig:            { iceServers: [] },
    }) as RTCSession;
    secondSessionRef.current = session2;
    setSecondRemoteId(number);
    setConfStatus('ringing2');

    const onAnswered = () => {
      if (!callStartTime2Ref.current) callStartTime2Ref.current = new Date();
      attachRemoteStream2(session2);
      setConfStatus('answered2');
    };
    session2.on('accepted',  onAnswered);
    session2.on('confirmed', onAnswered);

    session2.on('ended', () => {
      resetConferenceState();
      try { sessionRef.current?.unhold(); } catch { /* ignore */ }
    });
    session2.on('failed', () => {
      resetConferenceState();
      try { sessionRef.current?.unhold(); } catch { /* ignore */ }
    });
  }, [attachRemoteStream2, resetConferenceState]);

  /** Resume the held first call and mix both legs into conference. */
  const mergeToConference = useCallback(() => {
    try { sessionRef.current?.unhold(); } catch { /* ignore */ }
    setConfStatus('conference');
  }, []);

  /**
   * Swap: if call 1 is active, hold it and unhold call 2; and vice versa.
   * Only valid in `answered2` or `conference` state.
   */
  const swapCalls = useCallback(() => {
    const s1 = sessionRef.current;
    const s2 = secondSessionRef.current;
    if (!s1 || !s2) return;
    try {
      if (s1.isOnHold().local) {
        s1.unhold();
        s2.hold();
      } else {
        s1.hold();
        s2.unhold();
      }
    } catch { /* ignore */ }
  }, []);

  /** End the second call leg, resume call 1. */
  const hangUpSecond = useCallback(() => {
    const s2 = secondSessionRef.current;
    if (s2 && !s2.isEnded()) s2.terminate();
    resetConferenceState();
    try { sessionRef.current?.unhold(); } catch { /* ignore */ }
  }, [resetConferenceState]);

  /** End both call legs. */
  const hangUpAll = useCallback(() => {
    const s2 = secondSessionRef.current;
    if (s2 && !s2.isEnded()) s2.terminate();
    resetConferenceState();
    const s1 = sessionRef.current;
    if (s1 && !s1.isEnded()) s1.terminate();
  }, [resetConferenceState]);

  /** Toggle mute on the second call leg. */
  const toggleMuteSecond = useCallback(() => {
    const s = secondSessionRef.current;
    if (!s || !s.isEstablished()) return;
    const { audio: isMuted } = s.isMuted();
    if (isMuted) s.unmute({ audio: true }); else s.mute({ audio: true });
    setSecondMuted((prev) => !prev);
  }, []);

  return {
    state, callLogs, clearLogs,
    makeCall, answerCall, hangUp, toggleMute, sendDtmf,
    toggleHold, isOnHold,
    // Conference
    confStatus, secondRemoteIdentity, secondMuted,
    holdAndAddCall, mergeToConference, swapCalls,
    hangUpSecond, hangUpAll, toggleMuteSecond,
  };
}
