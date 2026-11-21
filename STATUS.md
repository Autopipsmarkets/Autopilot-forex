# Status — 21 November 2026

A factual snapshot of the Autopilot Forex platform. "Done" means the code exists
and was executed here; "pending" means it needs an account, a key or a decision
that only the owner can provide.

## Done and verified

| Item | Evidence |
|---|---|
| Backend API (Fastify + TypeScript, 34 endpoints) | `npm run build`, `npx tsc --noEmit` clean |
| PostgreSQL schema, 14 tables, migration | `prisma/migrations/20261121120551_init`, applied to a local Postgres 14 |
| Auth: Argon2id, JWT access cookie, rotating refresh tokens, email verify, password reset | 24/24 API checks, incl. bad password, duplicate email, session cleared after logout |
| Roles and admin RBAC | `USER` blocked from `/api/admin/*` → 403; `ANALYST`/`SUPPORT`/`ADMIN`/`OWNER` ranked |
| VIP gating | anonymous and free users see `locked: true`; after an admin grant the same signal returns `locked: false` |
| Billing: Stripe checkout + webhooks, IntaSend M-Pesa + webhooks, cancellation | checkout returns `503 not_configured` without keys (by design); signature verification unit-tested; unique `providerRef` prevents double-grants |
| Admin panel (10 sections) | headless Chrome: login → overview cards → signals table, zero console errors |
| Marketing site + member dashboard | headless Chrome: register through the UI → member panel shown, plans loaded from the API |
| Security: CSRF header, rate limits, strict CSP, audit log | POST without `X-Requested-With` → 403; CSP `script-src 'self'`, `script-src-attr 'none'` |
| Production runtime image | simulated the Docker runtime stage with `npm ci --omit=dev`: `/health` 200, `/ready` database up, site/admin/assets 200, `prisma migrate deploy` and `db:seed` both ran |
| Dockerfile as the deployment contract | multi-stage, migrations in `CMD`, static site copied from `docs/` |
| GitHub Pages | `docs/` published at <https://autopipsmarkets.github.io/Autopilot-forex/>; root, `/admin/`, assets, `reset.html`, `post.html` all 200; preview banner shown |

Test commands, all passing on this machine:

```bash
npm test                 # 10 unit tests
python3 tests/e2e.py     # 24 API checks against a running server + Postgres
node tests/ui-smoke.mjs  # headless Chrome, site + admin
node tests/live-pages.mjs# headless Chrome against the published Pages URL
```

## Repository state

- `main` at the commit containing this file; the platform replaced the old
  single-page prototype.
- No `railway.json`: Config as Code is deprecated on Railway and stops being read
  on **2026-12-01**. Deployment settings live in the `Dockerfile` and the Railway
  dashboard.
- `docs/` is the static site (also what Pages publishes). `src/` is the API.
  Keeping them apart means Pages can never expose `src/`, `prisma/` or `.env`.

## Pending — needs the owner

| Step | Why it is blocked here |
|---|---|
| Create the Railway project and add Postgres | Requires the Railway account (GitHub login) |
| Verify the Railway account at railway.com/verify | Unverified accounts get a Limited Trial with restricted outbound traffic — Stripe, Resend and Twelve Data would fail |
| Set `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `APP_URL` | Secrets must be entered in Railway, not written into the repo |
| Run `npm run db:seed` after the first deploy | Creates the owner account and the two plans |
| Stripe product + price ID, webhook secret | Needs the owner's Stripe account |
| IntaSend keys + webhook challenge, sandbox test | Needs the owner's IntaSend account |
| Resend domain verification | Needs DNS access for the sending domain |
| Twelve Data key | Free signup |
| Decide trial → Free vs Hobby | Free sleeps and can miss webhooks; Hobby is $5/month |

## Known limits (not defects)

- **GitHub Pages cannot run the API.** It serves the brochure and says so. Login,
  billing, live prices and the admin panel need the Railway domain.
- **No fund custody, no trade execution, no performance claims.** The product sells
  research and memberships. Adding account management or "we trade for you"
  changes the licensing position (CMA in Kenya, equivalent regimes elsewhere) and
  is a business decision, not a code change.
- **M-Pesa behaviour must be validated in sandbox.** Provider payloads around
  `api_ref` and webhook field names are the usual failure point; the admin grant
  path exists as the reconciliation route.
- **No 2FA, no KYC, no automated dunning emails.** Fine before revenue; revisit
  before scale.
