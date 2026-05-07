import type { ReactNode } from 'react';

const HORIZ = '+----------------------------------------------------------------------+';

export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section style={{ margin: '12px 0' }}>
      {title ? <pre style={{ margin: 0 }}>{`+-- ${title} ${'-'.repeat(Math.max(2, 66 - title.length))}+`}</pre> : <pre style={{ margin: 0 }}>{HORIZ}</pre>}
      <div style={{ padding: '8px 12px' }}>{children}</div>
      <pre style={{ margin: 0 }}>{HORIZ}</pre>
    </section>
  );
}
