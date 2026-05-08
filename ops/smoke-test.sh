#!/usr/bin/env bash
# Pre-cutover smoke test. Hits the VPS via --resolve so DNS doesn't gate it.
# Exits 0 if all checks pass; nonzero on any failure.
set -euo pipefail

VPS_IP="${VPS_IP:-15.204.254.192}"
HOST="api.rpow2.com"
RESOLVE="--resolve ${HOST}:443:${VPS_IP}"

curl_ok () {
    local label="$1"; shift
    local code
    code=$(curl -sS -o /tmp/smoke-body -w "%{http_code}" $RESOLVE "$@")
    if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
        echo "OK   $label  (HTTP $code)"
    else
        echo "FAIL $label  (HTTP $code)"
        echo "---body---"
        cat /tmp/smoke-body
        echo
        echo "----------"
        exit 1
    fi
}

echo "=== rpow VPS smoke test (host=$HOST -> $VPS_IP) ==="
curl_ok "GET /health (liveness)" "https://${HOST}/health"
curl_ok "GET /ready (readiness)" "https://${HOST}/ready"

# /ledger is public and proves DB connectivity end-to-end
curl_ok "GET /ledger" "https://${HOST}/ledger"

# TLS cert sanity
echo
echo "=== TLS cert ==="
echo | openssl s_client $RESOLVE -servername "$HOST" -connect "${HOST}:443" 2>/dev/null \
  | openssl x509 -noout -subject -dates -issuer | sed 's/^/  /'

echo
echo "=== smoke OK ==="
