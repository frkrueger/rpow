export type OddsChoice = '1:1' | '2:1' | '3:1' | '10:1';
export const ODDS_TIERS: OddsChoice[] = ['1:1', '2:1', '3:1', '10:1'];

const HOUSE_EDGE = 0.05;

export function payoutMultipleFor(c: OddsChoice): number {
  return c === '1:1' ? 1 : c === '2:1' ? 2 : c === '3:1' ? 3 : 10;
}
export function winProbabilityFor(c: OddsChoice): number {
  return (1 - HOUSE_EDGE) / (payoutMultipleFor(c) + 1);
}
