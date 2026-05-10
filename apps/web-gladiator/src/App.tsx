import { useEffect, useState } from 'react';
import {
  fetchMe,
  fetchGladiatorMe,
  fetchLobby,
  fetchRecentFlips,
  fetchChat,
  type Me,
  type GladiatorProfile,
  type LobbyEntry,
  type RecentFlip,
  type ChatMessage,
} from './api.js';
import { XHandleClaimModal } from './XHandleClaimModal.js';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<GladiatorProfile | null>(null);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [recentFlips, setRecentFlips] = useState<RecentFlip[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [authState, setAuthState] = useState<'loading' | 'spectator' | 'unverified' | 'verified'>('loading');

  async function refreshAll() {
    const [u, p, l, r, c] = await Promise.all([
      fetchMe(),
      fetchGladiatorMe(),
      fetchLobby(),
      fetchRecentFlips(),
      fetchChat(),
    ]);
    setMe(u);
    setProfile(p);
    setLobby(l);
    setRecentFlips(r);
    setChat(c);
    if (!u) setAuthState('spectator');
    else if (!p || !p.x_handle_verified_at) setAuthState('unverified');
    else setAuthState('verified');
  }

  useEffect(() => { refreshAll(); }, []);

  // 5s polling for lobby + chat + recent flips
  useEffect(() => {
    const t = setInterval(async () => {
      const [l, r, c] = await Promise.all([fetchLobby(), fetchRecentFlips(), fetchChat()]);
      setLobby(l); setRecentFlips(r); setChat(c);
    }, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app">
      <header>
        <h1>RPOW GLADIATOR</h1>
        <div className="auth-bar">
          { me
            ? <span>logged in as <strong>{profile?.x_handle ? `@${profile.x_handle}` : me.email}</strong></span>
            : <a href="https://rpow2.com/#/">[ sign in at rpow2.com ]</a>
          }
        </div>
      </header>

      {authState === 'loading' && <p style={{ padding: '20px 24px' }}>loading...</p>}

      {authState === 'spectator' && (
        <div className="banner">
          You're spectating. <a href="https://rpow2.com/#/">Sign in at rpow2.com</a> to fight.
        </div>
      )}

      {authState === 'unverified' && (
        <XHandleClaimModal onVerified={refreshAll} />
      )}

      <main>
        <section className="lobby-panel">
          <h2>OPEN GLADIATORS ({lobby.length})</h2>
          {lobby.length === 0
            ? <p style={{ color: '#666' }}>nobody in the arena</p>
            : lobby.map(g => (
                <div key={g.session_id} className="lobby-row">
                  <strong>@{g.x_handle}</strong> — bankroll {g.bankroll_remaining_base_units} (bet {g.bet_base_units}) — W/L {g.flips_won}/{g.flips_lost}
                </div>
              ))
          }
          {authState === 'verified' && (
            <p style={{ marginTop: 16, color: '#888' }}>
              [ ENTER ARENA / FLIP buttons land in slice 7 ]
            </p>
          )}
        </section>

        <aside className="chat-panel">
          <h2>ARENA CHAT</h2>
          {chat.length === 0
            ? <p style={{ color: '#666' }}>no messages yet</p>
            : [...chat].reverse().map(m => (
                <div key={m.id} className={m.kind === 'SYSTEM' ? 'chat-system' : 'chat-user'}>
                  {m.kind === 'SYSTEM' ? <em>{m.body}</em> : <><strong>@{m.x_handle}:</strong> {m.body}</>}
                </div>
              ))
          }
        </aside>

        <section className="recent-flips-panel">
          <h2>RECENT FLIPS</h2>
          {recentFlips.length === 0
            ? <p style={{ color: '#666' }}>no flips yet</p>
            : recentFlips.slice(0, 10).map(f => (
                <div key={f.id} className="flip-row">
                  <strong>@{f.winner_email === f.offerer_email ? f.offerer_x_handle : f.challenger_x_handle}</strong>
                  {' beat '}
                  <span>@{f.winner_email === f.offerer_email ? f.challenger_x_handle : f.offerer_x_handle}</span>
                  {' for '}
                  {f.bet_base_units} × 2 base units
                </div>
              ))
          }
        </section>
      </main>
    </div>
  );
}
