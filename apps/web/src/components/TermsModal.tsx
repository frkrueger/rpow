import { useState, useCallback, type ReactNode } from 'react';
import { api } from '../api.js';

/**
 * Promise-gate for AMM writes. Usage:
 *
 *   const { ensureAccepted, modal } = useTermsGate(termsAcceptedAt, onAccepted);
 *   // render `{modal}` somewhere in your component tree
 *   async function submit() {
 *     if (!(await ensureAccepted())) return;
 *     await api.amm.buy(...);
 *   }
 *
 * If `termsAcceptedAt` is already set, `ensureAccepted()` resolves `true`
 * immediately without rendering the modal. Otherwise the modal opens; the
 * promise resolves `true` when the user accepts (and `/amm/accept-terms`
 * succeeds), or `false` when they cancel or the accept call fails.
 */
export function useTermsGate(
  termsAcceptedAt: string | null,
  onAccepted: () => Promise<void> | void,
): { ensureAccepted: () => Promise<boolean>; modal: ReactNode } {
  const [state, setState] = useState<
    | { kind: 'closed' }
    | { kind: 'open'; resolve: (v: boolean) => void; submitting: boolean; error: string | null }
  >({ kind: 'closed' });

  const ensureAccepted = useCallback((): Promise<boolean> => {
    if (termsAcceptedAt) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      setState({ kind: 'open', resolve, submitting: false, error: null });
    });
  }, [termsAcceptedAt]);

  async function accept() {
    if (state.kind !== 'open') return;
    setState({ ...state, submitting: true, error: null });
    try {
      await api.amm.acceptTerms();
      await onAccepted();
      const { resolve } = state;
      setState({ kind: 'closed' });
      resolve(true);
    } catch (err: any) {
      setState({
        ...state,
        submitting: false,
        error: err?.message ?? err?.error ?? 'failed to accept terms',
      });
    }
  }

  function cancel() {
    if (state.kind !== 'open') return;
    const { resolve } = state;
    setState({ kind: 'closed' });
    resolve(false);
  }

  const modal =
    state.kind === 'open' ? (
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
        }}
      >
        <div
          style={{
            background: '#111', color: '#e6e6e6',
            border: '1px solid #444', padding: 18,
            maxWidth: 520, fontSize: 13, lineHeight: 1.6,
            fontFamily: 'ui-monospace, Menlo, monospace',
          }}
        >
          <div style={{ fontWeight: 'bold', marginBottom: 8 }}>
            ⚠ Accept AMM terms
          </div>
          <p style={{ margin: '0 0 8px' }}>
            RPOW Pool is an experimental game. By using it you understand:
          </p>
          <ul style={{ margin: '0 0 12px 20px', padding: 0 }}>
            <li>Funds are at risk. You can lose to slippage, other users, or bugs.</li>
            <li>USDC balances are internal — not currently withdrawable to Solana.</li>
            <li>The 0.30% swap fee accrues to liquidity providers.</li>
          </ul>
          {state.error && (
            <div style={{ color: '#ff6666', marginBottom: 8 }}>error: {state.error}</div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={accept} disabled={state.submitting}>
              [ {state.submitting ? '...' : 'ACCEPT'} ]
            </button>
            <button onClick={cancel} disabled={state.submitting}>
              [ CANCEL ]
            </button>
          </div>
        </div>
      </div>
    ) : null;

  return { ensureAccepted, modal };
}
