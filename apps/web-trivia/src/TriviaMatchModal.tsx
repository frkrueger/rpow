import { useEffect, useRef, useState } from 'react';
import {
  startMatch, submitAnswer, fetchMatch, formatRpow,
  type MatchPollPayload, type LobbyEntry,
} from './api.js';

type ChallengerMode = { kind: 'challenger'; target: LobbyEntry };
type OffererMode    = { kind: 'offerer'; matchId: string };

interface Props {
  mode: ChallengerMode | OffererMode;
  myEmail: string;
  onClose: () => void;
}

type Stage = 'loading' | 'active' | 'result';

const POLL_MS = 1000;     // poll the match while in-flight
const TICK_MS = 100;      // countdown tick

const LETTERS = ['A', 'B', 'C', 'D'];

export function TriviaMatchModal({ mode, myEmail, onClose }: Props) {
  const [stage, setStage] = useState<Stage>(mode.kind === 'challenger' ? 'loading' : 'active');
  const [match, setMatch] = useState<MatchPollPayload | null>(null);
  const [myPickIdx, setMyPickIdx] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  const matchIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (mode.kind === 'challenger') {
          const start = await startMatch(mode.target.session_id);
          if (cancelled) return;
          matchIdRef.current = start.match_id;
          // Try to get the canonical full payload, but fall back to a synthesized
          // one if the GET races the just-committed INSERT or fails. The 1s poll
          // cycle in 'active' mode will replace this with the canonical payload.
          const m = await fetchMatch(start.match_id).catch(() => null);
          if (cancelled) return;
          const initial: MatchPollPayload = m ?? {
            id: start.match_id,
            state: 'ACTIVE',
            offerer_email: mode.target.account_email,
            challenger_email: myEmail,
            offerer_x_handle: mode.target.x_handle,
            challenger_x_handle: null,
            bet_base_units: start.bet_base_units,
            question_id: start.question_id,
            question: start.question,
            choices: start.choices,
            correct_choice_idx: null,
            offerer_choice_idx: null,
            offerer_answered: false,
            offerer_answered_at: null,
            challenger_choice_idx: null,
            challenger_answered: false,
            challenger_answered_at: null,
            winner_email: null,
            signature_hex: null,
            deadline_at: start.deadline_at,
            created_at: new Date().toISOString(),
            resolved_at: null,
          };
          setMatch(initial);
          setStage(initial.state === 'RESOLVED' ? 'result' : 'active');
        } else {
          matchIdRef.current = mode.matchId;
          const m = await fetchMatch(mode.matchId);
          if (cancelled) return;
          if (m) {
            setMatch(m);
            setStage(m.state === 'RESOLVED' ? 'result' : 'active');
          } else {
            setStartError('could not load match');
          }
        }
      } catch (e: any) {
        setStartError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [mode.kind, mode.kind === 'challenger' ? mode.target.session_id : mode.matchId]);

  useEffect(() => {
    if (stage !== 'active') return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [stage]);

  useEffect(() => {
    if (stage !== 'active' || !matchIdRef.current) return;
    const id = matchIdRef.current;
    const t = setInterval(async () => {
      const m = await fetchMatch(id).catch(() => null);
      if (!m) return;
      setMatch(m);
      if (m.state === 'RESOLVED') setStage('result');
    }, POLL_MS);
    return () => clearInterval(t);
  }, [stage]);

  function secondsLeft(): number {
    if (!match) return 0;
    const ms = new Date(match.deadline_at).getTime() - now;
    return Math.max(0, Math.ceil(ms / 1000));
  }

  async function pick(idx: number) {
    if (!match || myPickIdx !== null || submitting) return;
    setSubmitting(true);
    setMyPickIdx(idx);
    try {
      await submitAnswer(match.id, idx);
      const m = await fetchMatch(match.id).catch(() => null);
      if (m) {
        setMatch(m);
        if (m.state === 'RESOLVED') setStage('result');
      }
    } catch (e: any) {
      setStartError(e.message);
      setMyPickIdx(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (stage === 'loading') {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>STARTING MATCH…</h2>
          {startError && <div className="error" style={{ marginTop: 8 }}>{startError}</div>}
          {startError && (
            <button onClick={onClose} style={{ marginTop: 12 }}>close</button>
          )}
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>LOADING MATCH…</h2>
          {startError && <div className="error" style={{ marginTop: 8 }}>{startError}</div>}
          {startError && (
            <button onClick={onClose} style={{ marginTop: 12 }}>close</button>
          )}
        </div>
      </div>
    );
  }

  const iAmOfferer = match.offerer_email === myEmail;
  const myAnswered = iAmOfferer ? match.offerer_answered : match.challenger_answered;
  const oppAnswered = iAmOfferer ? match.challenger_answered : match.offerer_answered;
  const oppHandle = iAmOfferer ? match.challenger_x_handle : match.offerer_x_handle;

  if (stage === 'active') {
    const remaining = secondsLeft();
    const myPickDisplayed = myPickIdx ?? (myAnswered ? -1 : null);
    return (
      <div className="modal-backdrop">
        <div className="modal trivia-active">
          <div className="trivia-meta">
            <span>vs <a href={`https://x.com/${oppHandle}`} target="_blank" rel="noreferrer noopener" className="x-handle">@{oppHandle}</a></span>
            <span className="trivia-stake">stake {formatRpow(match.bet_base_units)} RPOW</span>
            <span className={`trivia-clock ${remaining <= 3 ? 'urgent' : ''}`}>{remaining}s</span>
          </div>
          <h2 className="trivia-question">{match.question}</h2>
          <div className="trivia-choices">
            {match.choices.map((c, i) => {
              const isMine = myPickDisplayed === i;
              const cls = ['trivia-choice', isMine ? 'picked' : '', myPickDisplayed !== null && !isMine ? 'dim' : ''].join(' ').trim();
              return (
                <button
                  key={i}
                  className={cls}
                  disabled={myPickDisplayed !== null || submitting || remaining === 0}
                  onClick={() => pick(i)}
                >
                  <span className="trivia-letter">{LETTERS[i]}</span>
                  <span className="trivia-choice-text">{c}</span>
                </button>
              );
            })}
          </div>
          <div className="trivia-status">
            {myAnswered && !oppAnswered && `waiting for @${oppHandle}…`}
            {!myAnswered && oppAnswered && `@${oppHandle} has answered. your turn.`}
            {myAnswered && oppAnswered && 'resolving…'}
            {!myAnswered && !oppAnswered && remaining === 0 && 'time up — resolving…'}
          </div>
          {startError && <div className="error" style={{ marginTop: 8 }}>{startError}</div>}
        </div>
      </div>
    );
  }

  const iWon = match.winner_email === myEmail;
  const payout = formatRpow((BigInt(match.bet_base_units) * 2n).toString());
  const correctIdx = match.correct_choice_idx;
  const myIdx = iAmOfferer ? match.offerer_choice_idx : match.challenger_choice_idx;
  const oppIdx = iAmOfferer ? match.challenger_choice_idx : match.offerer_choice_idx;
  const shareText = iWon && oppHandle
    ? `I just won ${payout} RPOW in the RPOW Trivia arena against @${oppHandle} by answering "${match.question.length > 80 ? match.question.slice(0, 77) + '…' : match.question}" correctly. Come fight me at trivia.rpow2.com`
    : '';
  const tweetHref = shareText
    ? `https://x.com/intent/post?text=${encodeURIComponent(shareText)}`
    : '';

  return (
    <div className="modal-backdrop">
      <div className={`modal trivia-result ${iWon ? 'trivia-win' : 'trivia-lose'}`}>
        <h2 style={{ color: iWon ? 'var(--accent)' : '#e07a7a', marginTop: 0 }}>
          {iWon ? `YOU WON ${payout} RPOW` : `YOU LOST ${formatRpow(match.bet_base_units)} RPOW`}
        </h2>
        <p className="trivia-question" style={{ fontSize: 14, fontStyle: 'italic' }}>
          "{match.question}"
        </p>
        <div className="trivia-result-grid">
          {match.choices.map((c, i) => {
            const isCorrect = i === correctIdx;
            const isMyPick = i === myIdx;
            const isOppPick = i === oppIdx;
            const cls = [
              'trivia-result-row',
              isCorrect ? 'correct' : '',
              isMyPick ? 'mine' : '',
              isOppPick ? 'opponent' : '',
            ].join(' ').trim();
            return (
              <div key={i} className={cls}>
                <span className="trivia-letter">{LETTERS[i]}</span>
                <span className="trivia-choice-text">{c}</span>
                <span className="trivia-markers">
                  {isCorrect && <span title="correct answer">✓</span>}
                  {isMyPick && <span title="your pick">you</span>}
                  {isOppPick && <span title="opponent's pick">@{oppHandle}</span>}
                </span>
              </div>
            );
          })}
        </div>
        {match.signature_hex && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
            sig: {match.signature_hex.slice(0, 16)}… · resolved {match.resolved_at && new Date(match.resolved_at).toLocaleTimeString()}
          </div>
        )}
        {iWon && tweetHref && (
          <a
            href={tweetHref}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-block', marginTop: 16 }}
          >
            [ POST TO X ]
          </a>
        )}
        <button onClick={onClose} style={{ marginTop: 16, display: 'block' }}>
          close
        </button>
      </div>
    </div>
  );
}
