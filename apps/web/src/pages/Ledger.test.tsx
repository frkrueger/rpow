import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerPage } from './Ledger.js';

const { ledger } = vi.hoisted(() => ({ ledger: vi.fn() }));

vi.mock('../api.js', () => ({
  api: { ledger },
}));

describe('LedgerPage', () => {
  beforeEach(() => {
    ledger.mockResolvedValue({
      total_minted: 1_250_000,
      total_transferred: 12,
      circulating_supply: 42,
      current_difficulty_bits: 26,
      user_count: 7,
      max_supply: 21_000_000,
      epoch: 1,
      epoch_size: 1_000_000,
      next_milestone_at: 2_000_000,
      coins_until_next_milestone: 750_000,
      next_difficulty_bits: 27,
      signing_public_key: 'ed25519-public-key',
      latest_token: {
        id: 'tok_123',
        parent_token_id: 'tok_parent',
        issued_at: '2026-05-08T12:00:00.000Z',
        server_sig: 'deadbeef',
      },
    });
  });

  it('shows supply schedule and signed token provenance details', async () => {
    render(<LedgerPage />);

    expect(await screen.findByText(/EPOCH/i)).toBeInTheDocument();
    expect(screen.getByText(/MAX SUPPLY/i)).toBeInTheDocument();
    expect(screen.getByText(/COINS UNTIL NEXT/i)).toBeInTheDocument();
    expect(screen.getByText(/TOKEN PROVENANCE/i)).toBeInTheDocument();
    expect(screen.getByText(/ed25519-public-key/)).toBeInTheDocument();
    expect(screen.getByText(/tok_parent/)).toBeInTheDocument();
    expect(screen.getByText(/deadbeef/)).toBeInTheDocument();
  });
});
