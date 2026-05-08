// Convert a stringified bigint in base units to a human-readable RPOW amount.
// 9 decimals; trims trailing zeros after the decimal point.
//
// Examples:
//   formatRpow('0')           → '0'
//   formatRpow('1000000000')  → '1'
//   formatRpow('7812500')     → '0.0078125'
//   formatRpow('500000000')   → '0.5'
export function formatRpow(baseUnits: string | bigint): string {
  const bu = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits);
  const denom = 1_000_000_000n;
  const whole = bu / denom;
  const frac = bu % denom;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

// Inverse: parse a user-typed decimal RPOW string into a stringified bigint
// in base units. Throws on invalid input.
//
//   parseRpowToBaseUnits('1')          → '1000000000'
//   parseRpowToBaseUnits('0.0078125')  → '7812500'
//   parseRpowToBaseUnits('0.5')        → '500000000'
export function parseRpowToBaseUnits(rpow: string): string {
  const s = rpow.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('invalid RPOW amount');
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '000000000').slice(0, 9);
  const result = BigInt(whole) * 1_000_000_000n + BigInt(fracPadded);
  return result.toString();
}
