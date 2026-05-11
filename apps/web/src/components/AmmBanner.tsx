/**
 * Persistent funds-at-risk strip rendered at the top of every AMM page.
 * Yellow on dark; one line of text. No interaction.
 */
export function AmmBanner() {
  return (
    <div
      role="note"
      style={{
        background: 'rgba(255, 224, 102, 0.08)',
        color: '#ffe066',
        border: '1px solid #6a5a00',
        padding: '4px 8px',
        marginBottom: 10,
        fontSize: 12,
      }}
    >
      ⚠ GAME — funds at risk
    </div>
  );
}
