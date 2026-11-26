# Deploying Foretell

Recommended target: **Vercel + Neon + a custom domain**.

Foretell is a stateless Next.js app with one recurring job. There is no worker,
queue, WebSocket server, or background process to keep alive.

## What has to run

| Component | Where | Notes |
| --- | --- | --- |
| Pages and API routes | Vercel Functions | Serverless; no server to manage |
| PostgreSQL | Neon | Existing managed database |
| Close-expired cron | Vercel Cron + GitHub Actions | Closes expired markets and releases escrow |
| Email | Resend, on request | Optional; without a key emails log server-side |

The cron **only closes markets**. An admin still resolves or voids them.

## Pre-flight (already in the repo)

- `postinstall` and `build` run `prisma generate`; the generated client is gitignored.
- Long-running order, cancellation, admin settlement, and cron routes export
  `maxDuration = 60`.
- `vercel.json` has a daily cron fallback.
- `.github/workflows/close-expired.yml` calls the cron every five minutes.
- `prisma/seed.ts` accepts `SEED_ADMIN_PASSWORD` for a production admin password.

## 1. Push the repository

```bash
git add -A
git status
git commit -m "chore: prepare the app for deployment"
git push origin main
```

## 2. Create a fresh production database

Do **not** deploy the current development database. It contains load-test,
QA, e2e, and legacy markets and users. Create a new Neon branch or database.

```bash
# Use the production connection strings from Neon.
export DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require"
export DIRECT_DATABASE_URL="postgresql://...direct.../neondb?sslmode=require"

bunx prisma db push --config prisma7.config.ts
SEED_ADMIN_PASSWORD='use-a-long-random-admin-password' bun run db:seed
```

Do **not** run `db:seed:load` against production. It creates 120 load markets
and thousands of test trades, which is useful locally but not for a demo.

The seed creates six accounts and five AI markets. Trader accounts keep the
local demo password; only the admin password is overridden by
`SEED_ADMIN_PASSWORD`.

## 3. Import the project into Vercel

1. **Add New → Project**, import the GitHub repository.
2. Framework preset: **Next.js**.
3. Install command: `bun install` if Vercel does not detect `bun.lock` automatically.
4. Build command: `bun run build` (runs Prisma generation and `next build`).
5. Node.js version: 22.x or newer.
6. Region: choose a US East region close to the Neon database.

### Environment variables

Set these for **Production**:

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Neon pooled connection string |
| `DIRECT_DATABASE_URL` | Yes | Neon direct connection string |
| `AUTH_SECRET` | Yes | `openssl rand -base64 32` |
| `CRON_SECRET` | Yes | `openssl rand -base64 32` |
| `NEXT_PUBLIC_APP_URL` | Yes | `https://your-domain` |
| `RESEND_API_KEY` | No | Enables real password-reset email |
| `EMAIL_FROM` | No | Verified sender |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | No | Google sign-in |
| `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED` | No | `true` to show Google sign-in |

Avoid pointing **Preview** deployments at the production database unless you
want previews writing to it. Use a separate Neon branch or skip preview env vars.

## 4. Configure the cron

The cron closes `OPEN` markets whose `closesAt` has passed, cancels their
resting orders, and releases escrow. It is idempotent.

### Daily Vercel fallback

`vercel.json` runs the cron once per day. Vercel sends
`Authorization: Bearer $CRON_SECRET` automatically when that env var exists.

### Five-minute scheduler on Hobby

Vercel Hobby does not support a five-minute cron. The GitHub Actions workflow
calls the endpoint every five minutes.

In GitHub, open **Settings → Secrets and variables → Actions**:

- Repository **variable** `APP_URL` = `https://your-domain` (no trailing slash).
- Repository **secret** `CRON_SECRET` = the same value set in Vercel.

Run the workflow manually once from the Actions tab to verify it.

GitHub may delay scheduled runs, and scheduled workflows in public repositories
can be disabled after long periods of inactivity. An external scheduler such as
cron-job.org can call the same endpoint with the same bearer header.

If you upgrade to **Vercel Pro**, change `vercel.json` to:

```json
"schedule": "*/5 * * * *"
```

and disable the GitHub workflow.

### Manual test

```bash
curl -i \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://your-domain/api/cron/close-expired
```

A `401` means the secret is missing or mismatched. A `200` with a `closed`
count means the route ran.

## 5. Attach a custom domain

The `*.vercel.app` subdomain works, but a custom domain is inexpensive and
better for a portfolio. Buy a domain from any registrar (`.app`, `.dev`, or
`.xyz` are usually cheap), add it in **Vercel → Settings → Domains**, and point
the DNS records Vercel shows. SSL is automatic.

After the domain is live:

1. Set `NEXT_PUBLIC_APP_URL` to the final URL and redeploy.
2. If Google auth is enabled, add
   `https://your-domain/api/auth/callback/google` to the Google OAuth client.

## 6. Smoke test production

- [ ] Landing page and market board load.
- [ ] Register or sign in as a trader.
- [ ] Open a market, place a limit order, cancel it.
- [ ] Place a market order and check the portfolio and ledger.
- [ ] Open the market book and chart.
- [ ] Check the leaderboard, notifications, and watchlist.
- [ ] Sign in as admin with the production password and load `/admin`.
- [ ] Trigger the cron manually and confirm `200`.
- [ ] Request a password reset (if Resend is configured).

## 7. Before making it public

- **Never publish the admin password.** Local development uses
  `admin@example.com` / `password123`; production must use
  `SEED_ADMIN_PASSWORD`. Do not put the production admin credentials in the
  README or repository.
- Confirm the production database is the fresh demo database, not the load-test
  database.
- Upgrade Next.js if the security advisory still applies.
- Remember that rate limiting is in-memory and per serverless instance. It is
  fine for a virtual-credit demo, not a hard security boundary.
- Keep Neon backups or a branch per environment.
- Admin market resolution remains manual; the cron only closes markets.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Build fails: cannot find `app/generated/prisma` | Prisma generation did not run; check `postinstall` and build command |
| Order requests time out | Function is far from Neon; use a US East region and check `maxDuration` |
| Cron returns 401 | `CRON_SECRET` missing or different between Vercel and GitHub |
| Reset emails do not arrive | `RESEND_API_KEY`/`EMAIL_FROM` missing or sender domain unverified |
| Login redirects or cookies fail | `AUTH_SECRET` or `NEXT_PUBLIC_APP_URL` missing |
| Markets stay `OPEN` after closing time | Cron not configured; close them manually in the admin console |

## Cost outline

- Vercel Hobby: free for a personal, non-commercial demo.
- Neon: free tier is enough for this demo; branches are available.
- GitHub Actions scheduler: free for public repositories.
- Domain: roughly $10–15 per year.
- Resend: optional; free tier is enough for password reset email.
