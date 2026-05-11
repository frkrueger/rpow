import { useEffect, useState } from 'react';
import {
  fetchMe, fetchGladiatorMe, fetchLobby, fetchRecentFlips, fetchChat, postChat, formatRpow,
  type Me, type GladiatorProfile, type LobbyEntry, type RecentFlip, type ChatMessage,
} from './api.js';
import { XHandleClaimModal } from './XHandleClaimModal.js';
import { EnterArenaForm } from './EnterArenaForm.js';
import { YourSessionPanel } from './YourSessionPanel.js';
import { FlipModal } from './FlipModal.js';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<GladiatorProfile | null>(null);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [recentFlips, setRecentFlips] = useState<RecentFlip[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [authState, setAuthState] = useState<'loading' | 'spectator' | 'unverified' | 'verified'>('loading');
  const [flipTarget, setFlipTarget] = useState<LobbyEntry | null>(null);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  async function sendChat() {
    const body = chatDraft.trim();
    if (!body || chatBusy) return;
    setChatError(null);
    setChatBusy(true);
    try {
      await postChat(body);
      setChatDraft('');
      const fresh = await fetchChat().catch(() => []);
      setChat(fresh);
    } catch (e: any) {
      setChatError(e.message);
    } finally {
      setChatBusy(false);
    }
  }

  async function refreshAll() {
    // Resolve auth state from /me + /api/gladiator/me FIRST so the banner /
    // modal / arena form appears immediately. Then load lobby/chat/recent
    // in the background — slow or 5xx-stubby read endpoints must not delay
    // the spectator banner.
    const [u, p] = await Promise.all([
      fetchMe().catch(() => null),
      fetchGladiatorMe().catch(() => null),
    ]);
    setMe(u);
    setProfile(p);
    if (!u) setAuthState('spectator');
    else if (!p || !p.x_handle_verified_at) setAuthState('unverified');
    else setAuthState('verified');

    const [l, r, c] = await Promise.all([
      fetchLobby().catch(() => []),
      fetchRecentFlips().catch(() => []),
      fetchChat().catch(() => []),
    ]);
    setLobby(l);
    setRecentFlips(r);
    setChat(c);
  }

  useEffect(() => { refreshAll(); }, []);

  useEffect(() => {
    const t = setInterval(async () => {
      const [l, r, c] = await Promise.all([
        fetchLobby().catch(() => []),
        fetchRecentFlips().catch(() => []),
        fetchChat().catch(() => []),
      ]);
      setLobby(l); setRecentFlips(r); setChat(c);
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const myOpenSession = profile?.open_session ?? null;

  return (
    <div className="app">
      <header>
        <h1>RPOW GLADIATOR</h1>
        <div className="auth-bar">
          {me
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
        <section className="main-col lobby-panel">
          {authState === 'verified' && !myOpenSession && me && (
            <EnterArenaForm
              balanceBaseUnits={me.balance_base_units}
              onEntered={refreshAll}
            />
          )}
          {authState === 'verified' && myOpenSession && (
            <YourSessionPanel session={myOpenSession} onClosed={refreshAll} />
          )}

          <div className="panel-inner">
            <h2>OPEN GLADIATORS ({lobby.length})</h2>
            {lobby.length === 0
              ? <p style={{ color: '#666' }}>nobody in the arena</p>
              : lobby.map(g => {
                  const isOwnSession = me && g.account_email === me.email;
                  return (
                    <div key={g.session_id} className="lobby-row">
                      <div>
                        <strong>@{g.x_handle}</strong>
                        {' — '}
                        bankroll {formatRpow(g.bankroll_remaining_base_units)} RPOW
                        {' — '}
                        bet {formatRpow(g.bet_base_units)} RPOW
                        {' — '}
                        W/L {g.flips_won}/{g.flips_lost}
                      </div>
                      {authState === 'verified' && !isOwnSession && (
                        <button onClick={() => setFlipTarget(g)} style={{ marginLeft: 8 }}>
                          [ FLIP! ]
                        </button>
                      )}
                      {isOwnSession && (
                        <span style={{ marginLeft: 8, color: '#666', fontSize: 11 }}>(you)</span>
                      )}
                    </div>
                  );
                })
            }
          </div>

          <div className="panel-inner" style={{ marginTop: 24 }}>
            <h2>RECENT FLIPS</h2>
            {recentFlips.length === 0
              ? <p style={{ color: '#666' }}>no flips yet</p>
              : recentFlips.slice(0, 10).map(f => {
                  const winnerHandle = f.winner_email === f.offerer_email ? f.offerer_x_handle : f.challenger_x_handle;
                  const loserHandle = f.winner_email === f.offerer_email ? f.challenger_x_handle : f.offerer_x_handle;
                  const payout = (BigInt(f.bet_base_units) * 2n).toString();
                  return (
                    <div key={f.id} className="flip-row">
                      <strong>@{winnerHandle}</strong> beat <span>@{loserHandle}</span> for {formatRpow(payout)} RPOW
                    </div>
                  );
                })
            }
          </div>
        </section>

        <aside className="chat-panel">
          <h2>ARENA CHAT</h2>
          <div className="chat-scroll">
            {chat.length === 0
              ? <p style={{ color: '#666' }}>no messages yet</p>
              : [...chat].reverse().map(m => (
                  <div key={m.id} className={m.kind === 'SYSTEM' ? 'chat-system' : 'chat-user'}>
                    {m.kind === 'SYSTEM' ? <em>{m.body}</em> : <><strong>@{m.x_handle}:</strong> {m.body}</>}
                  </div>
                ))
            }
          </div>
          {authState === 'verified' ? (
            <div className="chat-input-row">
              <input
                type="text"
                value={chatDraft}
                onChange={e => setChatDraft(e.target.value.slice(0, 280))}
                onKeyDown={e => { if (e.key === 'Enter') sendChat(); }}
                placeholder="say something..."
                maxLength={280}
                disabled={chatBusy}
              />
              <button onClick={sendChat} disabled={chatBusy || !chatDraft.trim()}>
                {chatBusy ? '...' : 'send'}
              </button>
            </div>
          ) : (
            <p style={{ fontSize: 11, color: '#666', marginTop: 8 }}>
              {authState === 'unverified'
                ? 'verify your X handle to chat'
                : 'sign in at rpow2.com to chat'}
            </p>
          )}
          {chatError && <div className="error" style={{ marginTop: 6, fontSize: 11 }}>{chatError}</div>}
        </aside>
      </main>

      {flipTarget && me && profile && (
        <FlipModal
          target={flipTarget}
          challengerEmail={me.email}
          challengerHandle={profile.x_handle ?? me.email}
          onClose={() => setFlipTarget(null)}
          onFlipped={refreshAll}
        />
      )}
    </div>
  );
}
