export function parseAllowlist(csv: string): Set<string> {
  return new Set(
    csv.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0),
  );
}

export function isAllowed(set: Set<string>, email: string): boolean {
  return set.has(email.trim().toLowerCase());
}
