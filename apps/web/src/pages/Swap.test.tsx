import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SwapPage } from './Swap.js';

vi.mock('../hooks/useMe.js', () => ({
  useMe: () => ({
    me: {
      email: 'me@test.com',
      balance_base_units: '1000000000000',
      minted_base_units: '0',
      sent_base_units: '0',
      received_base_units: '0',
      wrap_allowed: false,
      solana_wallet: null,
      x_handle: null,
      x_avatar_url: null,
      srpow_supply_owned_base_units: '0',
      daily_mint_cap_base_units: '0',
      daily_minted_base_units: '0',
      daily_remaining_base_units: '0',
      usdc_base_units: '500000000',
      amm_terms_accepted_at: null,
    },
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

const poolMock = {
  pool: {
    seeded: true,
    reserves: { rpow_base_units: '5000000000000000', usdc_base_units: '2500000000000' },
    total_lp_supply: '1000000000000',
    fee_bps: 30,
    spot_price_usdc_per_rpow_e9: '500000',
    seeded_at: '2026-05-11T00:00:00Z',
  } as any,
  refresh: vi.fn().mockResolvedValue(undefined),
  loading: false,
  error: null,
};
vi.mock('../hooks/useAmmPool.js', () => ({
  useAmmPool: () => poolMock,
}));

const ammMeMock = {
  ammMe: {
    email: 'me@test.com',
    usdc_base_units: '500000000',
    lp_balance: '0',
    terms_accepted_at: null as string | null,
    spot_price_usdc_per_rpow_e9: '500000',
    your_pool_share_bps: null,
  },
  refresh: vi.fn().mockResolvedValue(undefined),
  loading: false,
  error: null,
};
vi.mock('../hooks/useAmmMe.js', () => ({
  useAmmMe: () => ammMeMock,
}));

vi.mock('../api.js', () => ({
  api: {
    amm: {
      pool: vi.fn(),
      me: vi.fn(),
      quoteBuy: vi.fn(),
      quoteSell: vi.fn(),
      buy: vi.fn(),
      sell: vi.fn(),
      acceptTerms: vi.fn(),
    },
  },
}));
import { api } from '../api.js';
const quoteBuyMock = vi.mocked(api.amm.quoteBuy);
const buyMock = vi.mocked(api.amm.buy);
const acceptMock = vi.mocked(api.amm.acceptTerms);

function renderSwap() {
  return render(
    <MemoryRouter initialEntries={['/swap']}>
      <SwapPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  quoteBuyMock.mockReset();
  buyMock.mockReset();
  acceptMock.mockReset();
  ammMeMock.ammMe.terms_accepted_at = null;
  ammMeMock.refresh.mockClear();
  poolMock.refresh.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SwapPage', () => {
  it('quote_debounce: only one quote call 300ms after last keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    renderSwap();
    const input = screen.getByLabelText('amount in') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.change(input, { target: { value: '100' } });
    await vi.advanceTimersByTimeAsync(350);
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalledTimes(1));
    expect(quoteBuyMock).toHaveBeenCalledWith('100000000');
  });

  it('terms_gate_on_first_buy: BUY pops modal, accept then proceed', async () => {
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    acceptMock.mockResolvedValue({ accepted_at: '2026-05-11T00:00:00Z' });
    buyMock.mockResolvedValue({
      swap_id: 'SWAP_1', output_base_units: '100000000', fee_base_units: '0',
      pool_rpow_after: '0', pool_usdc_after: '0', signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^\[ BUY \]$/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /ACCEPT/ }));
    await waitFor(() => expect(acceptMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(buyMock).toHaveBeenCalledOnce());
    expect(buyMock).toHaveBeenCalledWith({
      usdc_base_units: '1000000',
      min_rpow_out: '99500000', // 0.5% slippage on 100000000
    });
  });

  it('terms_skipped_when_accepted: BUY proceeds without modal', async () => {
    ammMeMock.ammMe.terms_accepted_at = '2026-05-11T00:00:00Z';
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    buyMock.mockResolvedValue({
      swap_id: 'SWAP_1', output_base_units: '100000000', fee_base_units: '0',
      pool_rpow_after: '0', pool_usdc_after: '0', signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^\[ BUY \]$/ }));
    await waitFor(() => expect(buyMock).toHaveBeenCalledOnce());
    expect(acceptMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Accept AMM terms/)).toBeNull();
  });

  it('terms_cancel_aborts_write: cancel does not call buy', async () => {
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^\[ BUY \]$/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /CANCEL/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).toBeNull());
    expect(buyMock).not.toHaveBeenCalled();
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it('slippage_to_min_out: 1% slippage produces 99% of quote in min_rpow_out', async () => {
    ammMeMock.ammMe.terms_accepted_at = '2026-05-11T00:00:00Z';
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    buyMock.mockResolvedValue({
      swap_id: 'SWAP_1', output_base_units: '100000000', fee_base_units: '0',
      pool_rpow_after: '0', pool_usdc_after: '0', signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('slippage percent'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^\[ BUY \]$/ }));
    await waitFor(() => expect(buyMock).toHaveBeenCalledWith({
      usdc_base_units: '1000000',
      min_rpow_out: '99000000', // 1% slippage
    }));
  });

  it('pool_not_seeded: renders empty state, no form', async () => {
    poolMock.pool = { seeded: false } as any;
    renderSwap();
    expect(screen.getByText(/pool not yet seeded/)).toBeTruthy();
    expect(screen.queryByLabelText('amount in')).toBeNull();
    poolMock.pool = {
      seeded: true,
      reserves: { rpow_base_units: '5000000000000000', usdc_base_units: '2500000000000' },
      total_lp_supply: '1000000000000', fee_bps: 30,
      spot_price_usdc_per_rpow_e9: '500000', seeded_at: '2026-05-11T00:00:00Z',
    } as any;
  });
});
