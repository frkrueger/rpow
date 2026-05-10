import { Panel } from '../components/Panel.js';

const protocolApps = [
  {
    name: 'RPOW Long Shot',
    url: 'https://longshot.rpow2.com/',
    description: 'Wager RPOW at 1:1, 2:1, 3:1, or 10:1 longshot. 5% house edge. Outcomes settle against the chain\'s unmined supply.',
  },
];

const communityApps = [
  {
    name: 'RPOW2 Swap',
    url: 'https://rpow2swap.com/',
    description: 'Token swap interface for RPOW2',
    author: '@adamamcbride',
    authorUrl: 'https://x.com/adamamcbride',
  },
  {
    name: 'RPOW Market',
    url: 'https://rpowmarket.com/',
    description: 'Marketplace for RPOW tokens',
    author: 'ImMike',
    authorUrl: 'https://github.com/ImMike',
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
              <a href={app.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 700 }}>
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
