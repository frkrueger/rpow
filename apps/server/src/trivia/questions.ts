import { randomInt, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Open Trivia DB batch URL. type=multiple → always 4 choices (1 correct + 3
 * incorrect). amount=50 is the max per request.
 */
const OPENTDB_URL = 'https://opentdb.com/api.php?amount=50&type=multiple';

/**
 * Refill the trivia_questions cache when its size drops below `low`. Stops
 * once size >= `high`. Tolerates Open Trivia DB returning empty batches or
 * failing — gives up after 5 consecutive no-ops.
 *
 * Returns the number of newly inserted rows and the post-refill total count.
 */
export async function refillTriviaQuestions(
  pool: Pool,
  opts: { low: number; high: number },
): Promise<{ inserted: number; total: number }> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trivia_questions`,
  );
  let total = parseInt(rows[0].n, 10);
  if (total >= opts.low) return { inserted: 0, total };

  let inserted = 0;
  let consecutiveEmpty = 0;
  while (total < opts.high && consecutiveEmpty < 5) {
    const batch = await fetchBatch();
    if (batch.length === 0) {
      consecutiveEmpty++;
      continue;
    }
    consecutiveEmpty = 0;
    for (const q of batch) {
      const { choices, correctIdx } = buildChoices(q.correct_answer, q.incorrect_answers);
      await pool.query(
        `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), decodeHtmlEntities(q.category), q.difficulty, decodeHtmlEntities(q.question), correctIdx, choices],
      );
      inserted++;
      total++;
      if (total >= opts.high) break;
    }
  }
  return { inserted, total };
}

interface OpentdbQuestion {
  category: string;
  type: string;
  difficulty: 'easy' | 'medium' | 'hard';
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

async function fetchBatch(): Promise<OpentdbQuestion[]> {
  try {
    const res = await fetch(OPENTDB_URL);
    if (!res.ok) return [];
    const body = await res.json() as { response_code: number; results: OpentdbQuestion[] };
    if (body.response_code !== 0) return [];
    return body.results ?? [];
  } catch {
    return [];
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Assemble the 4-element choices array from the correct answer and 3 incorrect
 * answers. The correct answer is inserted at a random index so its position is
 * not predictable. Both fields are HTML-decoded before placement so the saved
 * strings are display-ready.
 */
function buildChoices(
  correctAnswer: string,
  incorrectAnswers: string[],
): { choices: string[]; correctIdx: number } {
  const decoded = {
    correct: decodeHtmlEntities(correctAnswer),
    incorrect: incorrectAnswers.map(decodeHtmlEntities),
  };
  const correctIdx = randomInt(0, 4);
  const choices = [...decoded.incorrect];
  choices.splice(correctIdx, 0, decoded.correct);
  return { choices, correctIdx };
}

// Exported for unit tests only — not part of the public module API.
export const _internal = { decodeHtmlEntities, buildChoices };
