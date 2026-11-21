# Deploying to Railway (free trial)

The free trial gives a small credit and one project. This setup needs exactly
**two** resources: the web service and a Postgres database.

## 1. Get the code into a repository

The current repo (`autopipsmarkets/Autopilot-forex`) holds only `index.html`,
`README.md` and `logo.png`. Replace its contents with this project, keeping a
copy of the old `index.html` if you want to compare:

```bash
# from this folder
git init -b main
git add .
git commit -m "Production platform: API, database, member area, admin panel"
git remote add origin https://github.com/autopipsmarkets/Autopilot-forex.git
git push --force origin main
```

`--force` overwrites the old prototype page. Do it only after you are happy with
the new site — the git history still keeps the old commit.

## 2. Create the Railway project

1. railway.com → **New Project** → **Deploy from GitHub repo** → pick the repo.
2. In the same project: **New** → **Database** → **Add PostgreSQL**.
3. Open the web service → **Variables** → **New Variable** → **Add reference**
   → `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
4. Add the remaining variables (see below).
5. **Settings → Networking → Generate Domain** to get a public URL.
6. Set `APP_URL` to that exact URL (with `https://`, no trailing slash) and redeploy.

Railway injects `PORT` automatically; the app binds to `0.0.0.0`.

## 3. Variables

Required:

```
NODE_ENV=production
APP_URL=https://your-service.up.railway.app
JWT_SECRET=<openssl rand -base64 48>
DATABASE_URL=${{Postgres.DATABASE_URL}}
ADMIN_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=<a strong password, 10+ chars>
```

Add as you switch features on:

```
RESEND_API_KEY=            # verification + reset emails
MAIL_FROM=Autopilot Forex <no-reply@yourdomain.com>
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_VIP_MONTHLY=
INTASEND_PUBLISHABLE_KEY=
INTASEND_SECRET_KEY=
INTASEND_WEBHOOK_CHALLENGE=
INTASEND_SANDBOX=false
TWELVE_DATA_API_KEY=       # live quotes
```

Without the payment keys the VIP buttons stay disabled and the API returns a
clear "not configured" message — nothing crashes.

## 4. First deploy

The start command is `npm run db:migrate && npm start`, so migrations run on
every deploy automatically. Then create the owner account once:

Railway → service → **⋯ → Run command** (or the CLI):

```bash
npm run db:seed
```

That creates the `OWNER` user from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, the two
plans and a starter announcement. Log in at `/admin/`.

If your Railway plan hides the shell, run the seed locally against the public
database URL instead:

```bash
DATABASE_URL="<Railway Postgres public URL>" \
ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='...' npm run db:seed
```

## 5. Stripe

1. Dashboard → Products → create "Autopilot VIP", recurring monthly, $19.
2. Copy the **price ID** (`price_...`) into `STRIPE_PRICE_VIP_MONTHLY`, redeploy,
   then run the seed again (or edit the plan in `/admin/ → Plans`).
3. Developers → Webhooks → Add endpoint:
   `https://your-service.up.railway.app/api/webhooks/stripe`
   Events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`.
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.
5. Test with card `4242 4242 4242 4242` in test mode first.

## 6. M-Pesa (IntaSend)

1. Create an IntaSend account, take the publishable + secret keys.
2. Set `INTASEND_PUBLISHABLE_KEY`, `INTASEND_SECRET_KEY`, and a
   `INTASEND_WEBHOOK_CHALLENGE` string of your choosing.
3. Webhook URL: `https://your-service.up.railway.app/api/webhooks/intasend`
   — put the same challenge string in the dashboard.
4. Keep `INTASEND_SANDBOX=true` until a real KES 10 test payment succeeds.
5. The M-Pesa button only appears for plans priced in **KES**; edit or add one in
   `/admin/ → Plans` (the seed ships `vip-monthly-kes` at KES 2,500).

Validate the sandbox flow before announcing it — provider behaviour around
`api_ref` echo and webhook field names is the usual source of "paid but not
upgraded" reports. Payment rows are keyed by provider reference, so a missed
webhook can be reconciled by checking the IntaSend dashboard and granting the
plan manually from `/admin/ → Users → Manage`.

## 7. Live prices

Create a free Twelve Data account, add `TWELVE_DATA_API_KEY`. The site then shows
real quotes with a 60-second cache, and falls back to the last cached value
(marked `cached`) if the provider hiccups. Without a key the UI says
"not configured" instead of inventing numbers.

## 8. Checks after deploying

```bash
curl https://your-service.up.railway.app/health   # {"status":"ok"}
curl https://your-service.up.railway.app/ready    # {"status":"ready","database":"up"}
```

Then, in the browser: register an account, verify the email arrives, open
`/admin/`, publish a signal, grant yourself VIP, and confirm the signal unlocks
on the public site.

## Free-trial notes

- The trial credit is small; a Node service plus Postgres is about the cheapest
  shape Railway supports. Delete unused services, and keep logs short.
- If the service sleeps or the credit runs out, the site 502s until you restart
  it. `/ready` distinguishes "app down" from "database down".
- No custom domain needed to launch; add it later under Settings → Networking.
- Uploaded cover images are URLs, not file uploads — no volume required. If you
  later want uploads, add an S3-compatible bucket rather than a Railway volume.

## 9. GitHub Pages

The repository also publishes `docs/` to
`https://autopipsmarkets.github.io/Autopilot-forex/` (Settings → Pages →
Source: *Deploy from a branch* → `main` / `/docs`).

That build is the **marketing site only**. Pages cannot run the API, so on that
domain the banner says "Preview build": browsing, research and the risk
disclosure work, while sign-in, checkout and live prices need the Railway URL.
Once Railway is live, treat the Pages URL as the brochure and link the app domain
from the nav, or add a redirect in `docs/index.html`.

Why `docs/`: Pages can only publish from the repository root or `/docs`, and the
API must not expose `src/` or `prisma/` as static files.
