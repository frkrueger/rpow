import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SendPage } from './Send.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

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
      usdc_base_units: '0',
      amm_terms_accepted_at: null,
    },
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../api.js', () => ({
  api: {
    send: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
  },
}));

import { api } from '../api.js';
const sendMock = vi.mocked(api.send);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETURN_URL = 'http://localhost:5173/x';
const RETURN_URL_ENCODED = encodeURIComponent(RETURN_URL);
const EVIL_URL_ENCODED = encodeURIComponent('https://evil.example.com/x');

function renderSend(returnUrl?: string) {
  const search = returnUrl
    ? `/send?to=r%40test.com&amount=1&return_url=${returnUrl}`
    : '/send?to=r%40test.com&amount=1';
  return render(
    <MemoryRouter initialEntries={[search]}>
      <SendPage />
    </MemoryRouter>,
  );
}

const DEFAULT_RESPONSE = {
  ok: true as const,
  transfer_id: 'TX_FAKE',
  recipient_email: 'r@test.com',
  transferred_base_units: '100000000',
  pending: false,
};

// ---------------------------------------------------------------------------
// Window mock state — restored between tests
// ---------------------------------------------------------------------------

let originalLocation: Location;
let originalOpener: typeof window.opener;
let originalClose: typeof window.close;

const fakeOpener = {
  closed: false,
  postMessage: vi.fn(),
  location: { href: 'http://opener.test/before' },
  focus: vi.fn(),
};

beforeEach(() => {
  // Reset sendMock before each test
  sendMock.mockReset();

  // Save originals (first test only — subsequent tests restore from these)
  if (!originalLocation) originalLocation = window.location;
  if (!originalClose) originalClose = window.close;
  // window.opener is null by default in jsdom; save it
  originalOpener = window.opener;

  // Reset fakeOpener spies
  fakeOpener.postMessage.mockReset();
  fakeOpener.focus.mockReset();
  fakeOpener.location.href = 'http://opener.test/before';

  // Replace window.location with a writable mock
  delete (window as unknown as Record<string, unknown>).location;
  (window as unknown as Record<string, unknown>).location = {
    ...(originalLocation as unknown as Record<string, unknown>),
    href: 'http://localhost:3000/initial',
    assign: vi.fn(),
    replace: vi.fn(),
  };

  // Replace window.close with a spy
  const closeSpy = vi.fn();
  Object.defineProperty(window, 'close', {
    value: closeSpy,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // Unmount React trees before restoring window mocks so no async effects
  // fire against a partially-restored window state
  cleanup();

  vi.useRealTimers();

  // Restore window.location
  (window as unknown as Record<string, unknown>).location =
    originalLocation as unknown as Record<string, unknown>;

  // Restore window.close
  Object.defineProperty(window, 'close', {
    value: originalClose,
    writable: true,
    configurable: true,
  });

  // Restore window.opener
  Object.defineProperty(window, 'opener', {
    value: originalOpener,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SendPage — return_url bounce behavior', () => {
  it('opener_bounces: postMessages, navigates opener, closes tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMock.mockResolvedValue(DEFAULT_RESPONSE);

    // Install live fake opener
    Object.defineProperty(window, 'opener', {
      value: fakeOpener,
      writable: true,
      configurable: true,
    });

    renderSend(RETURN_URL_ENCODED);
    fireEvent.click(screen.getByRole('button', { name: /SEND/ }));

    // Wait for api.send to be called and status to become 'sent'
    await waitFor(() => expect(sendMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByText(/returning to localhost/)).not.toBeNull(),
    );

    // Advance past the 600ms timer
    await vi.advanceTimersByTimeAsync(700);

    // 1. postMessage called with correct payload and origin
    expect(fakeOpener.postMessage).toHaveBeenCalledOnce();
    const [payload, origin] = fakeOpener.postMessage.mock.calls[0];
    expect(payload).toMatchObject({
      type: 'rpow:send_complete',
      transfer_id: 'TX_FAKE',
      pending: false,
    });
    expect(typeof payload.at).toBe('string');
    // ISO string — must parse without NaN
    expect(isNaN(Date.parse(payload.at))).toBe(false);
    expect(origin).toBe('http://localhost:5173');

    // 2. Opener navigated to return URL
    expect(fakeOpener.location.href).toBe(RETURN_URL);

    // 3. This tab closed
    expect(window.close).toHaveBeenCalledOnce();

    // 4. "↩ returning to localhost…" shown, NOT "+ SENT"
    expect(screen.getByText(/↩ returning to localhost/)).toBeTruthy();
    expect(screen.queryByText(/\+ SENT/)).toBeNull();

    // 5. This tab's location not changed
    expect((window.location as unknown as Record<string, unknown>).href).toBe(
      'http://localhost:3000/initial',
    );
  });

  it('no_opener_navigates_current_tab: navigates this tab when opener is null', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMock.mockResolvedValue(DEFAULT_RESPONSE);

    // No opener
    Object.defineProperty(window, 'opener', {
      value: null,
      writable: true,
      configurable: true,
    });

    renderSend(RETURN_URL_ENCODED);
    fireEvent.click(screen.getByRole('button', { name: /SEND/ }));

    await waitFor(() => expect(sendMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByText(/returning to localhost/)).not.toBeNull(),
    );

    await vi.advanceTimersByTimeAsync(700);

    // This tab navigated to return URL
    expect((window.location as unknown as Record<string, unknown>).href).toBe(RETURN_URL);

    // window.close NOT called
    expect(window.close).not.toHaveBeenCalled();

    // fakeOpener postMessage NOT called (opener was null — nothing to call on)
    expect(fakeOpener.postMessage).not.toHaveBeenCalled();
  });

  it('disallowed_origin_no_bounce: evil return_url renders "+ SENT", no bounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMock.mockResolvedValue(DEFAULT_RESPONSE);

    // Install opener (but it should never be used)
    Object.defineProperty(window, 'opener', {
      value: fakeOpener,
      writable: true,
      configurable: true,
    });

    renderSend(EVIL_URL_ENCODED);
    fireEvent.click(screen.getByRole('button', { name: /SEND/ }));

    await waitFor(() => expect(sendMock).toHaveBeenCalledOnce());

    // Wait for sent state — "+ SENT" block should appear
    await waitFor(() => expect(screen.queryByText(/\+ SENT/)).not.toBeNull());

    await vi.advanceTimersByTimeAsync(700);

    // returnTarget was null (disallowed), so the "+ SENT" standard block appears
    expect(screen.getByText(/\+ SENT/)).toBeTruthy();
    // "returning to" message NOT shown
    expect(screen.queryByText(/returning to/)).toBeNull();

    // No bounce interactions
    expect(fakeOpener.postMessage).not.toHaveBeenCalled();
    expect(fakeOpener.location.href).toBe('http://opener.test/before');
    expect(window.close).not.toHaveBeenCalled();
    expect((window.location as unknown as Record<string, unknown>).href).toBe(
      'http://localhost:3000/initial',
    );
  });

  it('pending_send_bounces_with_pending_true: pending=true propagated in postMessage', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMock.mockResolvedValue({
      ...DEFAULT_RESPONSE,
      pending: true,
    });

    Object.defineProperty(window, 'opener', {
      value: fakeOpener,
      writable: true,
      configurable: true,
    });

    renderSend(RETURN_URL_ENCODED);
    fireEvent.click(screen.getByRole('button', { name: /SEND/ }));

    await waitFor(() => expect(sendMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByText(/returning to localhost/)).not.toBeNull(),
    );

    await vi.advanceTimersByTimeAsync(700);

    // postMessage payload has pending: true
    expect(fakeOpener.postMessage).toHaveBeenCalledOnce();
    const [payload] = fakeOpener.postMessage.mock.calls[0];
    expect(payload.pending).toBe(true);
    expect(payload.transfer_id).toBe('TX_FAKE');

    // Bounce still happened — opener navigated, tab closed
    expect(fakeOpener.location.href).toBe(RETURN_URL);
    expect(window.close).toHaveBeenCalledOnce();
  });

  it('error_no_bounce: api error renders error message, no bounce occurs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMock.mockRejectedValue({ error: 'INSUFFICIENT_BALANCE', message: 'insufficient' });

    Object.defineProperty(window, 'opener', {
      value: fakeOpener,
      writable: true,
      configurable: true,
    });

    renderSend(RETURN_URL_ENCODED);
    fireEvent.click(screen.getByRole('button', { name: /SEND/ }));

    await waitFor(() => expect(sendMock).toHaveBeenCalledOnce());

    // Error message rendered
    await waitFor(() =>
      expect(
        screen.queryByText(/error: not enough tokens in your wallet/),
      ).not.toBeNull(),
    );

    await vi.advanceTimersByTimeAsync(700);

    // No bounce interactions
    expect(fakeOpener.postMessage).not.toHaveBeenCalled();
    expect(fakeOpener.location.href).toBe('http://opener.test/before');
    expect(window.close).not.toHaveBeenCalled();
    expect((window.location as unknown as Record<string, unknown>).href).toBe(
      'http://localhost:3000/initial',
    );
  });
});
