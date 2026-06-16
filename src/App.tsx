import { useState, useEffect, useRef } from 'react';
import { useAsteriskPhone } from './hooks/useAsteriskPhone';
import { useTwilioPhone }   from './hooks/useTwilioPhone';
import { Sidebar }   from './components/Sidebar';
import { Softphone } from './pages/Softphone';
import { CallLogs }  from './pages/CallLogs';
import { Contacts }  from './pages/Contacts';
import { Voicemail }   from './pages/Voicemail';
import { Dashboard }  from './pages/Dashboard';
type Page = 'dashboard' | 'softphone' | 'logs' | 'contacts' | 'voicemail';

// ── Ringtone ──────────────────────────────────────────────────────────────────
function useRingtone(active: boolean) {
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active) { stopRef.current?.(); stopRef.current = null; return; }

    let running = true;
    const play = () => {
      if (!running) return;
      try {
        const AudioCtx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        ctx.resume().then(() => {
          if (!running) { ctx.close(); return; }
          [440, 480].forEach((hz) => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine'; osc.frequency.value = hz;
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
            osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.9);
          });
          setTimeout(() => { ctx.close(); play(); }, 2000);
        });
      } catch { /* AudioContext unavailable */ }
    };
    play();
    stopRef.current = () => { running = false; };
    return () => { running = false; stopRef.current = null; };
  }, [active]);
}

// ── Browser notification ──────────────────────────────────────────────────────
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    Notification.requestPermission();
}

function showNotification(caller: string | null) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  const n = new Notification('📞 Incoming Call', {
    body: `Call from ${caller ?? 'Unknown'}`,
    requireInteraction: true,
  });
  n.onclick = () => { window.focus(); n.close(); };
}

// ── Voicemail polling ─────────────────────────────────────────────────────────
function useUnreadVoicemails() {
  const [count, setCount] = useState(0);
  const prevCountRef = useRef(0);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch('/api/voicemails');
        if (!res.ok) return;
        const msgs: Array<{ is_read: boolean }> = await res.json();
        const unread = msgs.filter((m) => !m.is_read).length;
        if (unread > prevCountRef.current) {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('New Voicemail', {
              body: `You have ${unread} unread voicemail${unread > 1 ? 's' : ''}.`,
            });
          }
        }
        prevCountRef.current = unread;
        setCount(unread);
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 8_000);
    return () => clearInterval(id);
  }, []);

  return count;
}

// ── App ───────────────────────────────────────────────────────────────────────
function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mobile;
}

export function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const unreadVoicemails = useUnreadVoicemails();
  const isMobile = useIsMobile();

  const asterisk = useAsteriskPhone();
  const twilio   = useTwilioPhone();

  useEffect(() => { requestNotificationPermission(); }, []);

  useEffect(() => {
    if (asterisk.state.callStatus === 'incoming') {
      setPage('softphone');
      showNotification(asterisk.state.remoteIdentity);
    }
  }, [asterisk.state.callStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (twilio.state.callStatus === 'incoming') {
      setPage('softphone');
      showNotification(twilio.state.remoteIdentity);
    }
  }, [twilio.state.callStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const isIncoming =
    asterisk.state.callStatus === 'incoming' ||
    twilio.state.callStatus   === 'incoming';
  useRingtone(isIncoming);

  const activeCallStatus =
    twilio.state.callStatus !== 'idle'
      ? twilio.state.callStatus
      : asterisk.state.callStatus;

  const goCallSoftphone = (ext: string) => {
    const isPstn = /^\+?\d{10,}$/.test(ext.replace(/\D/g, '')) && ext.replace(/\D/g, '').length >= 10;
    if (isPstn) twilio.makeCall(ext);
    else        asterisk.makeCall(ext);
    setPage('softphone');
  };

  const combinedLogs = [...asterisk.callLogs, ...twilio.callLogs]
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

  return (
    <div style={{
      display: 'flex',
      flexDirection: isMobile ? 'column' : 'row',
      height: '100vh',
      overflow: 'hidden',
    }}>
      <Sidebar
        currentPage={page}
        onNavigate={setPage}
        registered={asterisk.state.registered}
        registering={asterisk.state.registering}
        twilioReady={twilio.state.ready}
        callStatus={activeCallStatus}
        unreadVoicemails={unreadVoicemails}
        isMobile={isMobile}
      />

      <main style={{
        flex: 1,
        padding: isMobile ? '16px 16px 80px' : '32px 36px',
        overflowY: 'auto',
        background: 'var(--bg)',
      }}>
        {page === 'dashboard' && (
          <Dashboard
            logs={combinedLogs}
            unreadVoicemails={unreadVoicemails}
            onCall={goCallSoftphone}
            onViewAllLogs={() => setPage('logs')}
            twilioReady={twilio.state.ready}
            registered={asterisk.state.registered}
            isMobile={isMobile}
          />
        )}
        {page === 'softphone' && <Softphone asterisk={asterisk} twilio={twilio} />}
        {page === 'logs'      && (
          <CallLogs
            logs={combinedLogs}
            onCall={goCallSoftphone}
            isMobile={isMobile}
          />
        )}
        {page === 'contacts'  && <Contacts onCall={goCallSoftphone} />}
        {page === 'voicemail' && <Voicemail onCall={goCallSoftphone} />}
      </main>
    </div>
  );
}
