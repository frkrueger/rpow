import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendPage } from './Send.js';

const { pendingTransfers, resendPendingTransfer, cancelPendingTransfer } = vi.hoisted(() => ({
  pendingTransfers: vi.fn(),
  resendPendingTransfer: vi.fn(),
  cancelPendingTransfer: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: {
    send: vi.fn(),
    pendingTransfers,
    resendPendingTransfer,
    cancelPendingTransfer,
  },
}));

vi.mock('../hooks/useMe.js', () => ({
  useMe: () => ({
    me: { email: 'sender@example.com', balance: 10, minted: 10, sent: 0, received: 0 },
    refresh: vi.fn(),
  }),
}));

describe('SendPage pending transfers', () => {
  beforeEach(() => {
    pendingTransfers.mockResolvedValue([
      {
        id: 'pt_1',
        recipient_email: 'recipient@example.com',
        amount: 2,
        expires_at: '2026-06-01T00:00:00.000Z',
        status: 'pending',
      },
    ]);
    resendPendingTransfer.mockResolvedValue({ ok: true });
    cancelPendingTransfer.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('lists pending transfers and exposes resend/cancel actions', async () => {
    render(<SendPage />);

    expect(await screen.findByText(/PENDING TRANSFERS/i)).toBeInTheDocument();
    expect(screen.getByText(/recipient@example.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /\[ resend \]/i }));
    await waitFor(() => expect(resendPendingTransfer).toHaveBeenCalledWith('pt_1'));
    fireEvent.click(screen.getByRole('button', { name: /\[ cancel \]/i }));
    await waitFor(() => expect(cancelPendingTransfer).toHaveBeenCalledWith('pt_1'));
  });

  it('allows expired pending transfers to be resent or canceled', async () => {
    pendingTransfers.mockResolvedValueOnce([
      {
        id: 'pt_expired',
        recipient_email: 'expired@example.com',
        amount: 1,
        expires_at: '2026-01-01T00:00:00.000Z',
        status: 'expired',
      },
    ]);

    render(<SendPage />);

    expect(await screen.findByText(/expired@example.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /\[ resend \]/i }));
    await waitFor(() => expect(resendPendingTransfer).toHaveBeenCalledWith('pt_expired'));
    fireEvent.click(screen.getByRole('button', { name: /\[ cancel \]/i }));
    await waitFor(() => expect(cancelPendingTransfer).toHaveBeenCalledWith('pt_expired'));
  });
});
