import { useParams } from 'react-router-dom';

/** Right-rail column: shows RPOW donations to the current chatroom.
 *
 *  Placeholder UI for now — header, total, empty state, disabled CTA.
 *  Real donation flow ships in a follow-up slice (new migration, POST
 *  endpoint, SSE event for live donor list). */
export function Money() {
  const { slug } = useParams<{ slug?: string }>();
  const room = slug ?? 'general';

  return (
    <aside className="chat-money">
      <div className="chat-money-head">MONEY · RPOW DONATIONS</div>
      <div className="chat-money-total">
        <span className="chat-money-total-label">TOTAL</span>
        <span className="chat-money-total-value">0 <em>RPOW</em></span>
      </div>
      <div className="chat-money-sub">to #{room}</div>

      <div className="chat-money-list">
        <div className="chat-money-empty">
          <span className="empty-glyph">no donations yet</span>
          <p>Be the first to fund the room.</p>
        </div>
      </div>

      <button
        type="button"
        className="chat-money-cta"
        disabled
        title="Donations ship in a follow-up slice — UI preview only."
      >
        Donate RPOW <span className="chat-money-soon">soon</span>
      </button>
    </aside>
  );
}
