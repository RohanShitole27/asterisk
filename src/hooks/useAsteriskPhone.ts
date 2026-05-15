import { useEffect, useRef, useCallback, useState } from 'react';
import { UA, WebSocketInterface } from 'jssip';
import type { RTCSession } from 'jssip';
import type { PhoneState, CallLogEntry } from '../types/sip';

const WSS_URL = 'wss://127.0.0.1:8089/ws';
const SIP_URI = 'sip:1001@127.0.0.1';
const SIP_PASSWORD = '1234';

// Uncomment to enable verbose JsSIP logging for debugging:
// import { debug } from 'jssip';
// debug.enable('JsSIP:*');

export function useAsteriskPhone() {
  const [state, setState] = useState<PhoneState>({
    registered: false,
    registering: false,
    error: null,
    callStatus: 'idle',
    callDirection: null,
    remoteIdentity: null,
    muted: false,
  });

  const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);

  const uaRef = useRef<UA | null>(null);
  const sessionRef = useRef<RTCSession | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callStartTimeRef = useRef<Date | null>(null);

  const ensureAudioElement = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  const attachRemoteStream = useCallback((session: RTCSession) => {
    const audio = ensureAudioElement();
    const pc = session.connection;

    const buildAndAttach = () => {
      const stream = new MediaStream();
      pc.getReceivers().forEach((r) => {
        if (r.track) stream.addTrack(r.track);
      });
      if (stream.getTracks().length > 0) {
        audio.srcObject = stream;
      }
    };

    pc.addEventListener('track', buildAndAttach);
    buildAndAttach();
  }, [ensureAudioElement]);

  const addCallLog = useCallback((session: RTCSession, status: CallLogEntry['status']) => {
    const endTime = new Date();
    const startTime = callStartTimeRef.current ?? endTime;
    setCallLogs((prev) => [
      {
        id: `${Date.now()}-${Math.random()}`,
        direction: session.direction === 'incoming' ? 'inbound' : 'outbound',
        remoteIdentity: session.remote_identity?.uri?.toString() ?? 'unknown',
        startTime,
        endTime,
        duration: status === 'answered'
          ? Math.round((endTime.getTime() - startTime.getTime()) / 1000)
          : null,
        status,
      },
      ...prev,
    ]);
  }, []);

  const resetCallState = useCallback(() => {
    sessionRef.current = null;
    callStartTimeRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setState((prev) => ({
      ...prev,
      callStatus: 'idle',
      callDirection: null,
      remoteIdentity: null,
      muted: false,
    }));
  }, []);

  const wireSessionEvents = useCallback((session: RTCSession) => {
    sessionRef.current = session;
    const remoteId = session.remote_identity?.uri?.user ?? 'unknown';

    setState((prev) => ({ ...prev, remoteIdentity: remoteId, error: null }));

    session.on('accepted', () => {
      callStartTimeRef.current = new Date();
      setState((prev) => ({ ...prev, callStatus: 'answered', muted: false }));
      attachRemoteStream(session);
    });

    session.on('confirmed', () => {
      attachRemoteStream(session);
    });

    session.on('ended', () => {
      addCallLog(session, 'answered');
      resetCallState();
    });

    session.on('failed', (data: unknown) => {
      const cause = (data as { cause?: string })?.cause ?? 'unknown';
      const wasEstablished = session.isEstablished();
      addCallLog(session, wasEstablished ? 'answered' : 'failed');
      resetCallState();
      setState((prev) => ({ ...prev, error: `Call failed: ${cause}` }));
    });
  }, [addCallLog, attachRemoteStream, resetCallState]);

  useEffect(() => {
    const socket = new WebSocketInterface(WSS_URL);
    const ua = new UA({
      sockets: [socket],
      uri: SIP_URI,
      password: SIP_PASSWORD,
      register: true,
      register_expires: 300,
      user_agent: 'SoftPhone/1.0',
      // Prevents 422 "Session Interval Too Small" — Asterisk min is 90s,
      // browsers often propose a lower value triggering a negotiation loop.
      session_timers: false,
    });

    uaRef.current = ua;

    ua.on('connecting', () => {
      setState((prev) => ({ ...prev, registering: true, error: null }));
    });

    ua.on('disconnected', () => {
      setState((prev) => ({
        ...prev,
        registered: false,
        registering: false,
        error: 'WebSocket disconnected — is Asterisk running? Did you trust the cert at https://127.0.0.1:8089?',
      }));
    });

    ua.on('registered', () => {
      setState((prev) => ({ ...prev, registered: true, registering: false, error: null }));
    });

    ua.on('unregistered', () => {
      setState((prev) => ({ ...prev, registered: false, registering: false }));
    });

    ua.on('registrationFailed', (data: unknown) => {
      const d = data as { cause?: string; response?: { status_code?: number } };
      const code = d.response?.status_code ?? '';
      setState((prev) => ({
        ...prev,
        registered: false,
        registering: false,
        error: `Registration failed: ${code} ${d.cause ?? ''}`.trim(),
      }));
    });

    ua.on('newRTCSession', (data: unknown) => {
      const { session } = data as { session: RTCSession };

      if (session.direction !== 'incoming') return;

      // Reject second incoming call if already in one
      if (sessionRef.current && !sessionRef.current.isEnded()) {
        session.terminate();
        return;
      }

      wireSessionEvents(session);
      setState((prev) => ({
        ...prev,
        callStatus: 'incoming',
        callDirection: 'inbound',
      }));
    });

    ua.start();

    return () => {
      if (sessionRef.current && !sessionRef.current.isEnded()) {
        sessionRef.current.terminate();
      }
      ua.stop();
      uaRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const makeCall = useCallback((number: string) => {
    const ua = uaRef.current;
    if (!ua || !ua.isRegistered()) {
      setState((prev) => ({ ...prev, error: 'Not registered — wait for the green indicator' }));
      return;
    }
    if (sessionRef.current && !sessionRef.current.isEnded()) {
      setState((prev) => ({ ...prev, error: 'Already in a call' }));
      return;
    }

    const target = `sip:${number}@127.0.0.1`;
    const session = ua.call(target, {
      mediaConstraints: { audio: true, video: false },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      // No STUN needed for calls to localhost Asterisk — host candidates suffice.
      pcConfig: { iceServers: [] },
    });

    wireSessionEvents(session);
    setState((prev) => ({
      ...prev,
      callStatus: 'ringing',
      callDirection: 'outbound',
      error: null,
    }));
  }, [wireSessionEvents]);

  const answerCall = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.direction !== 'incoming') return;
    session.answer({ mediaConstraints: { audio: true, video: false } });
  }, []);

  const hangUp = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.isEnded()) return;
    session.terminate();
  }, []);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !session.isEstablished()) return;
    const { audio: isMuted } = session.isMuted();
    if (isMuted) {
      session.unmute({ audio: true });
    } else {
      session.mute({ audio: true });
    }
    setState((prev) => ({ ...prev, muted: !isMuted }));
  }, []);

  const sendDtmf = useCallback((tone: string) => {
    const session = sessionRef.current;
    if (!session || !session.isEstablished()) return;
    session.sendDTMF(tone);
  }, []);

  return { state, callLogs, makeCall, answerCall, hangUp, toggleMute, sendDtmf };
}
