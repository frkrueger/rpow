export type OddsChoice = '1:1' | '2:1' | '3:1' | '10:1';

export const ODDS_TIERS: OddsChoice[] = ['1:1', '2:1', '3:1', '10:1'];

const HOUSE_EDGE = 0.05;

export function payoutMultipleFor(choice: OddsChoice): number {
  switch (choice) {
    case '1:1': return 1;
    case '2:1': return 2;
    case '3:1': return 3;
    case '10:1': return 10;
  }
}

/**
 * Win probability with the 5% house edge baked in.
 * p = (1 - house_edge) / (m + 1) so that EV per unit staked = -house_edge for every tier.
 */
export function winProbabilityFor(choice: OddsChoice): number {
  const m = payoutMultipleFor(choice);
  return (1 - HOUSE_EDGE) / (m + 1);
}

export function isValidOddsChoice(s: unknown): s is OddsChoice {
  return typeof s === 'string' && (ODDS_TIERS as readonly string[]).includes(s);
}
