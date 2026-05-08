import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.js';

describe('App routes', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
    window.location.hash = '#/claim?token=gift-token';
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/me')) {
        return new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: 'login required' }), { status: 401 });
      }
      if (url.includes('/claim/status')) {
        return Response.json({
          ok: true,
          sender_email: 'sender@example.com',
          recipient_email: 'recipient@example.com',
          amount: 3,
          expires_at: '2026-06-01T00:00:00.000Z',
          status: 'pending',
        });
      }
      return new Response('not found', { status: 404 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the claim landing page from a hash token link', async () => {
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/claim/status?token=gift-token'),
      expect.any(Object),
    ));
    expect(await screen.findByText(/CLAIM LANDING/i)).toBeInTheDocument();
    expect(screen.getByText(/sender@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/recipient@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\[ claim 3 rpow \]/i })).toBeEnabled();
  });
});
