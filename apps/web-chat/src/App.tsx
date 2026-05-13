import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Sidebar } from './Sidebar.js';

export function App() {
  return (
    <div className="chat-app">
      <header className="masthead">
        <span className="brand">
          <span className="dot" />
          <a className="brand-back" href="https://rpow2.com" title="Back to rpow2.com">
            <span className="brand-back-arrow">←</span> RPOW
          </a>
          <span className="brand-sep"> · CHATROOMS</span>
        </span>
        <span className="meta">PUBLIC · X-VERIFIED POST</span>
      </header>

      <div className="chat-layout">
        <Sidebar />
        <main className="chat-main">
          <Routes>
            <Route path="/" element={<Navigate to="/r/general" replace />} />
            <Route path="/r/:slug" element={<RoomPlaceholder />} />
            <Route path="*" element={<div className="enter-body"><p>Not found.</p></div>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function RoomPlaceholder() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">{slug ? `#${slug}` : 'Room'} <em>placeholder</em></h2>
        <p className="section-sub">Live chat lands in slice 2.</p>
      </div>
      <div className="enter-body">
        <p>Pick a room on the left. Scrollback, composer, presence, typing,
          DMs, and the AI host all land in subsequent slices.</p>
      </div>
    </section>
  );
}
