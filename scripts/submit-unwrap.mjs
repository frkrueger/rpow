// One-shot operator script: submit an already-landed inbound SRPOW transfer
// to /srpow/unwrap so the server runs the burn → swap → credit pipeline.
//
// Used when the browser unwrap flow signed+landed an inbound transfer but
// the client errored before posting to /srpow/unwrap (e.g. confirmation
// timeout via the no-WS proxy path). The script forges a session for the
// given email using SESSION_SECRET, then hits the local server.
//
// Usage (on VPS):
//   sudo -u rpow env $(sudo cat /etc/rpow/server.env | xargs) \
//     node /opt/rpow/repo/scripts/submit-unwrap.mjs \
//     <email> <signature> <amount_base_units>

import { createHmac } from 'node:crypto';

const [, , email, signature, amountBaseUnits] = process.argv;
if (!email || !signature || !amountBaseUnits) {
  console.error('usage: node submit-unwrap.mjs <email> <signature> <amount_base_units>');
  process.exit(1);
}

const secret = process.env.SESSION_SECRET;
if (!secret) {
  console.error('SESSION_SECRET not set');
  process.exit(1);
}

const exp = Math.floor(Date.now() / 1000) + 60 * 5;
const body = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
const sig = createHmac('sha256', secret).update(body).digest('base64url');
const token = `${body}.${sig}`;

const res = await fetch('http://localhost:8080/srpow/unwrap', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie: `rpow_session=${token}`,
  },
  body: JSON.stringify({
    signature,
    amount_base_units: amountBaseUnits,
    idempotency_key: `manual-${Date.now()}`,
  }),
});

console.log('status:', res.status);
console.log('body:', await res.text());
