import type { ReactNode } from 'react';

interface PanelProps {
  title?: string;
  status?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, status, children }: PanelProps) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-title">
          <span>{title}</span>
          {status && <span className="status">{status}</span>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
