import { Panel } from '../components/Panel.js';

type ProtocolApp = {
  name: string;
  url: string;
  description: string;
  /** If set, the click handler forwards the rpow_session cookie via URL fragment.
   *  Sidesteps Chrome quirks where the .rpow2.com cookie doesn't reach subdomain fetches. */
  forwardSession?: boolean;
};

const protocolApps: ProtocolApp[] = [
  {
    name: 'RPOW Long Shot',
    url: 'https://longshot.rpow2.com/',
    description: 'Wager RPOW at 1:1, 2:1, 3:1, or 10:1 longshot. 5% house edge. Outcomes settle against the chain\'s unmined supply.',
  },
  {
    name: 'RPOW Gladiator',
    url: 'https://gladiator.rpow2.com/',
    description: 'PvP coin flips against X-verified opponents. Pure 50/50, zero rake, winner takes both bets. Signed audit per flip.',
    forwardSession: true,
  },
  {
    name: 'RPOW Trivia',
    url: 'https://trivia.rpow2.com/',
    description: 'PvP trivia matches against X-verified opponents. 4 choices, 10 seconds, faster-correct wins. Zero rake, winner takes both bets. Signed audit per match.',
    forwardSession: true,
  },
];

/** Read the rpow_session cookie value from document.cookie. */
function readSessionCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)rpow_session=([^;]+)/);
  return match ? match[1] : null;
}

/** Click handler that forwards the current rpow_session via URL fragment.
 *  The destination app's AuthCallback (or equivalent) reads the fragment,
 *  writes the cookie to its own storage with Domain=.rpow2.com, strips the
 *  fragment, and continues. */
function onForwardSessionClick(e: React.MouseEvent<HTMLAnchorElement>, url: string) {
  const token = readSessionCookie();
  if (!token) return; // not signed in — let the link navigate normally
  e.preventDefault();
  const sep = url.endsWith('/') ? '' : '/';
  window.location.href = `${url}${sep}#/auth-callback?s=${encodeURIComponent(token)}`;
}

// Ordered most-recent first.
const communityApps = [
  {
    name: "Hall's Tavern",
    url: 'https://halstavern.net/',
    description: 'Peer-to-peer betting on real-world events. Stake RPOW on outcomes; pay-on-bet links open the rpow2 wallet and bounce you back automatically after confirmation.',
    author: 'halstavern.net',
    authorUrl: 'https://halstavern.net/',
  },
  {
    name: 'RPOW Market',
    url: 'https://rpowmarket.com/',
    description: 'Marketplace for RPOW tokens',
    author: 'ImMike',
    authorUrl: 'https://github.com/ImMike',
  },
  {
    name: 'RPOW2 Swap',
    url: 'https://rpow2swap.com/',
    description: 'Token swap interface for RPOW2',
    author: '@adamamcbride',
    authorUrl: 'https://x.com/adamamcbride',
  },
];

export function AppsPage() {
  return (
    <>
      <Panel title="PROTOCOL APPS">
        <p style={{ marginTop: 0, fontSize: 12, color: '#888', marginBottom: 16 }}>
          Built and operated by rpow.
        </p>
        {protocolApps.map(app => (
          <div key={app.url} style={{ borderTop: '1px solid #222', padding: '12px 0' }}>
            <div>
              <a
                href={app.url}
                target={app.forwardSession ? undefined : '_blank'}
                rel="noreferrer"
                style={{ color: 'var(--accent)', fontWeight: 700 }}
                onClick={app.forwardSession ? (e) => onForwardSessionClick(e, app.url) : undefined}
              >
                {app.name}
              </a>
            </div>
            <div style={{ fontSize: 12, marginTop: 4, color: '#aaa' }}>{app.description}</div>
          </div>
        ))}
      </Panel>

      <Panel title="COMMUNITY APPS">
        <p style={{ marginTop: 0, fontSize: 12, color: '#888', marginBottom: 16 }}>
          Built by the community. Not affiliated with or endorsed by rpow2.com. Use at your own risk.
        </p>
        {communityApps.map(app => (
          <div key={app.url} style={{ borderTop: '1px solid #222', padding: '12px 0' }}>
            <div>
              <a href={app.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 700 }}>
                {app.name}
              </a>
            </div>
            <div style={{ fontSize: 12, marginTop: 4, color: '#aaa' }}>{app.description}</div>
            <div style={{ fontSize: 11, marginTop: 4, color: '#666' }}>
              by{' '}
              <a href={app.authorUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--dim)' }}>
                {app.author}
              </a>
            </div>
          </div>
        ))}
      </Panel>
    </>
  );
}
