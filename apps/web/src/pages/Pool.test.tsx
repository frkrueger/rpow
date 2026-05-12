import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PoolPage } from './Pool.js';

vi.mock('../hooks/useMe.js', () => ({
  useMe: () => ({
    me: {
      email: 'me@test.com',
      balance_base_units: '1000000000000',
      minted_base_units: '0', sent_base_units: '0', received_base_units: '0',
      wrap_allowed: false, solana_wallet: null, x_handle: null, x_avatar_url: null,
      srpow_supply_owned_base_units: '0',
      daily_mint_cap_base_units: '0', daily_minted_base_units: '0', daily_remaining_base_units: '0',
      usdc_base_units: '500000000', amm_terms_accepted_at: null,
    },
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

const poolMock = {
  pool: {
    seeded: true,
    reserves: { rpow_base_units: '5000000000000000', usdc_base_units: '2500000000000' },
    total_lp_supply: '1000000000000', fee_bps: 30,
    spot_price_usdc_per_rpow_e9: '500000', seeded_at: '2026-05-11T00:00:00Z',
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
    terms_accepted_at: '2026-05-11T00:00:00Z' as string | null,
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
      lpAdd: vi.fn(),
      lpRemove: vi.fn(),
      acceptTerms: vi.fn(),
      swapsRecent: vi.fn().mockResolvedValue({ swaps: [] }),
    },
  },
}));
import { api } from '../api.js';
const lpAddMock = vi.mocked(api.amm.lpAdd);
const lpRemoveMock = vi.mocked(api.amm.lpRemove);
const acceptMock = vi.mocked(api.amm.acceptTerms);
const swapsRecentMock = vi.mocked(api.amm.swapsRecent);

function renderPool() {
  return render(
    <MemoryRouter initialEntries={['/pool']}>
      <PoolPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  lpAddMock.mockReset();
  lpRemoveMock.mockReset();
  acceptMock.mockReset();
  swapsRecentMock.mockReset();
  swapsRecentMock.mockResolvedValue({ swaps: [] });
  ammMeMock.ammMe.terms_accepted_at = '2026-05-11T00:00:00Z';
  ammMeMock.ammMe.lp_balance = '0';
});
afterEach(() => cleanup());

describe('PoolPage', () => {
  it('stats_render_from_pool_payload', async () => {
    renderPool();
    expect(screen.getByText(/reserves/)).toBeTruthy();
    expect(screen.getByText(/fee/)).toBeTruthy();
    expect(screen.getByText(/your LP/)).toBeTruthy();
  });

  it('no_lp_disables_remove', async () => {
    renderPool();
    expect((screen.getByLabelText('remove lp burn') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^\[ REMOVE \]$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('add_lp_with_terms_already_accepted', async () => {
    lpAddMock.mockResolvedValue({
      event_id: 'EV1', lp_minted: '0', rpow_consumed: '0', usdc_consumed: '0',
      signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderPool();
    fireEvent.change(screen.getByLabelText('add rpow in'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('add usdc in'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /^\[ ADD \]$/ }));
    await waitFor(() => expect(lpAddMock).toHaveBeenCalledOnce());
    expect(acceptMock).not.toHaveBeenCalled();
    const body = lpAddMock.mock.calls[0][0];
    expect(body.rpow_base_units).toBe('1000000000000');
    expect(body.usdc_base_units).toBe('500000000');
    expect(typeof body.min_lp_out).toBe('string');
  });

  it('add_lp_with_terms_gate_modal', async () => {
    ammMeMock.ammMe.terms_accepted_at = null;
    lpAddMock.mockResolvedValue({
      event_id: 'EV1', lp_minted: '0', rpow_consumed: '0', usdc_consumed: '0',
      signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    acceptMock.mockResolvedValue({ accepted_at: '2026-05-11T00:00:00Z' });
    renderPool();
    fireEvent.change(screen.getByLabelText('add rpow in'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('add usdc in'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /^\[ ADD \]$/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /ACCEPT/ }));
    await waitFor(() => expect(acceptMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(lpAddMock).toHaveBeenCalledOnce());
  });

  it('remove_lp_enabled_when_has_lp', async () => {
    ammMeMock.ammMe.lp_balance = '500000000000';
    lpRemoveMock.mockResolvedValue({
      event_id: 'EV1', rpow_received: '0', usdc_received: '0',
      signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderPool();
    expect((screen.getByLabelText('remove lp burn') as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('remove lp burn'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /^\[ REMOVE \]$/ }));
    await waitFor(() => expect(lpRemoveMock).toHaveBeenCalledOnce());
  });

  it('recent_swaps_empty_state', async () => {
    swapsRecentMock.mockResolvedValue({ swaps: [] });
    renderPool();
    await waitFor(() => expect(screen.getByText(/no swaps yet/)).toBeTruthy());
  });

  it('recent_swaps_renders_list', async () => {
    swapsRecentMock.mockResolvedValue({
      swaps: [{
        id: 'S1', x_handle: null, direction: 'BUY',
        rpow_delta_base_units: '100000000', usdc_delta_base_units: '50000000',
        fee_base_units: '150000', pool_rpow_after: '0', pool_usdc_after: '0',
        created_at: '2026-05-11T14:00:00Z',
      }],
    });
    renderPool();
    await waitFor(() => expect(screen.queryByText(/BUY/)).not.toBeNull());
  });
});
