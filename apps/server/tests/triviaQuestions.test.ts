import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeTestApp } from './helpers.js';
import { refillTriviaQuestions, _internal } from '../src/trivia/questions.js';

const fakeOpentdbResponse = {
  response_code: 0,
  results: [
    {
      category: 'General Knowledge',
      type: 'multiple',
      difficulty: 'easy',
      question: 'What is the capital of France?',
      correct_answer: 'Paris',
      incorrect_answers: ['London', 'Berlin', 'Madrid'],
    },
    {
      category: 'Entertainment: Film',
      type: 'multiple',
      difficulty: 'medium',
      question: 'Who directed &quot;Pulp Fiction&quot;?',
      correct_answer: 'Quentin Tarantino',
      incorrect_answers: ['Martin Scorsese', 'Steven Spielberg', 'Ridley Scott'],
    },
  ],
};

describe('refillTriviaQuestions', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    vi.restoreAllMocks();
  });

  it('skips fetch when count >= low', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    for (let i = 0; i < 50; i++) {
      await ctx.pool.query(
        `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
         VALUES (gen_random_uuid(), 'x', 'easy', $1, 0, ARRAY['a','b','c','d'])`,
        [`q${i}`],
      );
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await refillTriviaQuestions(ctx.pool, { low: 50, high: 200 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
    expect(result.total).toBe(50);
  });

  it('fetches and inserts when empty', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(fakeOpentdbResponse), { status: 200 }),
    );
    const result = await refillTriviaQuestions(ctx.pool, { low: 50, high: 2 });
    expect(result.inserted).toBe(2);
    expect(result.total).toBe(2);

    const { rows } = await ctx.pool.query<{
      category: string; difficulty: string; question: string; correct_idx: number; choices: string[];
    }>(`SELECT category, difficulty, question, correct_idx, choices FROM trivia_questions ORDER BY question`);
    expect(rows).toHaveLength(2);

    const tarantino = rows.find(r => r.question.includes('Pulp Fiction'))!;
    expect(tarantino.question).toContain('"Pulp Fiction"');

    const paris = rows.find(r => r.question.includes('France'))!;
    // Use a spread so .sort() doesn't mutate the underlying array; the next
    // assertion needs the original ordering with correct_idx.
    expect([...paris.choices].sort()).toEqual(['Berlin', 'London', 'Madrid', 'Paris'].sort());
    expect(paris.choices[paris.correct_idx]).toBe('Paris');
  });

  it('stops after 5 consecutive empty batches', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const emptyBatch = { response_code: 0, results: [] };
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(emptyBatch), { status: 200 }));
    const result = await refillTriviaQuestions(ctx.pool, { low: 50, high: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(result.inserted).toBe(0);
  });

  it('survives a failed HTTP response (500)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    const result = await refillTriviaQuestions(ctx.pool, { low: 50, high: 200 });
    expect(result.inserted).toBe(0);
  });

  describe('decodeHtmlEntities (internal)', () => {
    it('decodes common entities', () => {
      expect(_internal.decodeHtmlEntities('&quot;hi&quot;')).toBe('"hi"');
      expect(_internal.decodeHtmlEntities('rock &amp; roll')).toBe('rock & roll');
      expect(_internal.decodeHtmlEntities('a &lt; b')).toBe('a < b');
      expect(_internal.decodeHtmlEntities('a &gt; b')).toBe('a > b');
      expect(_internal.decodeHtmlEntities('it&#039;s')).toBe("it's");
    });
  });

  describe('buildChoices (internal)', () => {
    it('places correct_answer at the chosen index and includes all 4 strings', () => {
      const { choices, correctIdx } = _internal.buildChoices('Paris', ['London','Berlin','Madrid']);
      expect(choices).toHaveLength(4);
      expect(choices[correctIdx]).toBe('Paris');
      expect(new Set(choices)).toEqual(new Set(['Paris','London','Berlin','Madrid']));
      expect(correctIdx).toBeGreaterThanOrEqual(0);
      expect(correctIdx).toBeLessThan(4);
    });
  });
});
