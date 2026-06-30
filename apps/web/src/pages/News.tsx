type Entry = { when: string; title: string; body: string };

// Newest first.
const ENTRIES: Entry[] = [
  {
    when: 'Mon Jun 30',
    title: 'Anti-bot improvements',
    body: 'Mining bot traffic was degrading performance for real users. We deployed rate limiting on the balance endpoint and an internal balance cache that makes the server significantly more resilient to automated traffic.',
  },
  {
    when: 'Tue May 19',
    title: 'SRPOW → RPOW unwrap added',
    body: 'The bridge now runs both directions. SRPOW on Solana can be unwrapped back to RPOW from the Wrap page — completing the round trip.',
  },
  {
    when: 'Mon May 18',
    title: 'Chat and Free Lottery deprecated',
    body: 'RPOW ChatRooms and the Daily Free Lottery are no longer linked from rpow2.com. Both failed to find an audience. The subdomains remain reachable for now.',
  },
  {
    when: 'Wed May 13',
    title: '★ 200,000 USERS — 6 DAYS · FREE LOTTERY LIVE ★',
    body: 'Six days after launch RPOW2 crosses two hundred thousand users. The Daily Free Lottery is now live at freelottery.rpow2.com — 1,000 RPOW awarded every day for 100 days. First draw today at 19:00 UTC.',
  },
  {
    when: 'Tue May 12',
    title: '★ DAILY FREE LOTTERY launches ★',
    body: '1,000 RPOW awarded daily for 100 days. Tweet to enter. Draws at 19:00 UTC. First draw tomorrow. freelottery.rpow2.com',
  },
  {
    when: 'Tue May 12, 01:02 AM PST',
    title: '★ 100,000 USERS — 5 DAYS ★',
    body: 'Five days after launch RPOW2 crosses one hundred thousand users.',
  },
  {
    when: 'Mon May 11',
    title: 'RPOW Gladiator launches',
    body: '1-on-1 head-to-head game mode goes live at gladiator.rpow2.com.',
  },
  {
    when: 'Mon May 11',
    title: 'RPOW Trivia launches',
    body: 'Trivia game mode goes live alongside Gladiator.',
  },
  {
    when: 'Mon May 11',
    title: '75K users',
    body: 'Three quarters of the way to the next milestone.',
  },
  {
    when: 'Sun May 10',
    title: '50K users — scaling pain, then relief',
    body: 'Hitting 50,000 users triggers a wave of scaling issues. Mitigated with bigger servers and Cloudflare in front.',
  },
  {
    when: 'Sun May 10',
    title: 'Community games arrive',
    body: 'Adam McBride ships RPOWSwap. His friend ships RPOWMarket. Thousands of RPOW trades happen OTC.',
  },
  {
    when: 'Sat May 9',
    title: 'Solana wrapping added',
    body: 'RPOW can now be wrapped to SRPOW on Solana for use in the wider ecosystem.',
  },
  {
    when: 'Fri May 8',
    title: 'Longshot coinflip game added',
    body: 'The first add-on game ships — a coinflip you fund with RPOW.',
  },
  {
    when: 'Thu May 7, 05:56 PM',
    title: 'Prominent Bitcoiners start mining',
    body: 'A handful of well-known Bitcoiners pick up RPOW and start mining for fun.',
  },
  {
    when: 'Thu May 7, 03:56 PM',
    title: 'First miners arrive',
    body: 'Within forty minutes of going live, real people are mining RPOW.',
  },
  {
    when: 'Thu May 7, 03:20 PM',
    title: 'RPOW2.com is live',
    body: 'After a lunch break, a Claude coding session, and DNS settings landing, rpow2.com goes live.',
  },
  {
    when: 'Thu May 7, 10:38 AM',
    title: 'It begins',
    body: 'DotKrueger takes a break from the long-term AI project he is working on to build RPOW — an homage to Hal Finney.',
  },
];

export function NewsPage() {
  return (
    <div style={{ fontFamily: 'monospace', maxWidth: 760, margin: '0 auto', padding: '8px 16px', color: 'var(--text)' }}>
      <pre style={{ margin: 0, color: '#ffd700' }}>{`+========================================================================+
|                          RPOW2 — NEWS / LAUNCH LOG                     |
+========================================================================+`}</pre>

      <ul style={{ listStyle: 'none', padding: 0, marginTop: 24 }}>
        {ENTRIES.map((e, i) => (
          <li key={i} style={{
            padding: '12px 0',
            borderBottom: '1px dashed var(--dim)',
          }}>
            <div style={{ fontSize: 12, color: 'var(--dim)', letterSpacing: 0.5 }}>{e.when}</div>
            <div style={{ marginTop: 2, color: i === 0 ? '#ffec80' : 'var(--accent)', fontWeight: 'bold' }}>
              {e.title}
            </div>
            <div style={{ marginTop: 4 }}>{e.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
