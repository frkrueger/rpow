import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MinePage } from './Mine.js';

vi.mock('../hooks/useMe.js', () => ({
  useMe: () => ({
    me: { email: 'miner@example.com', balance: 1, minted: 0, sent: 0, received: 0 },
    loading: false,
    refresh: vi.fn(),
  }),
}));

describe('MinePage', () => {
  it('shows ETA and simple CPU controls before mining starts', () => {
    render(<MemoryRouter><MinePage /></MemoryRouter>);

    expect(screen.getByText(/ETA/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/auto-mine/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cpu intensity/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\[ mine \]/i })).toBeEnabled();
  });
});
