# rpow2

> A tribute to the original RPOW by Hal Finney.

A faithful modern recreation of Hal Finney's [Reusable Proofs of Work](https://nakamotoinstitute.org/finney/rpow/) (2004). Magic-link auth, hashcash mining (~30s on a modern MacBook), Ed25519-signed tokens, email-keyed transfers, public ledger.

## Local dev

Requires Node 22 and Docker.

```bash
docker run --rm -d --name rpow-pg -e POSTGRES_PASSWORD=p -p 55432:5432 postgres:17
npm install
npm run build --workspace @rpow/shared
npm test
```

To run the stack with low difficulty for hands-on testing:

```bash
# In one terminal
DATABASE_URL=postgres://postgres:p@localhost:55432/postgres \
RESEND_API_KEY=re_test EMAIL_FROM='rpow2 <no-reply@rpow2.com>' \
SESSION_SECRET=$(openssl rand -hex 32) \
MAGIC_LINK_BASE_URL=http://localhost:8080 WEB_ORIGIN=http://localhost:5173 \
DIFFICULTY_BITS=20 DIFFICULTY_FLOOR=8 \
RPOW_TEST_INBOX=true \
$(node -e 'import("./apps/server/dist/signing.js").then(({generateKeypair})=>{const k=generateKeypair(); console.log("RPOW_SIGNING_PRIVATE_KEY_HEX="+k.privateHex+" RPOW_SIGNING_PUBLIC_KEY_HEX="+k.publicHex);})') \
npm --workspace @rpow/server run dev

# In another terminal
npm --workspace @rpow/web run dev
```

## Deploy

- Server/API: OVH VPS (`api.rpow2.com`), deployed manually over SSH/systemd.
- Web: Netlify (`rpow2.com`), deployed automatically from `main`.
- DB: self-hosted PostgreSQL on the OVH VPS.
- DNS/TLS: Cloudflare DNS and certbot DNS-01.
- Email: Resend
- Backups: restic to Backblaze B2.

See `docs/RUNBOOK.md` for operator instructions.
