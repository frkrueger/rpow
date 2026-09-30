import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { UnwrapForm } from './UnwrapForm.js';

afterEach(() => { cleanup(); });

describe('UnwrapForm preview math', () => {
  it('shows credit_base_units = 95% of input', () => {
    render(<UnwrapForm
      srpowBalanceBaseUnits={500_000_000_000n}
      config={{
        bridge_wallet_pubkey: 'BRIDGE', srpow_mint_address: 'MINT',
        fee_bps: 500, min_unwrap_base_units: '10000000000',
        max_unwrap_base_units: '1000000000000000000', slippage_bps: 1000,
      }}
      walletAdapter={null}
      onUnwrapped={() => {}}
    />);
    const input = screen.getByLabelText(/amount/i);
    fireEvent.change(input, { target: { value: '100' } });
    expect(screen.getByText(/receive 95 RPOW/i)).toBeInTheDocument();
    expect(screen.getByText(/5 SRPOW fee/i)).toBeInTheDocument();
  });

  it('disables the Unwrap button when amount is below min', () => {
    render(<UnwrapForm
      srpowBalanceBaseUnits={500_000_000_000n}
      config={{
        bridge_wallet_pubkey: 'BRIDGE', srpow_mint_address: 'MINT',
        fee_bps: 500, min_unwrap_base_units: '10000000000',
        max_unwrap_base_units: '1000000000000000000', slippage_bps: 1000,
      }}
      walletAdapter={null}
      onUnwrapped={() => {}}
    />);
    const input = screen.getByLabelText(/amount/i);
    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.getByRole('button', { name: /unwrap/i })).toBeDisabled();
  });
});
