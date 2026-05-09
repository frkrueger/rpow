// Bitcoin-style halving issuance schedule.
//
//   - Difficulty is fixed at MINT_DIFFICULTY_BITS_DEFAULT (24) trailing-zero bits.
//   - Reward starts at MINT_BASE_REWARD_BASE_UNITS (= 0.001 RPOW = 1,000,000
//     base units, where 10^9 base units = 1 RPOW, matching SRPOW's 9 decimals).
//   - Halvings count from MINT_SCHEDULE_OFFSET_RPOW: minted in
//     [offset, offset+1M) earns 0.001 RPOW/sol, then 0.0005, 0.00025, ...
//   - Schedule terminates at the 19M cap or when the reward in base units
//     drops below 1.

export const MINT_DIFFICULTY_BITS_DEFAULT = 24;
export const BASE_UNITS_PER_RPOW = 1_000_000_000n;        // 9 decimals
export const MINT_BASE_REWARD_BASE_UNITS = 1_000_000n;    // 0.001 RPOW
export const MINT_HALVING_INTERVAL_RPOW = 1_000_000;
export const MINT_MAX_SUPPLY_RPOW = 19_000_000;
export const MINT_SCHEDULE_OFFSET_RPOW = 9_000_000;       // halving #0 starts here

export interface ScheduleOpts {
  difficultyBits?: number;
  baseRewardBaseUnits?: bigint;
  halvingIntervalRpow?: number;
  maxSupplyRpow?: number;
  scheduleOffsetRpow?: number;
}

export interface ScheduleInfo {
  currentDifficultyBits: number;
  currentRewardBaseUnits: bigint;
  halvingIndex: number;                 // 0 during phase 0
  nextHalvingAtBaseUnits: bigint;       // capped at maxSupply
  baseUnitsToNextHalving: bigint;
  nextRewardBaseUnits: bigint;
  isCapped: boolean;
  isMintable: boolean;                  // false when capped or reward is 0
}

interface Resolved {
  difficultyBits: number;
  baseRewardBaseUnits: bigint;
  halvingIntervalBaseUnits: bigint;
  maxSupplyBaseUnits: bigint;
  scheduleOffsetBaseUnits: bigint;
}

function resolve(opts?: ScheduleOpts): Resolved {
  const difficultyBits = opts?.difficultyBits ?? MINT_DIFFICULTY_BITS_DEFAULT;
  const baseRewardBaseUnits = opts?.baseRewardBaseUnits ?? MINT_BASE_REWARD_BASE_UNITS;
  const halvingIntervalRpow = opts?.halvingIntervalRpow ?? MINT_HALVING_INTERVAL_RPOW;
  const maxSupplyRpow = opts?.maxSupplyRpow ?? MINT_MAX_SUPPLY_RPOW;
  const scheduleOffsetRpow = opts?.scheduleOffsetRpow ?? MINT_SCHEDULE_OFFSET_RPOW;
  return {
    difficultyBits,
    baseRewardBaseUnits,
    halvingIntervalBaseUnits: BigInt(halvingIntervalRpow) * BASE_UNITS_PER_RPOW,
    maxSupplyBaseUnits: BigInt(maxSupplyRpow) * BASE_UNITS_PER_RPOW,
    scheduleOffsetBaseUnits: BigInt(scheduleOffsetRpow) * BASE_UNITS_PER_RPOW,
  };
}

export function difficultyBitsForSupply(_mintedBaseUnits: bigint, opts?: ScheduleOpts): number {
  // Difficulty is constant in the halving model.
  return resolve(opts).difficultyBits;
}

export function currentRewardBaseUnits(mintedBaseUnits: bigint, opts?: ScheduleOpts): bigint {
  const r = resolve(opts);
  const minted = mintedBaseUnits < 0n ? 0n : mintedBaseUnits;
  const adjusted = minted < r.scheduleOffsetBaseUnits ? 0n : minted - r.scheduleOffsetBaseUnits;
  const halvings = adjusted / r.halvingIntervalBaseUnits;
  let reward = r.baseRewardBaseUnits;
  for (let i = 0n; i < halvings; i++) {
    reward = reward / 2n;
    if (reward === 0n) return 0n;
  }
  return reward;
}

export function scheduleInfo(mintedBaseUnits: bigint, opts?: ScheduleOpts): ScheduleInfo {
  const r = resolve(opts);
  const minted = mintedBaseUnits < 0n ? 0n : mintedBaseUnits;
  const adjusted = minted < r.scheduleOffsetBaseUnits ? 0n : minted - r.scheduleOffsetBaseUnits;
  const halvingIndex = Number(adjusted / r.halvingIntervalBaseUnits);
  const reward = currentRewardBaseUnits(minted, opts);
  const nextReward = reward === 0n ? 0n : reward / 2n;
  const naiveNextHalving = (BigInt(halvingIndex) + 1n) * r.halvingIntervalBaseUnits + r.scheduleOffsetBaseUnits;
  const nextHalvingAt = naiveNextHalving > r.maxSupplyBaseUnits
    ? r.maxSupplyBaseUnits
    : naiveNextHalving;
  const isCapped = minted >= r.maxSupplyBaseUnits;
  const isMintable = !isCapped && reward > 0n;
  const baseUnitsToNextHalving = nextHalvingAt > minted ? nextHalvingAt - minted : 0n;
  return {
    currentDifficultyBits: r.difficultyBits,
    currentRewardBaseUnits: reward,
    halvingIndex,
    nextHalvingAtBaseUnits: nextHalvingAt,
    baseUnitsToNextHalving,
    nextRewardBaseUnits: nextReward,
    isCapped,
    isMintable,
  };
}
