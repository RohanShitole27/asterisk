import { useState } from 'react';
import { useAsteriskPhone } from './hooks/useAsteriskPhone';
import { Sidebar } from './components/Sidebar';
import { Softphone } from './pages/Softphone';
import { CallLogs } from './pages/CallLogs';
import { Contacts } from './pages/Contacts';

type Page = 'softphone' | 'logs' | 'contacts';

export function App() {
  const [page, setPage] = useState<Page>('softphone');
  const phone = useAsteriskPhone();

  const goCallSoftphone = (ext: string) => {
    phone.makeCall(ext);
    setPage('softphone');
  };

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <Sidebar
        currentPage={page}
        onNavigate={setPage}
        registered={phone.state.registered}
        registering={phone.state.registering}
        callStatus={phone.state.callStatus}
      />
      <main style={{ flex: 1, padding: 32, overflowY: 'auto', background: '#f8fafc' }}>
        {page === 'softphone' && <Softphone phone={phone} />}
        {page === 'logs'      && <CallLogs logs={phone.callLogs} />}
        {page === 'contacts'  && <Contacts onCall={goCallSoftphone} />}
      </main>
    </div>
  );
}
