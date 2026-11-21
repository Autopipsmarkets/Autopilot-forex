# Autopilot Forex — platform

Production backend, member area and admin console for Autopips Markets.
Replaces the earlier single-page Supabase prototype with a self-hosted API,
PostgreSQL database, VIP billing and an operations panel.

```
server (Fastify + TypeScript)  ──  PostgreSQL (Prisma)
        │
        ├── docs/              marketing site + member dashboard (also served by GitHub Pages)
        ├── docs/admin/        operations console (users, signals, research, billing)
        └── /api/*             JSON API
```

One Railway service serves both the API and the static site, so there is no CORS
setup to maintain and no second hosting bill.

---

## What is implemented

| Area | Detail |
|---|---|
| Auth | Email + password, Argon2id hashing, JWT access cookie (15 min), rotating refresh tokens (30 days, hashed at rest), email verification, password reset, logout everywhere on password change |
| Roles | `USER` → `ANALYST` → `SUPPORT` → `ADMIN` → `OWNER`, enforced per route |
| Members | Dashboard with membership state, signal access, billing actions |
| Signals | Full CRUD, VIP gating, open/closed lifecycle, public teaser rows |
| Research | Markdown-lite articles, drafts, VIP-only pieces, public reader page |
| Billing | Stripe Checkout subscriptions + M-Pesa (IntaSend) STK push, signed webhooks, idempotent payment records, cancellation |
| Admin | Stats, user management (role/status/password), manual VIP grants, plans, subscriptions, payments, contact inbox, audit log, settings |
| Ops | `/health`, `/ready` (DB probe), structured logs, graceful shutdown, rate limiting, strict CSP, CSRF guard, request validation |
| Tests | 10 unit tests, 24 API end-to-end checks, headless UI smoke test |

## Local setup

```bash
npm install
cp .env.example .env          # fill JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
createdb autopilot
npx prisma migrate deploy     # or: npx prisma migrate dev
npm run db:seed               # creates the OWNER account + plans
npm run dev                   # http://localhost:8080
```

Site: `http://localhost:8080` · Admin: `http://localhost:8080/admin/`

Useful commands:

```bash
npm run typecheck
npm test              # unit
python3 tests/e2e.py  # API end-to-end (server must be running)
node tests/ui-smoke.mjs   # headless Chrome UI test
```

## API map

```
POST   /api/auth/register | login | logout | refresh
GET    /api/auth/me | session
POST   /api/auth/forgot-password | reset-password | resend-verification
GET    /api/auth/verify-email?token=…

GET    /api/public/site | markets | posts | posts/:slug | signals
POST   /api/contact

GET    /api/me | me/subscription | me/signals | me/purchases
PATCH  /api/me
POST   /api/me/change-password

GET    /api/billing/plans
POST   /api/billing/checkout | cancel
POST   /api/webhooks/stripe | intasend

GET    /api/admin/stats
GET    /api/admin/users | users/:id
PATCH  /api/admin/users/:id
POST   /api/admin/users/:id/grant
CRUD   /api/admin/signals | posts
GET    /api/admin/plans   PUT /api/admin/plans/:code
GET    /api/admin/subscriptions | payments | messages | audit | settings
```

## Security model

- Session cookies are `httpOnly`, `Secure` in production, `SameSite=Lax`.
- Cookie-authenticated writes require the `X-Requested-With: autopilot-forex`
  header, which a cross-site form cannot set. Bearer clients are exempt.
- Passwords: Argon2id (19 MiB, t=2), minimum 10 characters, small blocklist.
- Login and registration are rate limited to 10 attempts / 15 min per IP.
- Stripe webhooks verify the signature over the raw body; IntaSend webhooks
  verify an HMAC challenge. Payment rows are unique per provider reference, so
  replays cannot double-grant.
- Admin actions write to an append-only audit table.

## Deliberately not included

- **Custody or trade execution.** The platform publishes research and
  subscriptions; it never holds client funds or places orders. Adding
  "deposit and we trade for you" changes the regulatory position entirely
  (CMA licence in Kenya, plus investment-services rules elsewhere) and is not
  something the code should imply.
- Performance claims or guaranteed returns. Signals are labelled as research.
- KYC/AML, tax reporting, 2FA and email deliverability tuning beyond Resend.
  If you later bill in markets that require KYC, add it before taking money.
