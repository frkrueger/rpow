import { useEffect, useMemo, useRef, useState } from 'react';
import { Countdown } from './Countdown.js';
import {
  api,
  FreelotteryStatus,
  TodayResponse,
  TodayEntry,
  WinnersResponse,
  WinnerRow,
} from './api.js';

const TWEET_TEMPLATE = `I am entering the daily free lottery for 1000 RPOW. My code is {code}. freelottery.rpow2.com`;

const POLL_TODAY_MS = 5_000;
const POLL_STATUS_MS = 60_000;
const POLL_WINNERS_MS = 60_000;

function formatPrize(baseUnitsStr: string | undefined): string {
  // RPOW uses 9 decimals: 10^9 base units = 1 RPOW.
  if (!baseUnitsStr) return '1,000';
  try {
    const n = BigInt(baseUnitsStr);
    const rpow = n / 1_000_000_000n;
    return rpow.toLocaleString('en-US');
  } catch {
    return '1,000';
  }
}

function dayIndexFromDate(dayUtc: string, startUtc: string | null): number | null {
  if (!startUtc) return null;
  const a = Date.UTC(
    parseInt(dayUtc.slice(0, 4), 10),
    parseInt(dayUtc.slice(5, 7), 10) - 1,
    parseInt(dayUtc.slice(8, 10), 10),
  );
  const b = Date.UTC(
    parseInt(startUtc.slice(0, 4), 10),
    parseInt(startUtc.slice(5, 7), 10) - 1,
    parseInt(startUtc.slice(8, 10), 10),
  );
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((a - b) / 86_400_000) + 1;
}

function formatDayUtc(dayUtc: string): { month: string; day: string; year: string } {
  const y = dayUtc.slice(0, 4);
  const m = dayUtc.slice(5, 7);
  const d = dayUtc.slice(8, 10);
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const mi = parseInt(m, 10) - 1;
  return {
    month: monthNames[mi] ?? m,
    day: String(parseInt(d, 10)),
    year: y,
  };
}

function avatarOrPlaceholder(url: string | null, handle: string | null, cls: string) {
  if (url) {
    return <img className={cls} src={url} alt={handle ? `@${handle}` : 'avatar'} loading="lazy" />;
  }
  const letter = (handle ?? '?').replace(/^@/, '').slice(0, 1).toUpperCase() || '·';
  return <span className={`${cls} placeholder`} aria-hidden="true">{letter}</span>;
}

function xProfileUrl(handle: string | null): string | null {
  if (!handle) return null;
  const clean = handle.replace(/^@/, '');
  return `https://x.com/${encodeURIComponent(clean)}`;
}

function useInterval(cb: () => void, ms: number) {
  const ref = useRef(cb);
  useEffect(() => { ref.current = cb; }, [cb]);
  useEffect(() => {
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

export function Public() {
  const [status, setStatus] = useState<FreelotteryStatus | null>(null);
  const [today, setToday] = useState<TodayResponse | null>(null);
  const [winners, setWinners] = useState<WinnersResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  // Initial parallel fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, t, w] = await Promise.all([
          api.status(),
          api.today().catch(() => null),
          api.winners().catch(() => null),
        ]);
        if (cancelled) return;
        setStatus(s);
        if (t) setToday(t);
        if (w) setWinners(w);
      } catch (e: any) {
        if (!cancelled) setBootError(e?.message ?? String(e));
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useInterval(() => {
    if (status?.ended) return; // No point polling once the campaign is over.
    api.today().then(setToday).catch(() => {});
  }, POLL_TODAY_MS);

  useInterval(() => {
    api.status().then(setStatus).catch(() => {});
  }, POLL_STATUS_MS);

  useInterval(() => {
    api.winners().then(setWinners).catch(() => {});
  }, POLL_WINNERS_MS);

  // Boot states.
  if (!booted) {
    return (
      <div className="bulletin">
        <header className="masthead">
          <span className="brand">
            <span className="dot" />
            <a className="brand-back" href="https://rpow2.com" title="Back to rpow2.com">
              <span className="brand-back-arrow">←</span> RPOW
            </a>
            <span className="brand-sep"> · FREE LOTTERY</span>
          </span>
          <span className="meta">LOADING…</span>
        </header>
      </div>
    );
  }

  if (bootError && !status) {
    return (
      <div className="bulletin">
        <div className="error-banner">{bootError}</div>
      </div>
    );
  }

  if (!status?.enabled) {
    return <ComingSoonStub />;
  }

  return (
    <RunningView
      status={status}
      today={today}
      winners={winners}
    />
  );
}

function ComingSoonStub() {
  return (
    <div className="stub">
      <p className="stub-eyebrow">Bulletin №000 · Standby</p>
      <h1 className="stub-title">Coming <em>soon</em></h1>
      <p className="stub-body">
        The RPOW Daily Free Lottery is on standby. One thousand RPOW will be given away every
        day for one hundred consecutive days. Check back at launch — the bulletin will publish here.
      </p>
    </div>
  );
}

interface RunningProps {
  status: FreelotteryStatus;
  today: TodayResponse | null;
  winners: WinnersResponse | null;
}

function RunningView({ status, today, winners }: RunningProps) {
  const prize = formatPrize(status.prizeBaseUnits);
  const dayIndex = status.dayIndex ?? 1;
  const totalDays = status.totalDays;
  const bulletinNo = String(dayIndex).padStart(3, '0');
  const ended = status.ended;

  return (
    <div className="bulletin">
      <header className="masthead">
        <span className="brand">
          <span className="dot" />
          <a className="brand-back" href="https://rpow2.com" title="Back to rpow2.com">
            <span className="brand-back-arrow">←</span> RPOW
          </a>
          <span className="brand-sep"> · FREE LOTTERY</span>
        </span>
        <span className="meta">{ended ? 'FINAL · CLOSED' : `LIVE · DRAW DAILY ${String(status.drawHourUtc).padStart(2, '0')}:00 UTC`}</span>
      </header>

      {/* HERO */}
      <section className="hero">
        <div className="hero-left">
          <div className="bulletin-tag">
            <span>Bulletin</span>
            <span className="tag-num">№{bulletinNo}</span>
            <span>/ {String(totalDays).padStart(3, '0')}</span>
          </div>
          <div className="prize-block">
            <p className="prize-eyebrow">
              <span>The Prize</span>
              <span className="sep">·</span>
              <span>Daily</span>
              <span className="sep">·</span>
              <span>{totalDays} Days</span>
            </p>
            <span className="prize-number">{prize}</span>
            <span className="prize-unit">RPOW <i style={{ opacity: 0.5 }}>/ day</i></span>
            <p className="prize-caption">
              {ended
                ? `One hundred draws. Concluded. View the full ledger below.`
                : `One thousand RPOW awarded every day for one hundred consecutive days. Free to enter. One tweet. Holders draw a second ticket.`}
            </p>
          </div>
        </div>

        <div className="hero-right">
          {!ended && <Countdown to={status.nextDrawAt} />}
          {!ended && (
            <a className="cta-primary" href="/enter">
              <span>Enter today's free lottery</span>
              <span className="arrow">→</span>
            </a>
          )}
          {!ended && (
            <div className="stats-strip">
              <div className="stat">
                <span className="stat-label">Today · Entrants</span>
                <span className="stat-value">{today?.total_entries ?? 0}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Today · Tickets</span>
                <span className="stat-value">{today?.total_tickets ?? 0}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ENTRANTS */}
      {!ended && (
        <section className="section" id="today">
          <div className="section-head">
            <h2 className="section-title">Today's <em>entrants</em></h2>
            <p className="section-sub">
              {today ? `${today.total_entries} entrant${today.total_entries === 1 ? '' : 's'} · ${today.total_tickets} ticket${today.total_tickets === 1 ? '' : 's'}` : '—'}
            </p>
          </div>
          <EntrantsGallery entries={today?.entries ?? []} />
        </section>
      )}

      {/* WINNERS */}
      <section className="section" id="winners">
        {ended && (
          <div className="final-banner">
            <span className="final-banner-label">Final results</span>
            <p className="final-banner-text">All one hundred draws complete.</p>
          </div>
        )}
        <div className="section-head">
          <h2 className="section-title">Past <em>winners</em></h2>
          <p className="section-sub">
            {winners ? `${winners.winners.filter(w => w.status === 'ok').length} drawn · receipts on-chain` : '—'}
          </p>
        </div>
        <WinnersLedger winners={winners?.winners ?? []} startUtc={status.startUtcDate} />
      </section>

      {/* HOW IT WORKS */}
      {!ended && <HowItWorks />}

      <footer className="colophon">
        <span>RPOW · freelottery.rpow2.com</span>
        <span>Receipts verifiable on Solana</span>
      </footer>
    </div>
  );
}

function EntrantsGallery({ entries }: { entries: TodayEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="entrants-empty">
        <span className="empty-glyph">no entrants yet</span>
        <p>Be the first to enter today.</p>
        <p style={{ marginTop: '1.4rem' }}>
          <a className="cta-primary" href="/enter" style={{ display: 'inline-flex', width: 'auto' }}>
            <span>Enter the lottery</span>
            <span className="arrow">→</span>
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="entrants">
      {entries.map((e) => (
        <a
          className="entrant fade-in"
          key={e.x_handle}
          href={xProfileUrl(e.x_handle) ?? '#'}
          target="_blank"
          rel="noreferrer"
          title={`@${e.x_handle} on X`}
        >
          {e.ticket_count === 2 && <span className="entrant-badge">+1 Holder</span>}
          {avatarOrPlaceholder(e.x_avatar_url, e.x_handle, 'entrant-avatar')}
          <span className="entrant-handle">@{e.x_handle}</span>
        </a>
      ))}
    </div>
  );
}

function WinnersLedger({ winners, startUtc }: { winners: WinnerRow[]; startUtc: string | null }) {
  if (winners.length === 0) {
    return (
      <div className="winners-empty">
        <p>No draws yet. The ledger publishes after the first 19:00 UTC draw.</p>
      </div>
    );
  }

  return (
    <div className="ledger">
      {winners.map((w) => (
        <WinnerRowView key={w.day_utc} row={w} startUtc={startUtc} />
      ))}
    </div>
  );
}

function WinnerRowView({ row, startUtc }: { row: WinnerRow; startUtc: string | null }) {
  const date = formatDayUtc(row.day_utc);
  const idx = dayIndexFromDate(row.day_utc, startUtc);
  const isEmpty = row.status === 'empty';

  return (
    <div className={`ledger-row${isEmpty ? ' empty' : ''}`}>
      <div className="ledger-date">
        {idx != null && <span className="day-idx">Day {idx}</span>}
        <span>{date.month} {date.day}</span><br />
        <span style={{ color: 'var(--ink-faint)' }}>{date.year}</span>
      </div>

      {isEmpty ? (
        <div className="ledger-body">
          Day {idx ?? '—'} — no entries, prize skipped.
        </div>
      ) : (
        <div className="ledger-body">
          <div className="ledger-winner">
            <a
              className="ledger-avatar-link"
              href={xProfileUrl(row.x_handle) ?? '#'}
              target="_blank"
              rel="noreferrer"
              title={`@${row.x_handle} on X`}
              aria-label={`@${row.x_handle} on X`}
            >
              {avatarOrPlaceholder(row.x_avatar_url, row.x_handle, 'ledger-avatar')}
            </a>
            <div>
              <a
                className="ledger-handle"
                href={xProfileUrl(row.x_handle) ?? '#'}
                target="_blank"
                rel="noreferrer"
              >
                @{row.x_handle}
              </a>
              <p className="ledger-prize">
                Won <strong>{formatPrize(row.prize_base_units)} RPOW</strong> · Drew from {row.total_tickets} ticket{row.total_tickets === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          <div className="ledger-meta">
            {row.tweet_url && (
              <a href={row.tweet_url} target="_blank" rel="noreferrer">View tweet ↗</a>
            )}
            {row.mint_credited_at && (
              <span>Credited {new Date(row.mint_credited_at).toUTCString().slice(5, 16)}</span>
            )}
          </div>

          {(row.solana_slot || row.solana_blockhash) && (
            <details className="receipt">
              <summary>Show on-chain receipt</summary>
              <div className="receipt-body">
                {row.solana_slot && (
                  <div className="field">
                    <span className="field-label">Slot</span>
                    <span className="field-value">{row.solana_slot}</span>
                  </div>
                )}
                {row.solana_blockhash && (
                  <div className="field">
                    <span className="field-label">Blockhash</span>
                    <span className="field-value">{row.solana_blockhash}</span>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="section-head">
        <h2 className="section-title">How <em>it works</em></h2>
        <p className="section-sub">Three steps · free to enter</p>
      </div>

      <div className="steps">
        <div className="step">
          <span className="step-num">01</span>
          <h3 className="step-title">Sign in &amp; link X</h3>
          <p className="step-body">
            Connect an RPOW account and verify your X (Twitter) handle. One handle, one entry per day.
          </p>
        </div>
        <div className="step">
          <span className="step-num">02</span>
          <h3 className="step-title">Post the tweet</h3>
          <p className="step-body">
            We give you a unique code. Post the verification tweet from your X account, then paste the
            tweet URL back into the page.
          </p>
        </div>
        <div className="step">
          <span className="step-num">03</span>
          <h3 className="step-title">Wait for 19:00 UTC</h3>
          <p className="step-body">
            One winner is drawn daily. RPOW holders get a second ticket. Receipts are anchored to Solana
            — verify any draw yourself by slot &amp; blockhash.
          </p>
        </div>
      </div>

      <p className="tweet-template-label">The verification tweet (verbatim):</p>
      <pre className="tweet-template"><code>I am entering the daily free lottery for 1000 RPOW. My code is <span className="var">{'{code}'}</span>. freelottery.rpow2.com</code></pre>
      <p className="small" style={{ marginTop: '0.6rem' }}>
        The literal template is: <code style={{ background: 'transparent', padding: 0 }}>{TWEET_TEMPLATE}</code>
      </p>
    </section>
  );
}
