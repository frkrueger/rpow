#!/usr/bin/env python3
"""
Classify rpow2 users into REAL / LIKELY_BOT / UNKNOWN buckets.

Heuristics:
1. Domain — known mainstream provider vs unknown/disposable
2. Username pattern — random-looking strings vs name+digits
3. Domain volume — domains with thousands of signups in a short window are bot farms
"""

import csv, re, sys
from collections import defaultdict, Counter
from pathlib import Path

ROOT = Path(__file__).parent
USERS = ROOT / "users.csv"

# Mainstream providers — strong "real" signal (not 100%; bots use these too,
# but the domain itself is legit so we lean real unless username is suspicious).
REAL_DOMAINS = {
    "gmail.com", "googlemail.com",
    "yahoo.com", "yahoo.co.uk", "yahoo.co.jp", "yahoo.fr", "yahoo.de", "ymail.com",
    "outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.fr", "outlook.de",
    "icloud.com", "me.com", "mac.com",
    "aol.com",
    "protonmail.com", "proton.me", "pm.me",
    "fastmail.com", "fastmail.fm",
    "zoho.com",
    "gmx.com", "gmx.de", "gmx.net",
    "web.de", "t-online.de",
    "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net",
    "qq.com", "163.com", "126.com", "sina.com", "sohu.com",
    "naver.com", "daum.net",
    "yandex.ru", "yandex.com", "mail.ru", "rambler.ru",
    "orange.fr", "free.fr", "wanadoo.fr",
    "libero.it", "tiscali.it",
}

# Known disposable / throwaway / temp-mail providers.
DISPOSABLE_DOMAINS = {
    "tempmail.com", "10minutemail.com", "guerrillamail.com", "mailinator.com",
    "throwawaymail.com", "yopmail.com", "trashmail.com", "sharklasers.com",
    "getnada.com", "maildrop.cc", "tempr.email", "tempinbox.com",
    "fakemailgenerator.com", "mohmal.com", "spambog.com",
    "mailnesia.com", "discard.email", "dispostable.com",
    "emailondeck.com", "fakeinbox.com", "mintemail.com",
    "mymails.email", "smail.pw",  # observed in the data
}

# Suffix-based patterns that signal disposable (catch-all for new domains)
DISPOSABLE_SUFFIXES = (
    ".pw", ".work", ".xyz", ".click", ".email", ".live", ".app",  # common throwaway TLDs
)

# Username patterns
RANDOM_HEX_RE = re.compile(r"^[a-z0-9]{10,}$")           # e.g. 7a0nrh806ctr
NAME_DIGITS_RE = re.compile(r"^[a-z]+\d{4,}$")           # e.g. winnie5564
BURNER_RE = re.compile(r"^[a-z]{2,8}\d{2,6}[a-z0-9]+$") # e.g. ronaldo52nggspb

def classify_username(local: str) -> str:
    """Return a username-pattern label."""
    if RANDOM_HEX_RE.fullmatch(local) and not re.search(r"[aeiou]{2,}", local):
        # All-random alphanumeric (low vowel density) = generated
        return "random"
    if BURNER_RE.fullmatch(local):
        return "burner"
    if NAME_DIGITS_RE.fullmatch(local):
        return "name+digits"
    return "normal"

def classify(email: str, domain_count: int) -> tuple[str, str]:
    """
    Return (bucket, reason).
    bucket ∈ {REAL, LIKELY_BOT, UNKNOWN}
    """
    if "@" not in email:
        return "UNKNOWN", "malformed"
    local, _, domain = email.partition("@")
    domain = domain.lower()

    # Hard bot signals (domain-based)
    if domain in DISPOSABLE_DOMAINS:
        return "LIKELY_BOT", f"disposable domain ({domain})"
    if domain.endswith(DISPOSABLE_SUFFIXES) and domain not in REAL_DOMAINS:
        return "LIKELY_BOT", f"throwaway TLD ({domain})"

    # Domain-volume signal — 1000+ signups on an obscure domain is bot farm
    if domain_count >= 500 and domain not in REAL_DOMAINS:
        return "LIKELY_BOT", f"high-volume unknown domain ({domain}, {domain_count})"

    pat = classify_username(local)

    # Real domain + random/burner local-part = bot using legit provider
    if domain in REAL_DOMAINS:
        if pat == "random":
            return "LIKELY_BOT", "random local on real domain"
        if pat == "burner":
            return "LIKELY_BOT", "burner pattern on real domain"
        return "REAL", f"mainstream domain ({domain})"

    # Unknown low-volume domain — name+digits is mildly suspicious but inconclusive
    return "UNKNOWN", f"unknown domain ({domain}), pattern={pat}"

def main():
    rows = list(csv.DictReader(open(USERS)))
    domain_counts = Counter()
    for r in rows:
        e = r["email"].strip().lower()
        if "@" in e:
            domain_counts[e.split("@", 1)[1]] += 1

    buckets = defaultdict(list)
    reason_counts = Counter()

    for r in rows:
        e = r["email"].strip().lower()
        domain = e.split("@", 1)[1] if "@" in e else ""
        bucket, reason = classify(e, domain_counts.get(domain, 0))
        buckets[bucket].append((e, r["created_at"], reason))
        reason_counts[(bucket, reason.split(" (")[0])] += 1

    total = sum(len(v) for v in buckets.values())
    print(f"=== Classification of {total} users ===\n")
    for b in ["REAL", "LIKELY_BOT", "UNKNOWN"]:
        n = len(buckets[b])
        print(f"  {b:<12} {n:>6}  ({n/total:.1%})")
    print()

    print("=== Top reasons within each bucket ===")
    for (b, r), n in reason_counts.most_common(20):
        print(f"  [{b:<10}] {r:<40} {n:>6}")
    print()

    print("=== Top BOT-farm domains (sorted by count) ===")
    farm = Counter()
    for e, _, reason in buckets["LIKELY_BOT"]:
        if "@" in e:
            farm[e.split("@", 1)[1]] += 1
    for d, n in farm.most_common(15):
        print(f"  {d:<40} {n:>6}")

    # Write the buckets to files
    for b in ["REAL", "LIKELY_BOT", "UNKNOWN"]:
        out = ROOT / f"emails-{b.lower()}.csv"
        with open(out, "w") as f:
            w = csv.writer(f)
            w.writerow(["email", "created_at", "reason"])
            for row in buckets[b]:
                w.writerow(row)
        print(f"  wrote {out.name} ({len(buckets[b])} rows)")

if __name__ == "__main__":
    main()
