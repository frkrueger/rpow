import { useState } from 'react';

/**
 * Footer link "What is RPOW Pool?" → modal explaining it's a game,
 * how the pool works at a high level, and that USDC is internal-only
 * (no Solana withdrawal yet in slice 4). Plain text; no state beyond
 * open/closed.
 */
export function WhatIsRpowPoolModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <a
        href="#"
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
        style={{ color: '#888', fontSize: 11 }}
      >
        What is RPOW Pool?
      </a>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#111', color: '#e6e6e6',
              border: '1px solid #444', padding: 18,
              maxWidth: 520, fontSize: 13, lineHeight: 1.6,
              fontFamily: 'ui-monospace, Menlo, monospace',
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: 8 }}>What is RPOW Pool?</div>
            <p style={{ margin: '0 0 8px' }}>
              RPOW Pool is an experimental on-platform automated market maker
              (AMM) where you can swap between RPOW tokens and internal USDC.
              Liquidity providers (LPs) earn a share of the 0.30% swap fee.
            </p>
            <p style={{ margin: '0 0 8px' }}>
              This is a <strong>game</strong>. Balances are internal accounting
              entries within rpow2; the USDC here is not currently bridged to
              Solana. Funds can be lost to slippage, smart play by other users,
              or bugs we haven't found yet.
            </p>
            <p style={{ margin: '0 0 12px' }}>
              The pool uses constant-product math (x · y = k) similar to
              Uniswap V2. The price changes with every swap proportionally to
              the trade size.
            </p>
            <button onClick={() => setOpen(false)}>[ close ]</button>
          </div>
        </div>
      )}
    </>
  );
}
