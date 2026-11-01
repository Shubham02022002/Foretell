# Foretell

**A full-stack prediction market exchange where the crowd sets the price.**

Foretell is a Kalshi-style forecasting platform built around pooled, pari-mutuel markets. Instead of an order book or a market maker, every market collects YES and NO stakes into two pools; the ratio between them becomes the implied probability, and when the question resolves the winning side splits the entire pool pro rata. Users start with 1,000 virtual credits, take positions on real-world questions, watch their payout odds move as others trade, sell out while a market is open, and compete on a public P&L leaderboard.

The product is deliberately editorial: a paper-and-ink palette, hairline rules, mono micro-labels, and a type system built around Bricolage Grotesque, Public Sans, and IBM Plex Mono. The goal is a forecasting terminal that reads like a financial publication rather than a casino.

> Virtual credits only. Foretell does not handle real money.

---

## Why it is different

- **Pari-mutuel, not order-book.** Prices are derived from the pools, so a position's potential payout updates the moment someone takes the other side. There is no spread, no liquidity provider, and no maker/taker distinction.
- **Provably conserved money.** Every credit movement is written to an append-only ledger. Settlement math is extracted into a pure module and covered by unit tests that assert `totalPayout + dust === totalPool` in every scenario.
- **Editorial-grade UI.** No dashboard templates. The interface is designed around market questions, probability, and money — with square corners, tabular numerals, and a single accent color.

---

## Feature set

### Markets and trading

- Pooled YES/NO markets with live implied probability, total pool, and side breakdowns.
- Fixed-odds style preview: enter an amount and see the payout and multiplier before placing.
- Positions are placed in a single transaction that debits the wallet, writes a `BET_STAKE` ledger entry, records an audit event, and enforces an idempotency key so retries cannot double-charge.
- Betting is rejected once a market closes or its `closesAt` timestamp passes.
- Sell an open position back to the pool at cost, crediting the wallet with a `POSITION_SALE` entry. Sales take a row lock on the market so a concurrent close cannot race the payout.
- Market pages include a probability history chart, resolution rules, and a discussion thread.

### Portfolio and ledger

- Live balance, realized P&L, total at stake, and potential payout across all open positions.
- Full position list with side, stake, potential return, and market status.
- Credit history with human-readable ledger labels (`Bet stake`, `Payout`, `Refund`, `Position sale`, `Adjustment`).
- Selling a position refreshes the portfolio, the ledger, and the navbar balance without a page reload.

### Discovery and social

- Market browser with search, category and status filters, and sorting by closing time, volume, or recent movement.
- Watchlist with one-click tracking, a dedicated page, and optimistic removal.
- Public trader profiles with standing, volume, win count, and recent activity.
- Leaderboard ranked by net P&L across all-time, 30-day, and 7-day windows. Sold positions net to zero so volume is never counted as profit.
- Per-market comment threads with author avatars and relative timestamps.
- In-app notification inbox that receives settlement and void notices; unread count surfaces in the navbar bell.

### Administration

- Admin console for creating draft markets, opening and closing them, resolving with an outcome plus evidence and notes, and voiding markets with full refunds.
- Market creation form with slug generation, closing-time validation, category, description, and resolution rules.
- Every administrative action writes an `AuditEvent`; resolving or voiding a market also notifies every trader holding a position.
- Expired markets are closed automatically by a secured cron endpoint.

### Accounts and security

- Email/password authentication with bcrypt hashing, optional Google OAuth.
- Password reset via single-use, SHA-256-hashed tokens that expire after one hour.
- Generic forgot-password responses so account existence cannot be enumerated.
- In-memory sliding-window rate limits on registration, login, betting, selling, comments, and password recovery.
- Timing-safe comparison for the cron bearer token.

---

## How settlement works

Each market has two pools built from `Bet` rows. For a market with:

| Trader | Side | Stake |
| ------ | ---- | ----- |
| Alice  | YES  | 60    |
| Bob    | YES  | 40    |
| Charlie| NO   | 100   |

the total pool is 200 and the YES pool is 100, so YES trades at an implied 50 percent. If the market resolves YES, each winning stake receives:

```
payout = floor(stake * totalPool / winningPool)
```

Alice receives `floor(60 * 200 / 100) = 120`, Bob receives `80`, and the losing 100 credits fund the upside. Integer flooring can leave at most one credit of dust per winning bet; dust is tracked explicitly rather than silently minted. If a market resolves with no winning bets, every stake is refunded instead. Voiding always refunds every stake in full.

Selling while a market is open returns the original stake rather than a mark-to-market value. This keeps the pool solvent and avoids creating credits that do not exist in the total pool.

The math lives in [`lib/settlement.ts`](lib/settlement.ts) and is exercised by [`lib/settlement.test.ts`](lib/settlement.test.ts), including pro-rata payouts, rounding dust, no-winner markets, multiple bets from one user, refunds, and conservation across outcomes.

---

## Tech stack

| Layer | Choice |
| ----- | ------ |
| Framework | Next.js 16 (App Router, Turbopack, Cache Components) |
| UI | React 19, Tailwind CSS 4 with custom design tokens |
| Data | PostgreSQL (Neon) + Prisma 7 with the Neon serverless adapter |
| Auth | Auth.js v5 (JWT sessions, credentials + optional Google) |
| Validation | Zod |
| Email | Resend HTTP API, with a console fallback in development |
| Runtime | Bun 1.4 / Node 20+ |
| Hosting | Vercel, with a cron-triggered maintenance route |

---

## Project structure

```
app/
  api/                 route handlers for auth, markets, bets, wallet,
                       watchlist, comments, notifications, leaderboard,
                       traders, admin, and cron
  admin/               settlement console and market management
  markets/             market browser and market detail pages
  portfolio/           positions, balance, and credit history
  leaderboard/         ranked trader standings
  watchlist/           tracked markets
  notifications/       settlement inbox
  traders/[id]/        public trader profiles
  login/               sign in
  register/            account creation
  forgot-password/     request a reset link
  reset-password/      choose a new password
  page.tsx             editorial landing page
components/            shared UI: navbar, auth shell, market UI, charts
lib/                   prisma client, settlement math, auth helpers,
                       email, rate limiting, formatting, validations
prisma/
  schema.prisma        data model
  seed.ts              demo users, markets, bets
auth.ts                Auth.js configuration
vercel.json            cron schedule for closing expired markets
```

The generated Prisma client is committed under `app/generated/prisma`.

---

## Data model

- `User` — account, role (`USER` / `ADMIN`), optional password hash.
- `Wallet` — one credit balance per user.
- `Market` — question, rules, category, status (`DRAFT`, `OPEN`, `CLOSED`, `RESOLVED`, `VOID`), closing time.
- `Bet` — a user's stake on an outcome, with a per-user idempotency key.
- `LedgerEntry` — append-only credit movements (`INITIAL_CREDIT`, `BET_STAKE`, `BET_PAYOUT`, `REFUND`, `POSITION_SALE`, `ADMIN_ADJUSTMENT`).
- `MarketResolution` — resolving admin, outcome, evidence URL, and notes.
- `Watchlist`, `Comment`, `Notification`, `AuditEvent`.
- `PasswordResetToken` — hashed, single-use reset tokens.
- Auth.js models: `Account`, `Session`, `VerificationToken`.

---

## Pages

| Route | Purpose |
| ----- | ------- |
| `/` | Landing page with live markets and product framing |
| `/markets` | Browse, filter, and sort markets |
| `/markets/[slug]` | Trade, inspect pools, read rules, discuss |
| `/portfolio` | Balance, positions, sell flow, credit history |
| `/leaderboard` | Trader rankings by window |
| `/watchlist` | Tracked markets |
| `/notifications` | Settlement and account inbox |
| `/traders/[id]` | Public trader profile |
| `/admin` | Market creation and settlement console |
| `/login`, `/register` | Authentication |
| `/forgot-password`, `/reset-password` | Account recovery |

---

## API surface

### Auth

```text
POST /api/auth/register
GET|POST /api/auth/[...nextauth]
POST /api/auth/forgot-password
POST /api/auth/reset-password
```

### Markets

```text
GET  /api/markets
GET  /api/markets/[slug]
GET  /api/markets/[slug]/history
GET  /api/markets/[slug]/comments
POST /api/markets/[slug]/comments
POST /api/markets/[slug]/bets
```

### Portfolio

```text
GET  /api/wallet
GET  /api/wallet/ledger
GET  /api/bets/me
POST /api/bets/[id]/sell
```

### Social

```text
POST   /api/watchlist/[slug]
DELETE /api/watchlist/[slug]
GET    /api/markets?watching=true
GET    /api/notifications
POST   /api/notifications/read
GET    /api/leaderboard
GET    /api/traders/[id]
```

### Admin and operations

```text
GET|POST      /api/admin/markets
POST          /api/admin/markets/[slug]/open
POST          /api/admin/markets/[slug]/close
POST          /api/admin/markets/[slug]/resolve
POST          /api/admin/markets/[slug]/void
GET           /api/cron/close-expired
```

The cron route requires `Authorization: Bearer $CRON_SECRET` and closes every `OPEN` market whose `closesAt` has passed. It is idempotent.

---

## Getting started

### Prerequisites

- Bun 1.4 or newer (or Node 20+ with npm)
- A PostgreSQL database. The project is developed against Neon, but any Postgres instance works.

### Install

```bash
bun install
```

### Environment

Create a `.env` file in the project root:

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `DATABASE_URL` | Yes | Pooled Postgres connection string |
| `DIRECT_DATABASE_URL` | Recommended | Direct connection used by Prisma CLI |
| `AUTH_SECRET` | Yes | Auth.js signing secret (`openssl rand -base64 32`) |
| `CRON_SECRET` | Production | Bearer token for the close-expired cron route |
| `RESEND_API_KEY` | No | Enables real email delivery; without it, reset emails log to the console |
| `EMAIL_FROM` | No | Verified sender, defaults to `Foretell <onboarding@resend.dev>` |
| `NEXT_PUBLIC_APP_URL` | No | Canonical origin used in reset links |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | No | Enable Google sign-in |
| `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED` | No | Set to `true` to show the Google button |

### Database

```bash
bunx prisma db push --config prisma7.config.ts
bunx prisma generate --config prisma7.config.ts
bun run db:seed
```

The seed creates four accounts, sample AI markets, and seeded positions.

| Email | Role | Password |
| ----- | ---- | -------- |
| `admin@example.com` | Admin | `password123` |
| `alice@example.com` | Trader | `password123` |
| `bob@example.com` | Trader | `password123` |
| `charlie@example.com` | Trader | `password123` |

### Run

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

For a production check:

```bash
bun run build
bun run start
```

---

## Testing

```bash
bun test
```

The suite covers the pure settlement engine: pro-rata payouts, integer dust, no-winner markets, multiple positions per user, refunds, and conservation of credits. Money math is kept separate from route handlers specifically so it can be tested without a database.

`bunx tsc --noEmit` and `bun run build` are the correctness gates for application code.

---

## Deployment notes

- Deploy to Vercel and point `DATABASE_URL` at a pooled Neon connection.
- `vercel.json` schedules `/api/cron/close-expired` every five minutes. Five-minute cron frequency requires a Vercel Pro plan; on Hobby, point an external scheduler at the same route instead.
- Set `CRON_SECRET` in the deployment environment and send it as a bearer token.
- Set `RESEND_API_KEY` and verify a sender domain to deliver password reset emails. Without a key the app still works; messages are written to the server log.
- Set `NEXT_PUBLIC_APP_URL` to the deployed origin so reset links point at production.

---

## Design system

| Token | Value | Use |
| ----- | ----- | --- |
| `paper` | `#eef1ea` | Page background |
| `surface` | `#f7f8f2` | Cards and panels |
| `ink` | `#101713` | Primary text and buttons |
| `muted` | `#5b665f` | Secondary text |
| `line` / `line-strong` | `#d5dccf` / `#b6bfb0` | Hairline rules and borders |
| `accent` | `#1f47ff` | Links and focus |
| `yes` / `no` | `#0a7a50` / `#b23a30` | Market sides |

Typography: Bricolage Grotesque for display, Public Sans for body copy, IBM Plex Mono for labels and financial figures. Corners are square, borders are one pixel, and uppercase mono labels carry the editorial structure.

---

## Roadmap

- Email settlement digest, reusing the existing Resend sender.
- Multi-outcome markets (more than YES/NO), which requires generalizing pools and settlement beyond two sides.
- Market search and richer category navigation.
- Public API keys and webhooks.

---

## Disclaimer

Foretell is a simulation. Credits are virtual, have no cash value, and cannot be exchanged for money. The project is not affiliated with Kalshi or any real-money exchange.
