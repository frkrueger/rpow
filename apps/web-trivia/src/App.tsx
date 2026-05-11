import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchMe, fetchTriviaMe, fetchLobby, fetchRecentMatches, fetchChat, fetchTriviaStats, postChat,
  fetchActiveMatch, formatRpow, addFavorite, removeFavorite,
  type Me, type TriviaProfile, type LobbyEntry, type RecentMatch, type ChatMessage,
  type TriviaStats, type MatchPollPayload,
} from './api.js';
import { XHandleClaimModal } from './XHandleClaimModal.js';
import { EnterArenaForm } from './EnterArenaForm.js';
import { YourSessionPanel } from './YourSessionPanel.js';
import { TriviaMatchModal } from './TriviaMatchModal.js';

function XLink({ handle }: { handle: string | null | undefined }) {
  if (!handle) return <span>—</span>;
  return (
    <a
      href={`https://x.com/${handle}`}
      target="_blank"
      rel="noreferrer noopener"
      className="x-handle"
    >@{handle}</a>
  );
}

function linkifyHandles(text: string): ReactNode[] {
  const re = /(@[A-Za-z0-9_]{1,15})/g;
  const parts = text.split(re);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      const handle = part.slice(1);
      return <XLink key={i} handle={handle} />;
    }
    return part;
  });
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<TriviaProfile | null>(null);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [recent, setRecent] = useState<RecentMatch[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [stats, setStats] = useState<TriviaStats | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'spectator' | 'unverified' | 'verified'>('loading');

  const [challengeTarget, setChallengeTarget] = useState<LobbyEntry | null>(null);
  const [incomingMatchId, setIncomingMatchId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<'recent' | 'highest-bet'>('recent');
  const [search, setSearch] = useState('');

  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

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

  async function toggleFavorite(entry: LobbyEntry) {
    const prev = lobby;
    const next = lobby.map(g =>
      g.session_id === entry.session_id ? { ...g, is_favorite: !g.is_favorite } : g
    );
    setLobby(next);
    try {
      if (entry.is_favorite) {
        await removeFavorite(entry.x_handle);
      } else {
        await addFavorite(entry.x_handle);
      }
    } catch (e: any) {
      setLobby(prev);
      console.error('favorite toggle failed:', e.message);
    }
  }

  async function refreshAll() {
    const [u, p] = await Promise.all([
      fetchMe().catch(() => null),
      fetchTriviaMe().catch(() => null),
    ]);
    setMe(u);
    setProfile(p);
    if (!u) setAuthState('spectator');
    else if (!p || !p.x_handle_verified_at) setAuthState('unverified');
    else setAuthState('verified');

    const [l, r, c, s] = await Promise.all([
      fetchLobby().catch(() => []),
      fetchRecentMatches().catch(() => []),
      fetchChat().catch(() => []),
      fetchTriviaStats().catch(() => null),
    ]);
    setLobby(l);
    setRecent(r);
    setChat(c);
    if (s) setStats(s);
  }

  useEffect(() => { refreshAll(); }, []);

  useEffect(() => {
    const t = setInterval(async () => {
      const [l, r, c, s] = await Promise.all([
        fetchLobby().catch(() => []),
        fetchRecentMatches().catch(() => []),
        fetchChat().catch(() => []),
        fetchTriviaStats().catch(() => null),
      ]);
      setLobby(l); setRecent(r); setChat(c);
      if (s) setStats(s);
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const myOpenSession = profile?.open_session ?? null;

  useEffect(() => {
    if (!myOpenSession || incomingMatchId || challengeTarget) return;
    const sid = myOpenSession.id;
    let cancelled = false;
    const tick = async () => {
      const m: MatchPollPayload | null = await fetchActiveMatch(sid).catch(() => null);
      if (cancelled) return;
      if (m) {
        setIncomingMatchId(m.id);
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [myOpenSession?.id, incomingMatchId, challengeTarget]);

  const visibleLobby = (() => {
    let rows = [...lobby];
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.x_handle.toLowerCase().includes(q));
    }
    if (sortMode === 'highest-bet') {
      rows.sort((a, b) => {
        const ab = BigInt(a.bet_base_units);
        const bb = BigInt(b.bet_base_units);
        if (ab > bb) return -1;
        if (ab < bb) return 1;
        return 0;
      });
    }
    return rows;
  })();

  const favoritesInArena = lobby.filter(g => g.is_favorite);

  return (
    <div className="app">
      <header>
        <h1>RPOW TRIVIA</h1>
        <div className="auth-bar">
          {me
            ? <span>logged in as {profile?.x_handle ? <XLink handle={profile.x_handle} /> : <strong>{me.email}</strong>}</span>
            : <a href="https://rpow2.com/#/">[ sign in at rpow2.com ]</a>
          }
        </div>
      </header>

      {stats && (
        <div className="kpi-strip">
          <div className="kpi-cell">
            <div className="kpi-num">{stats.total_matches.toLocaleString()}</div>
            <div className="kpi-label">total matches</div>
          </div>
          <div className="kpi-cell">
            <div className="kpi-num">{formatRpow(stats.total_volume_base_units)}</div>
            <div className="kpi-label">RPOW wagered</div>
          </div>
          <div className="kpi-cell">
            <div className="kpi-num">{stats.open_arena_count}</div>
            <div className="kpi-label">in the arena</div>
          </div>
          <div className="kpi-cell">
            <div className="kpi-num">{stats.total_verified_users.toLocaleString()}</div>
            <div className="kpi-label">verified players</div>
          </div>
        </div>
      )}

      {authState === 'loading' && <p style={{ padding: '20px 24px' }}>loading...</p>}

      {authState === 'spectator' && (
        <div className="banner">
          You're spectating. <a href="https://rpow2.com/#/">Sign in at rpow2.com</a> to play.
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

          {authState === 'verified' && favoritesInArena.length > 0 && (
            <div className="panel-inner favorites-panel">
              <h2>FAVORITES IN ARENA ({favoritesInArena.length})</h2>
              {favoritesInArena.map(g => {
                const isOwnSession = me && g.account_email === me.email;
                return (
                  <div key={g.session_id} className="lobby-row">
                    <div>
                      <XLink handle={g.x_handle} />
                      {' — '}
                      bet {formatRpow(g.bet_base_units)} RPOW
                    </div>
                    {!isOwnSession && (
                      <button onClick={() => setChallengeTarget(g)} style={{ marginLeft: 8 }}>
                        [ CHALLENGE ]
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="panel-inner">
            <div className="lobby-controls">
              <h2 style={{ marginBottom: 0 }}>
                OPEN PLAYERS ({visibleLobby.length}{search ? `/${lobby.length}` : ''})
              </h2>
              <div className="lobby-filter">
                <input
                  type="text"
                  placeholder="search @handle..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="lobby-search"
                />
                <select
                  value={sortMode}
                  onChange={e => setSortMode(e.target.value as 'recent' | 'highest-bet')}
                  className="lobby-sort"
                >
                  <option value="recent">recent</option>
                  <option value="highest-bet">highest bet</option>
                </select>
              </div>
            </div>
            {visibleLobby.length === 0
              ? <p style={{ color: '#666' }}>{lobby.length === 0 ? 'nobody in the arena' : 'no matches'}</p>
              : visibleLobby.map(g => {
                  const isOwnSession = me && g.account_email === me.email;
                  return (
                    <div key={g.session_id} className="lobby-row">
                      <div>
                        {authState === 'verified' && !isOwnSession && (
                          <button
                            className={`fav-star ${g.is_favorite ? 'on' : ''}`}
                            title={g.is_favorite ? 'unfavorite' : 'favorite'}
                            onClick={() => toggleFavorite(g)}
                          >{g.is_favorite ? '★' : '☆'}</button>
                        )}
                        <XLink handle={g.x_handle} />
                        {' — '}
                        bankroll {formatRpow(g.bankroll_remaining_base_units)} RPOW
                        {' — '}
                        bet {formatRpow(g.bet_base_units)} RPOW
                        {' — '}
                        W/L {g.matches_won}/{g.matches_lost}
                      </div>
                      {authState === 'verified' && !isOwnSession && (
                        <button onClick={() => setChallengeTarget(g)} style={{ marginLeft: 8 }}>
                          [ CHALLENGE ]
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
            <h2>RECENT MATCHES</h2>
            {recent.length === 0
              ? <p style={{ color: '#666' }}>no matches yet</p>
              : recent.slice(0, 10).map(m => {
                  const winnerHandle = m.winner_email === m.offerer_email ? m.offerer_x_handle : m.challenger_x_handle;
                  const loserHandle = m.winner_email === m.offerer_email ? m.challenger_x_handle : m.offerer_x_handle;
                  const payout = (BigInt(m.bet_base_units) * 2n).toString();
                  return (
                    <div key={m.id} className="flip-row">
                      <XLink handle={winnerHandle} /> beat <XLink handle={loserHandle} /> for {formatRpow(payout)} RPOW
                    </div>
                  );
                })
            }
          </div>
        </section>

        <aside className="chat-panel">
          <h2>ARENA CHAT</h2>
          <div className="chat-scroll" ref={chatScrollRef}>
            {chat.length === 0
              ? <p style={{ color: '#666' }}>no messages yet</p>
              : [...chat].reverse().map(m => (
                  <div key={m.id} className={m.kind === 'SYSTEM' ? 'chat-system' : 'chat-user'}>
                    {m.kind === 'SYSTEM'
                      ? <em>{linkifyHandles(m.body)}</em>
                      : <><XLink handle={m.x_handle} />: {m.body}</>}
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

      {challengeTarget && me && profile && (
        <TriviaMatchModal
          mode={{ kind: 'challenger', target: challengeTarget }}
          myEmail={me.email}
          onClose={() => { setChallengeTarget(null); refreshAll(); }}
        />
      )}

      {incomingMatchId && !challengeTarget && me && profile && (
        <TriviaMatchModal
          mode={{ kind: 'offerer', matchId: incomingMatchId }}
          myEmail={me.email}
          onClose={() => { setIncomingMatchId(null); refreshAll(); }}
        />
      )}
    </div>
  );
}
