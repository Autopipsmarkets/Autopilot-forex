# Deploying Autopilot Forex to Railway

Written for **November 2026**. Two platform changes matter here:

- **Railpack** is the default builder. Railway still uses a **Dockerfile** when one
  exists at the repo root, which is what this repo does.
- **Config as Code (`railway.json` / `railway.toml`) is deprecated** and stops
  being read on **2026-12-01**. New services cannot opt in, so this repo has no
  `railway.json`. Build, start and health settings live in the Dockerfile and the
  service settings page.

Everything below is the shortest path that produces a working deployment.

---

## 0. Before you start

| You need | Why |
|---|---|
| The repo `Autopipsmarkets/Autopilot-forex` on `main` | Railway deploys from it |
| A Railway account | Sign in with GitHub — that also makes your trial a **Full Trial** |
| About 10 minutes | Build is ~2–4 min, migrations instant |

**Verify the account before deploying.** Unverified accounts get a *Limited
Trial*: services cannot make outbound requests on most ports, so Stripe,
Resend and Twelve Data all fail while the site itself works. Visit
<https://railway.com/verify> and confirm you are on the Full Trial.

### What the trial actually gives you

| | Trial | Free plan (after) |
|---|---|---|
| Credit | **$5 one-time, 30 days** | **$1 / month** |
| Card required | No | No |
| Services sleep | No | Yes, after 5–10 min idle |
| Projects / services | 5 services per project | 1 project, 3 services |
| Custom domain | Yes | No |

The trial is a one-time boost, not a plan. When the $5 or the 30 days runs out,
services stop until you pick Free or Hobby ($5/month). For a live product that
takes payments, Hobby is the realistic target: free-plan services sleep, and a
sleeping service can miss a Stripe webhook while it wakes up. The database keeps
its data either way, but Railway deletes trial volumes 30 days after credits
expire — take a `pg_dump` before the trial ends.

---

## 1. Create the project

1. <https://railway.com> → **New Project**.
2. **Deploy from GitHub repo** → authorise Railway → pick
   `Autopipsmarkets/Autopilot-forex` → `main`.
3. Railway detects the `Dockerfile` and starts building. The first build will
   fail at the database step if no `DATABASE_URL` exists yet — that is expected.
   Do step 2 before reading logs.

> If Railway ever builds with Railpack instead (no Dockerfile present), it runs
> `npm ci` then `npm run build`, and needs `typescript` at build time. Keeping the
> Dockerfile avoids that class of problem entirely.

## 2. Add PostgreSQL

1. In the project canvas: **New → Database → Add PostgreSQL**.
2. Leave the service name **`Postgres`** — the reference below uses it.
3. Open the **web service** → **Variables** → **New Variable** → **Add Reference**
   → `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.

That reference resolves at deploy time to the private network URL
(`postgres.railway.internal`). Do not paste the public URL.

## 3. Set variables

Web service → **Variables** → **Raw Editor** is fastest:

```bash
NODE_ENV=production
APP_URL=https://REPLACE-WITH-YOUR-DOMAIN
JWT_SECRET=REPLACE_WITH_OPENSSL_RAND_BASE64_48
DATABASE_URL=${{Postgres.DATABASE_URL}}
ADMIN_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=REPLACE_WITH_A_STRONG_PASSWORD
```

Generate the secret locally:

```bash
openssl rand -base64 48
```

Add these as each feature goes live:

```bash
RESEND_API_KEY=
MAIL_FROM=Autopilot Forex <no-reply@yourdomain.com>
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_VIP_MONTHLY=
INTASEND_PUBLISHABLE_KEY=
INTASEND_SECRET_KEY=
INTASEND_WEBHOOK_CHALLENGE=
INTASEND_SANDBOX=true
TWELVE_DATA_API_KEY=
```

Missing keys never crash the app: the API returns `503 not_configured`, and the
site disables the corresponding button or says "not configured".

## 4. Give the service a public domain

1. Service → **Settings → Networking → Generate Domain**.
2. Copy it, e.g. `autopilot-forex-production.up.railway.app`.
3. Set `APP_URL` to that exact value with `https://` and **no trailing slash**.
4. Redeploy (**Deploy → Redeploy**).

`APP_URL` is used for verification links, password resets, Stripe return URLs and
the `Secure` session cookie. If it is wrong, login appears to work and then
immediately forgets you.

## 5. Set the healthcheck

Service → **Settings → Deploy**:

- **Healthcheck Path:** `/health`
- **Healthcheck Timeout:** `120`

`/health` deliberately does not touch the database, so a slow database start
cannot fail an otherwise healthy deploy. `/ready` is the one that probes the DB —
use it from monitoring, not from the platform check.

If you would rather run migrations outside the container start, set
**Pre-Deploy Command** to `npx prisma migrate deploy` and remove it from the
Dockerfile `CMD`. Both are idempotent; keeping it in `CMD` is fine on the free
plan.

## 6. First deploy + owner account

The container runs `npx prisma migrate deploy` before `node dist/server.js`, so
the schema exists after the first successful deploy.

Check:

```bash
curl -s https://YOUR-DOMAIN/health          # {"status":"ok",...}
curl -s https://YOUR-DOMAIN/ready           # {"status":"ready","database":"up"}
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-DOMAIN/
```

Then create the owner once. Either use the service shell (**⋯ → Shell**, or
`railway ssh` locally) and run:

```bash
npm run db:seed
```

or run it from your machine against the public database URL:

```bash
DATABASE_URL="<Postgres → Variables → DATABASE_PUBLIC_URL>" \
ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='your-password' \
npm run db:seed
```

That creates the `OWNER` account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, the two
plans (`vip-monthly` USD 19, `vip-monthly-kes` KES 2,500) and a starter article.

Log in at `https://YOUR-DOMAIN/admin/`.

## 7. Stripe (cards)

1. Stripe → **Products** → new product "Autopilot VIP", recurring **monthly**,
   USD 19 → copy the `price_...` ID.
2. Set `STRIPE_PRICE_VIP_MONTHLY` and redeploy (or edit the plan in
   **/admin/ → Plans**).
3. Stripe → **Developers → Webhooks → Add endpoint**:
   `https://YOUR-DOMAIN/api/webhooks/stripe`
   Events: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, redeploy.
5. Test with `4242 4242 4242 4242` while still in test mode, then swap live keys.

A paid checkout writes a `Payment` row keyed by the Stripe session ID, so
replayed webhooks cannot double-grant a membership.

## 8. M-Pesa (IntaSend)

1. Create the IntaSend account, copy the publishable + secret keys.
2. Set both keys, plus any `INTASEND_WEBHOOK_CHALLENGE` string you choose.
3. IntaSend webhook URL: `https://YOUR-DOMAIN/api/webhooks/intasend`, with the
   same challenge string in their dashboard.
4. Keep `INTASEND_SANDBOX=true` until a KES 10 test payment completes.
5. The M-Pesa button only shows for **KES** plans. The seed ships one; edit it in
   **/admin/ → Plans** if the price should change.

If a customer pays and is not upgraded, check the IntaSend dashboard for the
invoice, then grant the plan from **/admin/ → Users → Manage**. Never re-run a
webhook by hand without checking first — the payment reference is unique.

## 9. Email and prices

- **Resend:** verify your domain, set `RESEND_API_KEY` and `MAIL_FROM`.
  Without it, verification and reset links are printed to the Railway logs only.
- **Twelve Data:** free key from twelvedata.com. Quotes cache for 60 seconds and
  fall back to the last value (marked `cached`) when the provider errors. With no
  key the site says "not configured" instead of inventing numbers.

## 10. Go-live checklist

- [ ] `/health` and `/ready` return 200
- [ ] Register a real account, receive the verification email, verify
- [ ] `/admin/` loads, publish one signal, grant yourself VIP, confirm it unlocks
- [ ] Stripe test payment upgrades the account and appears in **Payments**
- [ ] M-Pesa sandbox payment upgrades the account
- [ ] Contact form lands in **Messages**
- [ ] `APP_URL` matches the live domain (check the cookie is `Secure`)
- [ ] Trial expiry date diarised; `pg_dump` taken before it

## 11. GitHub Pages

`docs/` is published separately at
<https://autopipsmarkets.github.io/Autopilot-forex/> (Settings → Pages →
Deploy from a branch → `main` / `/docs`). That copy is the static brochure and
shows a "Preview build" banner: no API, no login, no live prices. Point its
"Member login" link at the Railway domain once you have one.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build fails on `prisma generate` | `DATABASE_URL` missing at build | Add the variable reference; Prisma only needs it at runtime, but the CLI validates it |
| Deploy fails healthcheck | App crashed or wrong path | Healthcheck Path must be `/health`; check deploy logs |
| `502 Application failed to respond` | Process not listening on `$PORT` | Dockerfile must not hardcode a port; Railway injects `PORT` |
| Login works, then logs out immediately | `APP_URL` scheme/host mismatch, or viewing over `http` | Set `APP_URL` to the exact `https://` domain |
| `/ready` is 503 | Database unreachable | Check `DATABASE_URL` is the reference variable, and Postgres is running |
| Verification emails never arrive | Resend key or domain not verified | Check logs for `[mail:disabled]`, verify sender domain in Resend |
| Stripe webhook 400 | Wrong `STRIPE_WEBHOOK_SECRET`, or body re-encoded by a proxy | Re-copy the secret; Railway forwards the raw body |
| M-Pesa button disabled | Plan currency is USD, or IntaSend keys missing | Use the KES plan and set both keys |
| Site 404s on Railway | Static root wrong | `docs/` must be copied in the image (the Dockerfile does this) |

## Notes on platform limits

- Free/trial services have 0.5–1 GB RAM. This app idles around 90–120 MB; the
  Postgres container adds roughly 100–200 MB.
- Free-plan services sleep after 5–10 minutes without outbound traffic and wake
  on the next request (2–5 s cold start). The database sleeps too and keeps data.
- Egress counts against the same credit ($0.05/GB).
- Config as Code files stop being read on 2026-12-01 — do not re-add
  `railway.json`; use the dashboard or `.railway/railway.ts` IaC if you want
  settings in git.
