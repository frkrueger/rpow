import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Sidebar } from './Sidebar.js';
import { RealtimeProvider } from './RealtimeProvider.js';
import { RoomView } from './RoomView.js';
import { AuthCallback } from './AuthCallback.js';
import { api, type Me } from './api.js';

export function App() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.me()
      .then(m => { if (!cancelled) setMe(m); })
      .catch(() => { /* anon — leave me as null */ });
    return () => { cancelled = true; };
  }, []);

  // Track the URL via react-router so navigation re-subscribes the SSE stream
  // to the new room. Reading window.location directly here is non-reactive and
  // leaves the stream stuck on the initial room.
  const location = useLocation();
  const slug = location.pathname.startsWith('/r/')
    ? (location.pathname.slice(3).split('/')[0] || 'general')
    : 'general';
  const subscribedRooms = useMemo(() => [slug], [slug]);

  return (
    <RealtimeProvider rooms={subscribedRooms}>
      <div className="chat-app">
        <header className="masthead">
          <span className="brand">
            <span className="dot" />
            <a className="brand-back" href="https://rpow2.com" title="Back to rpow2.com">
              <span className="brand-back-arrow">←</span> RPOW
            </a>
            <span className="brand-sep"> · CHATROOMS</span>
          </span>
          <span className="meta">
            {me?.x_handle
              ? <>SIGNED IN AS <a className="brand-back" href={`https://x.com/${me.x_handle}`} target="_blank" rel="noreferrer">@{me.x_handle}</a></>
              : 'PUBLIC · X-VERIFIED POST'}
          </span>
        </header>

        <div className="chat-layout">
          <Sidebar />
          <main className="chat-main">
            <Routes>
              <Route path="/" element={<Navigate to="/r/general" replace />} />
              <Route path="/r/:slug" element={<RoomViewBound me={me} />} />
              <Route path="/auth-callback" element={<AuthCallback />} />
              <Route path="*" element={<div className="enter-body"><p>Not found.</p></div>} />
            </Routes>
          </main>
        </div>
      </div>
    </RealtimeProvider>
  );
}

// react-router useParams() needs to live inside the Routes subtree, not the
// EventSource owner. This thin wrapper forwards `me` so RoomView's hooks see
// a stable param value.
function RoomViewBound({ me }: { me: Me | null }) {
  useParams(); // keep router subscribed
  return <RoomView me={me} />;
}
