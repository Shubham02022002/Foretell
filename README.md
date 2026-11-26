# Foretell

**A full-stack prediction market exchange with a real order book.**

Foretell is a Kalshi-style forecasting platform built around a binary limit-order book. Every market trades two complementary shares — YES and NO — and each winning share settles at 100 virtual credits. Users post limit orders, take the best available price, hold positions, cancel resting orders, and compete on a public P&L leaderboard. The book is price-time prioritized, orders escrow credits or shares, and every fill is written to an append-only ledger.

The product is deliberately editorial: a paper-and-ink palette, hairline rules, mono micro-labels, and a type system built around Bricolage Grotesque, Public Sans, and IBM Plex Mono. The goal is a forecasting terminal that reads like a financial publication rather than a casino.

> Virtual credits only. Foretell does not handle real money.

---

## Why it is different

- **A real order book, not a pool.** Limit orders rest at a price between 1¢ and 99¢. Price-time priority decides who fills first, makers set the print, and takers get any price improvement. There is a visible spread, a candlestick chart, and a live tape.
- **Binary-specific matching.** BUY YES and SELL NO are two ways to be long YES; SELL YES and BUY NO are two ways to be short. Normalising every order to a YES price lets one book match all four combinations — including minting a fresh YES/NO pair and merging an existing one.
- **Escrowed, conserved money.** Buy orders reserve credits; sell orders reserve shares. Cancellations and expiries release both. Every matched pair is backed by exactly 100 credits, so winning payouts equal the collateral held at settlement.
- **Editorial-grade UI.** No dashboard templates. The interface is designed around market questions, probability, and money — with square corners, tabular numerals, and a single accent color.

---

## Feature set

### Markets and trading

- Binary YES/NO markets with a live order book, best bid/ask, spread, last price, 24h volume, open interest, and a recent-trades tape.
- Limit and market orders, buy and sell, with partial fills, price-time priority, and price improvement for takers.
- Self-trade prevention: a remainder that would cross the trader's own resting order is cancelled and its escrow released instead of resting a crossed book.
- Buy orders reserve credits and sell orders reserve shares in the same transaction that matches the fill.
- Robinhood/Groww-style price charts: a smooth green/red area line by default, a candlestick toggle, 1H / 1D / 1W / 1M / ALL ranges, a right-side price axis, crosshair price tags, and an accessible data table.
- Market pages poll the book, tape, chart, wallet, positions, and open orders while the tab is visible.
- The seeded demo includes resting depth and backdated trades on every open market, so charts and books are alive immediately.

### Portfolio and ledger

- Available balance, reserved credits, position value, unrealized P&L, and realized P&L.
- Positions with YES and NO shares, average entry, mark price, market value, and per-position realized P&L.
- Open limit orders with filled/remaining quantity and one-click cancellation.
- Credit history with human-readable ledger labels (`Bought shares`, `Sold shares`, `Settlement payout`, `Refund`, `Adjustment`).

### Discovery and social

- Market browser with search, category and status filters, and sorting by closing time, volume, or recent movement.
- Watchlist with one-click tracking, a dedicated page, and optimistic removal.
- Public trader profiles with standing, traded volume, win count, and recent positions.
- Leaderboard ranked by net cash flow across all-time, 30-day, and 7-day windows.
- Per-market comment threads with author avatars and relative timestamps.
- In-app notification inbox that receives settlement and void notices; unread count surfaces in the navbar bell.

### Administration

- Admin console for creating draft markets, opening and closing them, resolving with an outcome plus evidence and notes, and voiding markets.
- Closing a market cancels every resting order and releases its escrow. Resolving pays 100 credits per winning share. Voiding unwinds positions at the last traded price.
- Every administrative action writes an `AuditEvent`; resolving or voiding a market also notifies every position holder and watcher.
- Expired markets are closed automatically by a secured cron endpoint, which also cancels resting orders.

### Accounts and security

- Email/password authentication with bcrypt hashing, optional Google OAuth.
- Password reset via single-use, SHA-256-hashed tokens that expire after one hour.
- Generic forgot-password responses so account existence cannot be enumerated.
- In-memory sliding-window rate limits on registration, login, orders, cancellations, comments, and password recovery.
- Timing-safe comparison for the cron bearer token.

---

## How the order book works

Binary shares are claims on 100 credits. A YES share and a NO share form a pair worth exactly 100; the exchange mints pairs from two buyers and merges them from two sellers. Every order is normalised to a **YES price**:

| Order | Economic position | YES price |
| ----- | ----------------- | --------- |
| BUY YES at 62¢ | long YES | 62 |
| SELL NO at 38¢ | long YES | 100 − 38 = 62 |
| SELL YES at 62¢ | short YES | 62 |
| BUY NO at 38¢ | short YES | 100 − 38 = 62 |

A long order matches a short order when the long limit is at or above the short limit. The resting order is the maker, so the trade prints at the maker's YES price and the taker gets any improvement. The four valid pairs are:

- BUY YES ↔ SELL YES — transfer a YES share.
- BUY NO ↔ SELL NO — transfer a NO share.
- BUY YES ↔ BUY NO — mint a fresh YES/NO pair.
- SELL YES ↔ SELL NO — merge a pair and release 100 credits.

### Escrow

- A BUY limit order reserves `price × quantity` credits. `Wallet.balance` is the total; `Wallet.reserved` is locked in orders; available balance is the difference.
- A SELL order reserves shares on the position (`yesReserved` / `noReserved`).
- Each fill consumes the reservation at the order's limit price. Price improvement returns the difference to available balance.
- Cancellation, expiry, market close, resolution, and self-trade prevention release whatever remains locked.

### Settlement

At resolution, every winning share pays **100 credits**; losing shares expire at zero. Matched pairs always hold exactly 100 credits, so the collateral pool exactly covers the winning side.

Voiding is conserved too: outstanding shares are unwound at the last traded YES price `p`, paying YES holders `p` and NO holders `100 − p` per share. If no trade ever printed, the fallback is 50/50.

Positions are marked to the latest trade for portfolio value and unrealized P&L. Realized P&L is updated on every sell (proceeds minus proportional cost basis) and at settlement.

The pure matching and book math lives in [`lib/exchange/matching.ts`](lib/exchange/matching.ts); the transactional order engine is [`lib/exchange/orders.ts`](lib/exchange/orders.ts); lifecycle and candles are [`lib/exchange/market.ts`](lib/exchange/market.ts).

---

## Tech stack

| Layer | Choice |
| ----- | ------ |
| Framework | Next.js 16 (App Router, Turbopack, Cache Components) |
| UI | React 19, Tailwind CSS 4 with custom design tokens |
| Charts | Hand-rolled SVG — no charting dependency |
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
  api/                 route handlers for auth, markets, orders, book,
                       candles, positions, wallet, watchlist, comments,
                       notifications, leaderboard, traders, admin, cron
  admin/               settlement console and market management
  markets/             market browser and market detail pages
  portfolio/           positions, open orders, balance, credit history
  leaderboard/         ranked trader standings
  watchlist/           tracked markets
  notifications/       settlement inbox
  traders/[id]/        public trader profiles
  login/               sign in
  register/            account creation
  forgot-password/     request a reset link
  reset-password/      choose a new password
  page.tsx             editorial landing page
components/            navbar, order book, price chart, market UI, auth shell
lib/
  exchange/            matching engine, order placement, book stats,
                       candles, portfolio views, settlement lifecycle
  validations/         Zod schemas
  ...                  prisma client, auth helpers, email, rate limiting
prisma/
  schema.prisma        data model
  seed.ts              demo users, markets, liquidity, backdated trades
auth.ts                Auth.js configuration
vercel.json            cron schedule for closing expired markets
```

The generated Prisma client is written to `app/generated/prisma` (and is gitignored; run `prisma generate` after cloning).

---

## Data model

- `User` — account, role (`USER` / `ADMIN`), optional password hash.
- `Wallet` — `balance` plus `reserved` credits locked in buy orders.
- `Market` — question, rules, category, status (`DRAFT`, `OPEN`, `CLOSED`, `RESOLVED`, `VOID`), closing time.
- `Order` — outcome, action (`BUY` / `SELL`), type (`LIMIT` / `MARKET`), price (1–99), quantity, filled quantity, status (`OPEN`, `PARTIAL`, `FILLED`, `CANCELLED`, `EXPIRED`), and a per-user idempotency key.
- `Trade` — an immutable fill tying a maker order and taker order together at a YES price and quantity.
- `Position` — per user and market: YES/NO shares, reserved shares, cost basis, and realized P&L.
- `LedgerEntry` — append-only cash movements (`INITIAL_CREDIT`, `TRADE_BUY`, `TRADE_SELL`, `SETTLEMENT_PAYOUT`, `REFUND`, `ADMIN_ADJUSTMENT`). Legacy pool-era enum values are retained only so pre-migration rows remain valid.
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
| `/markets/[slug]` | Order book, tape, candles, ticket, positions, rules, discussion |
| `/portfolio` | Balance, positions, open orders, credit history |
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

### Markets and trading

```text
GET  /api/markets
GET  /api/markets/[slug]
GET  /api/markets/[slug]/book
GET  /api/markets/[slug]/candles?range=1H|1D|1W|1M|ALL
GET  /api/markets/[slug]/orders
POST /api/markets/[slug]/orders
POST /api/orders/[id]/cancel
GET  /api/markets/[slug]/comments
POST /api/markets/[slug]/comments
```

Placing an order accepts:

```json
{
  "outcome": "YES",
  "action": "BUY",
  "type": "LIMIT",
  "price": 62,
  "quantity": 10,
  "idempotencyKey": "a-unique-client-key"
}
```

`price` is required for `LIMIT` orders and omitted for `MARKET` orders. The response includes the order, fills, balance, reserved credits, position, a `replayed` flag, and `selfCrossed`.

### Portfolio

```text
GET  /api/wallet
GET  /api/wallet/ledger
GET  /api/positions/me
GET  /api/positions/me?market=[slug]
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

The cron route requires `Authorization: Bearer $CRON_SECRET` and closes every `OPEN` market whose `closesAt` has passed, cancelling resting orders and releasing escrow. It is idempotent.

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

If you are upgrading a database that still uses the old pari-mutuel schema, `db push` is destructive: it drops `Bet` and rewrites the ledger enum. Use `--accept-data-loss` only on a development database.

The seed creates six accounts, five AI markets, a resting liquidity ladder on each open market, ten backdated trades per market, and one resolved fixture that exercises settlement. It is resumable: markets that already have orders or trades are skipped.

For a much larger load/visual-testing dataset:

```bash
bun run db:seed:load          # 120 markets, ~16k trades, all lifecycle states
bunx tsx prisma/seed-load.ts --reset   # wipe only the load- dataset and regenerate
```

The load dataset adds 61 `load-*` accounts, 120 markets (OPEN, CLOSED, RESOLVED, VOID, DRAFT), empty and one-sided books, deep and wide books, partial and cancelled/expired orders, resting sell orders, ~16k trades, positions, ledgers, settlements, comments, watchlists, notifications, and audit events. All generated rows are prefixed with `load-`; `--reset` only removes that data. Load accounts use the same password: `load-user-01@example.com` through `load-user-60@example.com`, plus `load-admin@example.com`.

| Email | Role | Password |
| ----- | ---- | -------- |
| `admin@example.com` | Admin | `password123` |
| `alice@example.com` | Trader | `password123` |
| `bob@example.com` | Trader | `password123` |
| `charlie@example.com` | Trader | `password123` |
| `dana@example.com` | Trader | `password123` |
| `erin@example.com` | Trader | `password123` |

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

The suite covers the pure matching engine: normalisation of all four order types, price-time priority, partial fills, minting and merging pairs, spend caps for market buys, book aggregation, and proportional cost-basis release. Money math and matching are kept free of Prisma so they can be tested without a database.

`bunx tsc --noEmit` and `bun run build` are the correctness gates for application code.

---

## Deployment notes

- Deploy to Vercel and point `DATABASE_URL` at a pooled Neon connection.
- `vercel.json` schedules `/api/cron/close-expired` every five minutes. Five-minute cron frequency requires a Vercel Pro plan; on Hobby, point an external scheduler at the same route instead.
- Set `CRON_SECRET` in the deployment environment and send it as a bearer token.
- Set `RESEND_API_KEY` and verify a sender domain to deliver password reset emails. Without a key the app still works; messages are written to the server log.
- Set `NEXT_PUBLIC_APP_URL` to the deployed origin so reset links point at production.
- The market page polls REST endpoints every five seconds. If you move to WebSockets or SSE, replace the polling effects in `app/markets/[slug]/page.tsx`.

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
| `yes` / `no` | `#0a7a50` / `#b23a30` | Market sides, book bids/asks, candle direction |

Typography: Bricolage Grotesque for display, Public Sans for body copy, IBM Plex Mono for labels and financial figures. Corners are square, borders are one pixel, and uppercase mono labels carry the editorial structure.

---

## Roadmap

- Server-sent events or WebSockets for sub-second book updates.
- Market-maker tooling and admin-configurable opening liquidity for new listings.
- Order history export and per-market trade blotter.
- Multi-outcome markets (more than YES/NO), which requires generalizing the share model and matching engine beyond pairs.
- Public API keys and webhooks.

---

## Disclaimer

Foretell is a simulation. Credits are virtual, have no cash value, and cannot be exchanged for money. The project is not affiliated with Kalshi or any real-money exchange.
