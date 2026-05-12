export function NewsPage() {
  return (
    <div style={{ fontFamily: 'monospace', maxWidth: 760, margin: '0 auto', padding: '8px 16px', color: 'var(--text)' }}>
      <pre style={{ margin: 0, color: '#ffd700' }}>{`+========================================================================+
|                          RPOW2 — NEWS / LAUNCH LOG                     |
+========================================================================+`}</pre>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ color: '#ffec80', letterSpacing: 1 }}>★ 100,000 USERS — 5 DAYS ★</h2>
        <p style={{ color: 'var(--dim)' }}>Tuesday, May 12, 2026 — 01:02 AM PST</p>
        <p>
          Five days after launch, RPOW2 crossed one hundred thousand users.
          More milestones — and the rest of the launch story — to follow as
          the operator writes them up.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h3 style={{ color: 'var(--accent)' }}>Launch timeline</h3>
        <p style={{ color: 'var(--dim)', fontStyle: 'italic' }}>
          (entries below to be added — drop them in here)
        </p>
        <ul style={{ paddingLeft: 20, lineHeight: 1.7 }}>
          <li><strong>Day 1</strong> — <em>placeholder</em></li>
          <li><strong>Day 2</strong> — <em>placeholder</em></li>
          <li><strong>Day 3</strong> — <em>placeholder</em></li>
          <li><strong>Day 4</strong> — <em>placeholder</em></li>
          <li><strong>Day 5</strong> — 100,000 users at 01:02 AM PST.</li>
        </ul>
      </section>
    </div>
  );
}
