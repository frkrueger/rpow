import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { normalizeHandle, verifyTweet } from './xVerify.js';

// ---------------------------------------------------------------------------
// normalizeHandle
// ---------------------------------------------------------------------------
describe('normalizeHandle', () => {
  it('strips leading @ and lowercases', () => {
    expect(normalizeHandle('@FooBar')).toBe('foobar');
    expect(normalizeHandle('@FOO')).toBe('foo');
  });

  it('accepts a handle without @', () => {
    expect(normalizeHandle('Foo_Bar')).toBe('foo_bar');
    expect(normalizeHandle('hello123')).toBe('hello123');
  });

  it('accepts exactly 15 characters', () => {
    expect(normalizeHandle('a'.repeat(15))).toBe('a'.repeat(15));
  });

  it('rejects empty string', () => {
    expect(normalizeHandle('')).toBeNull();
  });

  it('rejects bare @', () => {
    expect(normalizeHandle('@')).toBeNull();
  });

  it('rejects handles longer than 15 chars', () => {
    expect(normalizeHandle('a'.repeat(16))).toBeNull();
  });

  it('rejects handles with whitespace', () => {
    expect(normalizeHandle('foo bar')).toBeNull();
    expect(normalizeHandle('foo\tbar')).toBeNull();
  });

  it('rejects handles with non-ASCII characters', () => {
    expect(normalizeHandle('héllo')).toBeNull();
    expect(normalizeHandle('こんにちは')).toBeNull();
    expect(normalizeHandle('café')).toBeNull();
  });

  it('rejects handles with special characters', () => {
    expect(normalizeHandle('foo-bar')).toBeNull();
    expect(normalizeHandle('foo.bar')).toBeNull();
    expect(normalizeHandle('foo@bar')).toBeNull();
  });

  it('accepts alphanumeric and underscores', () => {
    expect(normalizeHandle('_foo_123_')).toBe('_foo_123_');
  });
});

// ---------------------------------------------------------------------------
// verifyTweet
// ---------------------------------------------------------------------------
describe('verifyTweet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const VALID_TWEET_URL = 'https://twitter.com/SomeUser/status/1234567890';

  it('happy path: returns parsed authorHandle and text', async () => {
    const mockResponse = {
      author_url: 'https://twitter.com/SomeUser',
      html: '<blockquote>Hello &amp; <a href="#">world</a></blockquote>',
    };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const result = await verifyTweet(VALID_TWEET_URL);
    expect(result).not.toBeNull();
    expect(result!.authorHandle).toBe('someuser');
    expect(result!.text).toContain('Hello & world');
  });

  it('handles x.com tweet URLs', async () => {
    const mockResponse = {
      author_url: 'https://twitter.com/TestUser',
      html: '<blockquote>Test tweet</blockquote>',
    };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const result = await verifyTweet('https://x.com/TestUser/status/9876543210');
    expect(result).not.toBeNull();
    expect(result!.authorHandle).toBe('testuser');
  });

  it('returns null on non-200 response', async () => {
    // First attempt returns non-200, retry also non-200
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as any);

    const result = await verifyTweet(VALID_TWEET_URL);
    expect(result).toBeNull();
  });

  it('returns null on timeout (AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    vi.spyOn(global, 'fetch').mockRejectedValue(abortError);

    const result = await verifyTweet(VALID_TWEET_URL);
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    } as any);

    const result = await verifyTweet(VALID_TWEET_URL);
    expect(result).toBeNull();
  });

  it('returns null for invalid tweet URL (no fetch called)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    const result = await verifyTweet('https://example.com/not-a-tweet');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for non-https tweet URL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    const result = await verifyTweet('http://twitter.com/foo/status/123');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('strips HTML tags from tweet body', async () => {
    const mockResponse = {
      author_url: 'https://twitter.com/Alice',
      html: '<p>My code is <strong>034281</strong>. <a href="http://example.com">link</a></p>',
    };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const result = await verifyTweet('https://twitter.com/Alice/status/111');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('034281');
    expect(result!.text).not.toContain('<');
    expect(result!.text).not.toContain('>');
  });

  it('decodes HTML entities', async () => {
    const mockResponse = {
      author_url: 'https://twitter.com/Alice',
      html: '&quot;hello&quot; &amp; &lt;world&gt; it&#39;s',
    };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const result = await verifyTweet('https://twitter.com/Alice/status/111');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('"hello" & <world> it\'s');
  });

  it('retries once on transient failure and succeeds on second attempt', async () => {
    const mockResponse = {
      author_url: 'https://twitter.com/SomeUser',
      html: '<p>Retry success</p>',
    };
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

    const result = await verifyTweet(VALID_TWEET_URL);
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Retry success');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null if both attempts fail', async () => {
    vi.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'));

    const result = await verifyTweet(VALID_TWEET_URL);
    expect(result).toBeNull();
  });
});
