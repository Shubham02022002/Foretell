import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../app/generated/prisma/client";
import prisma from "../lib/prisma";

/**
 * Large synthetic dataset for load/visual testing.
 *
 * This deliberately does NOT go through the matching engine. At this scale,
 * thousands of interactive transactions against a remote Neon database would
 * take hours. Instead it generates a consistent snapshot in memory and bulk
 * inserts it:
 *
 * - 120 markets across every lifecycle state and market shape
 * - ~16k trades, with matching filled maker/taker orders
 * - positions, cost basis, realized P&L, wallet balances and reservations
 * - resting bids/asks, partial orders, sell orders, cancelled/expired orders
 * - settlement payouts, void refunds, ledgers, comments, watchlists,
 *   notifications, resolutions and audit events
 *
 * Run:
 *   npx tsx prisma/seed-load.ts
 *   npx tsx prisma/seed-load.ts --reset
 */

const PREFIX = "load-";
const PASSWORD = "password123";
const START_BALANCE = 10_000_000;
const TRADER_COUNT = 60;
const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;

const MIN_PRICE = 1;
const MAX_PRICE = 99;

type Status = "DRAFT" | "OPEN" | "CLOSED" | "RESOLVED" | "VOID";
type Outcome = "YES" | "NO";
type Action = "BUY" | "SELL";
type OrderType = "LIMIT" | "MARKET";
type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED" | "EXPIRED";
type LedgerType =
  | "INITIAL_CREDIT"
  | "TRADE_BUY"
  | "TRADE_SELL"
  | "SETTLEMENT_PAYOUT"
  | "REFUND"
  | "ADMIN_ADJUSTMENT";
type Scenario =
  | "empty"
  | "normal"
  | "many"
  | "bidsOnly"
  | "asksOnly"
  | "extreme"
  | "wide"
  | "deep"
  | "sells";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: "USER" | "ADMIN";
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
};

type WalletRow = {
  id: string;
  userId: string;
  balance: number;
  reserved: number;
  updatedAt: Date;
};

type MarketRow = {
  id: string;
  slug: string;
  question: string;
  description: string;
  rules: string;
  category: string;
  status: Status;
  closesAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type OrderRow = {
  id: string;
  userId: string;
  marketId: string;
  outcome: Outcome;
  action: Action;
  type: OrderType;
  price: number;
  quantity: number;
  filledQuantity: number;
  status: OrderStatus;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

type TradeRow = {
  id: string;
  marketId: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  yesPrice: number;
  quantity: number;
  createdAt: Date;
};

type PositionRow = {
  id: string;
  userId: string;
  marketId: string;
  yesShares: number;
  noShares: number;
  yesReserved: number;
  noReserved: number;
  yesCost: number;
  noCost: number;
  realized: number;
  createdAt: Date;
  updatedAt: Date;
};

type LedgerRow = {
  id: string;
  userId: string;
  marketId: string | null;
  orderId: string | null;
  tradeId: string | null;
  amount: number;
  type: LedgerType;
  createdAt: Date;
};

type CommentRow = {
  id: string;
  userId: string;
  marketId: string;
  body: string;
  createdAt: Date;
};

type WatchlistRow = {
  id: string;
  userId: string;
  marketId: string;
  createdAt: Date;
};

type NotificationRow = {
  id: string;
  userId: string;
  marketId: string | null;
  type: string;
  title: string;
  body: string | null;
  readAt: Date | null;
  createdAt: Date;
};

type ResolutionRow = {
  id: string;
  marketId: string;
  outcome: Outcome;
  evidenceUrl: string | null;
  notes: string | null;
  resolvedBy: string;
  resolvedAt: Date;
};

type AuditRow = {
  id: string;
  userId: string;
  marketId: string | null;
  action: string;
  details: Prisma.InputJsonValue;
  createdAt: Date;
};

type MarketSpec = MarketRow & {
  scenario: Scenario;
  basePrice: number;
  tradeCount: number;
  resolutionOutcome?: Outcome;
  resolutionAt?: Date;
};

type PositionState = PositionRow & { touched: boolean };

const topics: { category: string; text: string }[] = [
  { category: "AI Models", text: "Anthropic ship a new flagship Claude model" },
  { category: "AI Models", text: "OpenAI release a model named GPT-6" },
  { category: "AI Models", text: "Google release Gemini 4" },
  { category: "AI Models", text: "Meta release Llama 5 under an open license" },
  { category: "AI Benchmarks", text: "a model score above 90% on GPQA" },
  { category: "AI Benchmarks", text: "a model pass 85% on SWE-bench Verified" },
  { category: "AI Benchmarks", text: "an agent pass 50% on ARC-AGI" },
  { category: "AI Benchmarks", text: "a coding agent top the public leaderboard" },
  { category: "Policy", text: "the EU pass its next AI Act amendment" },
  { category: "Policy", text: "the US pass federal AI licensing rules" },
  { category: "Policy", text: "a national AI safety institute be created" },
  { category: "Chips", text: "Nvidia ship its next Ultra accelerator" },
  { category: "Chips", text: "a 2nm inference chip enter mass production" },
  { category: "Chips", text: "a major cloud open a custom AI chip region" },
  { category: "Safety", text: "a frontier lab publish a new safety framework" },
  { category: "Safety", text: "a serious AI incident trigger a public recall" },
  { category: "Safety", text: "a model evaluation standard be adopted" },
  { category: "Open Source", text: "an open 1T-parameter model be released" },
  { category: "Open Source", text: "an open model enter the top five on a major leaderboard" },
  { category: "Funding", text: "an AI lab raise a round above $10B" },
  { category: "Funding", text: "an AI company price an IPO above $50B" },
  { category: "Product", text: "a consumer AI device ship to the public" },
  { category: "Product", text: "an AI agent app reach 100M monthly users" },
  { category: "Product", text: "a major browser ship an AI agent mode" },
];

const commentBodies = [
  "The market is pricing this too optimistically in my view.",
  "Good depth on both sides here — the spread looks fair.",
  "I took the other side. The resolution source is doing a lot of work.",
  "The last few prints suggest the crowd is converging.",
  "Watching this one closely; the close date matters.",
  "This is a clean test case for the book and the settlement path.",
  "The candles show a real trend, not just noise.",
  "I would like to see more liquidity near the midpoint.",
  "The rules are clear enough that this should resolve cleanly.",
  "Small size for now, but the payout asymmetry is interesting.",
];

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(0x5eed1234);
const int = (min: number, max: number) =>
  Math.floor(random() * (max - min + 1)) + min;
const chance = (probability: number) => random() < probability;

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)];
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }

  return copy;
}

function clampPrice(price: number) {
  return Math.min(MAX_PRICE, Math.max(MIN_PRICE, Math.round(price)));
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
}

function dateLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function positionKey(userId: string, marketId: string) {
  return `${userId}:${marketId}`;
}

async function resetLoadData() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const markets = await prisma.market.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true },
  });

  const userIds = users.map((user) => user.id);
  const marketIds = markets.map((market) => market.id);

  if (userIds.length === 0 && marketIds.length === 0) {
    console.log("No existing load-test data to reset.");
    return;
  }

  console.log(
    `Resetting ${userIds.length} load users and ${marketIds.length} load markets...`,
  );

  await prisma.notification.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { marketId: { in: marketIds } }],
    },
  });
  await prisma.watchlist.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { marketId: { in: marketIds } }],
    },
  });
  await prisma.comment.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { marketId: { in: marketIds } }],
    },
  });
  await prisma.trade.deleteMany({ where: { marketId: { in: marketIds } } });
  await prisma.order.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { marketId: { in: marketIds } }],
    },
  });
  await prisma.position.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { marketId: { in: marketIds } }],
    },
  });
  await prisma.ledgerEntry.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { marketId: { in: marketIds } }],
    },
  });
  await prisma.auditEvent.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { marketId: { in: marketIds } }],
    },
  });
  await prisma.marketResolution.deleteMany({
    where: { marketId: { in: marketIds } },
  });
  await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.market.deleteMany({ where: { id: { in: marketIds } } });

  console.log("Load-test data removed.");
}

function scenarioTradeCount(scenario: Scenario, status: Status) {
  if (status === "DRAFT" || scenario === "empty") {
    return 0;
  }

  switch (scenario) {
    case "many":
      return int(300, 500);
    case "deep":
      return int(100, 200);
    case "extreme":
      return int(60, 150);
    case "wide":
      return int(40, 100);
    case "sells":
      return int(80, 150);
    case "bidsOnly":
    case "asksOnly":
      return int(40, 120);
    default:
      return int(80, 200);
  }
}

function buildTradeTimes(spec: MarketSpec): number[] {
  const count = spec.tradeCount;

  if (count <= 0) {
    return [];
  }

  const closes = spec.closesAt.getTime();
  const end =
    spec.status === "OPEN"
      ? NOW - HOUR
      : Math.min(closes - HOUR, NOW - HOUR);
  const start = Math.max(
    spec.createdAt.getTime() + HOUR,
    end - 45 * DAY,
  );

  if (end <= start) {
    return Array.from({ length: count }, (_, index) =>
      start + index * 60_000,
    );
  }

  const recentCount =
    spec.status === "OPEN" ? Math.min(5, count) : 0;
  const olderCount = count - recentCount;
  const olderEnd =
    spec.status === "OPEN" ? Math.min(end, NOW - 2 * DAY) : end;
  const times: number[] = [];

  for (let index = 0; index < olderCount; index += 1) {
    const span = Math.max(1, olderEnd - start);
    const jitter = Math.floor(span / Math.max(olderCount, 1) / 5);
    const time =
      start + ((index + 1) / (olderCount + 1)) * span + int(-jitter, jitter);
    times.push(Math.min(olderEnd, Math.max(start, time)));
  }

  for (let index = 0; index < recentCount; index += 1) {
    const recentStart = Math.max(NOW - DAY, start);
    const time =
      recentStart + ((index + 1) / (recentCount + 1)) * (end - recentStart);
    times.push(Math.min(end, Math.max(recentStart, time)));
  }

  return times.sort((a, b) => a - b);
}

async function main() {
  const reset = process.argv.includes("--reset");

  if (reset) {
    await resetLoadData();
  } else {
    const existing = await prisma.user.count({
      where: { email: { startsWith: PREFIX } },
    });

    if (existing > 0) {
      console.error(
        "Load-test data already exists. Re-run with --reset to regenerate it.",
      );
      process.exitCode = 1;
      return;
    }
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const adminId = randomUUID();

  const admin: UserRow = {
    id: adminId,
    email: `${PREFIX}admin@example.com`,
    name: "Load Admin",
    role: "ADMIN",
    passwordHash,
    createdAt: new Date(NOW - 120 * DAY),
    updatedAt: new Date(NOW - 120 * DAY),
  };

  const traders: UserRow[] = Array.from(
    { length: TRADER_COUNT },
    (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      const createdAt = new Date(NOW - int(60, 120) * DAY);

      return {
        id: randomUUID(),
        email: `${PREFIX}user-${number}@example.com`,
        name: `Load Trader ${number}`,
        role: "USER" as const,
        passwordHash,
        createdAt,
        updatedAt: createdAt,
      };
    },
  );

  const userRows = [admin, ...traders];
  const wallets = new Map(
    userRows.map((user) => [
      user.id,
      { id: randomUUID(), userId: user.id, balance: START_BALANCE, reserved: 0 },
    ]),
  );
  const ledgerRows: LedgerRow[] = userRows.map((user) => ({
    id: randomUUID(),
    userId: user.id,
    marketId: null,
    orderId: null,
    tradeId: null,
    amount: START_BALANCE,
    type: "INITIAL_CREDIT",
    createdAt: user.createdAt,
  }));

  const openScenarios: Scenario[] = [];
  const addScenarios = (scenario: Scenario, count: number) => {
    for (let index = 0; index < count; index += 1) {
      openScenarios.push(scenario);
    }
  };
  addScenarios("empty", 5);
  addScenarios("bidsOnly", 8);
  addScenarios("asksOnly", 5);
  addScenarios("extreme", 10);
  addScenarios("wide", 8);
  addScenarios("deep", 14);
  addScenarios("sells", 10);
  addScenarios("many", 10);
  addScenarios("normal", 10);
  shuffle(openScenarios);

  const statusPlan: Status[] = shuffle([
    ...Array<Status>(80).fill("OPEN"),
    ...Array<Status>(12).fill("CLOSED"),
    ...Array<Status>(15).fill("RESOLVED"),
    ...Array<Status>(8).fill("VOID"),
    ...Array<Status>(5).fill("DRAFT"),
  ]);

  const marketSpecs: MarketSpec[] = [];
  let openIndex = 0;

  for (let index = 0; index < statusPlan.length; index += 1) {
    const status = statusPlan[index];
    const scenario: Scenario =
      status === "OPEN"
        ? openScenarios[openIndex++]
        : status === "DRAFT" || chance(0.1)
          ? "empty"
          : "normal";
    const topic = topics[index % topics.length];
    const isLive = status === "OPEN" || status === "DRAFT";
    const closesAt = isLive
      ? new Date(NOW + int(3, 120) * DAY + int(0, DAY))
      : new Date(NOW - int(2, 40) * DAY);
    const createdAt = isLive
      ? new Date(NOW - int(20, 70) * DAY - int(0, DAY))
      : new Date(closesAt.getTime() - int(20, 60) * DAY);
    const basePrice =
      scenario === "extreme"
        ? chance(0.5)
          ? int(3, 8)
          : int(92, 97)
        : int(20, 80);
    const resolutionAt =
      status === "RESOLVED" || status === "VOID"
        ? new Date(
            Math.min(
              NOW - HOUR,
              closesAt.getTime() + int(1, 48) * HOUR,
            ),
          )
        : undefined;
    const id = randomUUID();
    const slug = `${PREFIX}${slugify(topic.category)}-${String(index + 1).padStart(3, "0")}`;
    const question = `Will ${topic.text} before ${dateLabel(closesAt)}?`;
    const tradeCount = scenarioTradeCount(scenario, status);

    marketSpecs.push({
      id,
      slug,
      question,
      description: `Generated load-test market (${scenario}) for ${topic.category.toLowerCase()} coverage. It exists to exercise books, charts, settlement, and portfolio views at scale.`,
      rules:
        "Resolve YES if the stated condition is publicly reported before the closing date. Generated load data; no real settlement event.",
      category: topic.category,
      status,
      closesAt,
      createdAt,
      updatedAt: resolutionAt ?? createdAt,
      scenario,
      basePrice,
      tradeCount,
      resolutionOutcome:
        status === "RESOLVED" ? (chance(0.5) ? "YES" : "NO") : undefined,
      resolutionAt,
    });
  }

  const orders: OrderRow[] = [];
  const trades: TradeRow[] = [];
  const positions = new Map<string, PositionState>();
  const marketHolders = new Map<string, Set<string>>();
  const lastPriceByMarket = new Map<string, number>();
  const marketSettlement = new Map<
    string,
    { payout: number; holders: number }
  >();
  const commentRows: CommentRow[] = [];
  const watchlistRows: WatchlistRow[] = [];
  const notificationRows: NotificationRow[] = [];
  const resolutionRows: ResolutionRow[] = [];
  const auditRows: AuditRow[] = [];
  const watchersByMarket = new Map<string, Set<string>>();

  function holderSet(marketId: string) {
    let set = marketHolders.get(marketId);

    if (!set) {
      set = new Set();
      marketHolders.set(marketId, set);
    }

    return set;
  }

  function getPosition(userId: string, spec: MarketSpec) {
    const key = positionKey(userId, spec.id);
    let position = positions.get(key);

    if (!position) {
      position = {
        id: randomUUID(),
        userId,
        marketId: spec.id,
        yesShares: 0,
        noShares: 0,
        yesReserved: 0,
        noReserved: 0,
        yesCost: 0,
        noCost: 0,
        realized: 0,
        createdAt: spec.createdAt,
        updatedAt: spec.createdAt,
        touched: true,
      };
      positions.set(key, position);
    }

    position.touched = true;
    return position;
  }

  function adjustWallet(userId: string, delta: number) {
    const wallet = wallets.get(userId);

    if (!wallet) {
      throw new Error(`Missing wallet for ${userId}`);
    }

    wallet.balance += delta;
  }

  function addLedger(
    userId: string,
    spec: MarketSpec,
    amount: number,
    type: LedgerType,
    createdAt: Date,
    orderId: string | null = null,
    tradeId: string | null = null,
  ) {
    ledgerRows.push({
      id: randomUUID(),
      userId,
      marketId: spec.id,
      orderId,
      tradeId,
      amount,
      type,
      createdAt,
    });
  }

  function makeFilledOrder(
    spec: MarketSpec,
    userId: string,
    outcome: Outcome,
    action: Action,
    price: number,
    quantity: number,
    createdAt: Date,
  ): OrderRow {
    return {
      id: randomUUID(),
      userId,
      marketId: spec.id,
      outcome,
      action,
      type: chance(0.12) ? "MARKET" : "LIMIT",
      price: clampPrice(price),
      quantity,
      filledQuantity: quantity,
      status: "FILLED",
      idempotencyKey: `${PREFIX}${randomUUID()}`,
      createdAt,
      updatedAt: createdAt,
    };
  }

  function findHolder(
    userIds: string[],
    spec: MarketSpec,
    side: Outcome,
    quantity: number,
  ) {
    const candidates = userIds.filter((userId) => {
      const position = positions.get(positionKey(userId, spec.id));

      if (!position) {
        return false;
      }

      return (
        (side === "YES"
          ? position.yesShares - position.yesReserved
          : position.noShares - position.noReserved) >= quantity
      );
    });

    return candidates.length > 0 ? pick(candidates) : null;
  }

  function reduceShares(
    position: PositionState,
    side: Outcome,
    quantity: number,
    proceeds: number,
    at: Date,
  ) {
    const shares = side === "YES" ? position.yesShares : position.noShares;
    const cost = side === "YES" ? position.yesCost : position.noCost;

    if (shares < quantity) {
      throw new Error("Synthetic seller does not have enough shares");
    }

    const removed = Math.min(
      cost,
      Math.floor((cost * quantity) / Math.max(shares, 1)),
    );

    if (side === "YES") {
      position.yesShares -= quantity;
      position.yesCost -= removed;
    } else {
      position.noShares -= quantity;
      position.noCost -= removed;
    }

    position.realized += proceeds - removed;
    position.updatedAt = at;
  }

  function recordTrade(
    spec: MarketSpec,
    at: Date,
    yesPrice: number,
    quantity: number,
    kind: "mint" | "transfer" | "merge",
    marketUsers: UserRow[],
    firstUserId: string,
    secondUserId: string,
  ) {
    const price = clampPrice(yesPrice);
    let tradeId: string;
    let orderA: OrderRow;
    let orderB: OrderRow;

    if (kind === "mint") {
      const yesBuyer = firstUserId;
      const noBuyer = secondUserId;
      const yesCost = price * quantity;
      const noCost = (100 - price) * quantity;

      const yesPosition = getPosition(yesBuyer, spec);
      yesPosition.yesShares += quantity;
      yesPosition.yesCost += yesCost;
      yesPosition.updatedAt = at;

      const noPosition = getPosition(noBuyer, spec);
      noPosition.noShares += quantity;
      noPosition.noCost += noCost;
      noPosition.updatedAt = at;

      adjustWallet(yesBuyer, -yesCost);
      adjustWallet(noBuyer, -noCost);

      orderA = makeFilledOrder(spec, yesBuyer, "YES", "BUY", price, quantity, at);
      orderB = makeFilledOrder(
        spec,
        noBuyer,
        "NO",
        "BUY",
        100 - price,
        quantity,
        at,
      );

      tradeId = randomUUID();
      trades.push({
        id: tradeId,
        marketId: spec.id,
        makerOrderId: orderA.id,
        takerOrderId: orderB.id,
        makerUserId: yesBuyer,
        takerUserId: noBuyer,
        yesPrice: price,
        quantity,
        createdAt: at,
      });
      addLedger(yesBuyer, spec, -yesCost, "TRADE_BUY", at, orderA.id, tradeId);
      addLedger(noBuyer, spec, -noCost, "TRADE_BUY", at, orderB.id, tradeId);
    } else if (kind === "transfer") {
      const seller = firstUserId;
      const buyer = secondUserId;
      const sellerPosition = getPosition(seller, spec);
      const buyerPosition = getPosition(buyer, spec);
      const proceeds = price * quantity;

      reduceShares(sellerPosition, "YES", quantity, proceeds, at);
      buyerPosition.yesShares += quantity;
      buyerPosition.yesCost += proceeds;
      buyerPosition.updatedAt = at;

      adjustWallet(buyer, -proceeds);
      adjustWallet(seller, proceeds);

      orderA = makeFilledOrder(spec, buyer, "YES", "BUY", price, quantity, at);
      orderB = makeFilledOrder(spec, seller, "YES", "SELL", price, quantity, at);

      tradeId = randomUUID();
      trades.push({
        id: tradeId,
        marketId: spec.id,
        makerOrderId: orderA.id,
        takerOrderId: orderB.id,
        makerUserId: buyer,
        takerUserId: seller,
        yesPrice: price,
        quantity,
        createdAt: at,
      });
      addLedger(buyer, spec, -proceeds, "TRADE_BUY", at, orderA.id, tradeId);
      addLedger(seller, spec, proceeds, "TRADE_SELL", at, orderB.id, tradeId);
    } else {
      const yesSeller = firstUserId;
      const noSeller = secondUserId;
      const yesProceeds = price * quantity;
      const noProceeds = (100 - price) * quantity;
      const yesPosition = getPosition(yesSeller, spec);
      const noPosition = getPosition(noSeller, spec);

      reduceShares(yesPosition, "YES", quantity, yesProceeds, at);
      reduceShares(noPosition, "NO", quantity, noProceeds, at);
      adjustWallet(yesSeller, yesProceeds);
      adjustWallet(noSeller, noProceeds);

      orderA = makeFilledOrder(
        spec,
        yesSeller,
        "YES",
        "SELL",
        price,
        quantity,
        at,
      );
      orderB = makeFilledOrder(
        spec,
        noSeller,
        "NO",
        "SELL",
        100 - price,
        quantity,
        at,
      );

      tradeId = randomUUID();
      trades.push({
        id: tradeId,
        marketId: spec.id,
        makerOrderId: orderA.id,
        takerOrderId: orderB.id,
        makerUserId: yesSeller,
        takerUserId: noSeller,
        yesPrice: price,
        quantity,
        createdAt: at,
      });
      addLedger(
        yesSeller,
        spec,
        yesProceeds,
        "TRADE_SELL",
        at,
        orderA.id,
        tradeId,
      );
      addLedger(
        noSeller,
        spec,
        noProceeds,
        "TRADE_SELL",
        at,
        orderB.id,
        tradeId,
      );
    }

    orders.push(orderA, orderB);
    holderSet(spec.id).add(firstUserId);
    holderSet(spec.id).add(secondUserId);
    marketUsers.forEach((user) => holderSet(spec.id).add(user.id));
    lastPriceByMarket.set(spec.id, price);
  }

  for (const spec of marketSpecs) {
    if (spec.tradeCount <= 0) {
      continue;
    }

    const marketUsers = shuffle(traders).slice(
      0,
      int(10, Math.min(30, traders.length)),
    );
    const times = buildTradeTimes(spec);
    let price = spec.basePrice;

    for (let index = 0; index < times.length; index += 1) {
      const at = new Date(times[index]);
      const quantity = int(1, spec.scenario === "many" ? 50 : 25);
      price = clampPrice(
        price + int(-2, 2) + (chance(0.04) ? int(-6, 6) : 0),
      );

      const kindRoll = random();
      let kind: "mint" | "transfer" | "merge" =
        kindRoll < 0.7 ? "mint" : kindRoll < 0.9 ? "transfer" : "merge";

      if (kind === "transfer") {
        const seller = findHolder(marketUsers.map((u) => u.id), spec, "YES", quantity);
        const buyer = pick(
          marketUsers.filter((user) => user.id !== seller),
        )?.id;

        if (!seller || !buyer) {
          kind = "mint";
        } else {
          recordTrade(spec, at, price, quantity, "transfer", marketUsers, seller, buyer);
          continue;
        }
      }

      if (kind === "merge") {
        const yesSeller = findHolder(
          marketUsers.map((u) => u.id),
          spec,
          "YES",
          quantity,
        );
        const noSeller = findHolder(
          marketUsers.map((u) => u.id),
          spec,
          "NO",
          quantity,
        );

        if (yesSeller && noSeller && yesSeller !== noSeller) {
          recordTrade(spec, at, price, quantity, "merge", marketUsers, yesSeller, noSeller);
          continue;
        }
      }

      const first = pick(marketUsers);
      const second = pick(
        marketUsers.filter((user) => user.id !== first.id),
      );

      if (!second) {
        continue;
      }

      recordTrade(
        spec,
        at,
        price,
        quantity,
        "mint",
        marketUsers,
        first.id,
        second.id,
      );
    }
  }

  for (const spec of marketSpecs) {
    if (spec.status !== "RESOLVED" && spec.status !== "VOID") {
      continue;
    }

    const at = spec.resolutionAt ?? new Date(spec.closesAt.getTime() + DAY);
    const holderIds = [...(marketHolders.get(spec.id) ?? [])];
    const lastPrice = lastPriceByMarket.get(spec.id) ?? 50;
    let totalPayout = 0;

    for (const userId of holderIds) {
      const position = positions.get(positionKey(userId, spec.id));

      if (!position) {
        continue;
      }

      if (
        position.yesShares === 0 &&
        position.noShares === 0 &&
        position.yesCost === 0 &&
        position.noCost === 0
      ) {
        continue;
      }

      const payout =
        spec.status === "RESOLVED"
          ? spec.resolutionOutcome === "YES"
            ? position.yesShares * 100
            : position.noShares * 100
          : position.yesShares * lastPrice +
            position.noShares * (100 - lastPrice);
      const realizedDelta =
        payout - position.yesCost - position.noCost;

      totalPayout += payout;

      if (payout > 0) {
        adjustWallet(userId, payout);
        addLedger(
          userId,
          spec,
          payout,
          spec.status === "RESOLVED" ? "SETTLEMENT_PAYOUT" : "REFUND",
          at,
        );
      }

      position.realized += realizedDelta;
      position.yesShares = 0;
      position.noShares = 0;
      position.yesReserved = 0;
      position.noReserved = 0;
      position.yesCost = 0;
      position.noCost = 0;
      position.updatedAt = at;
    }

    marketSettlement.set(spec.id, {
      payout: totalPayout,
      holders: holderIds.length,
    });

    if (spec.status === "RESOLVED" && spec.resolutionOutcome) {
      resolutionRows.push({
        id: randomUUID(),
        marketId: spec.id,
        outcome: spec.resolutionOutcome,
        evidenceUrl: `https://example.com/load/${spec.slug}`,
        notes: "Generated load-test resolution.",
        resolvedBy: adminId,
        resolvedAt: at,
      });
    }
  }

  for (const spec of marketSpecs) {
    if (spec.status !== "OPEN" || spec.scenario === "empty") {
      continue;
    }

    const last = lastPriceByMarket.get(spec.id) ?? spec.basePrice;
    const step = spec.scenario === "wide" ? 20 : 1;
    const levels =
      spec.scenario === "deep"
        ? 12
        : spec.scenario === "wide"
          ? 2
          : spec.scenario === "many"
            ? 6
            : spec.scenario === "sells"
              ? 5
              : spec.scenario === "bidsOnly" || spec.scenario === "asksOnly"
                ? 6
                : 4;
    const bidLevels =
      spec.scenario === "asksOnly" ? 0 : levels;
    const askLevels =
      spec.scenario === "bidsOnly" ? 0 : levels;
    const bookCreatedAt = new Date(NOW - int(1, 72) * HOUR);

    function reserveBuy(
      userId: string,
      price: number,
      quantity: number,
      filledQuantity: number,
      outcome: Outcome,
      status: OrderStatus,
    ) {
      const remaining = quantity - filledQuantity;
      const wallet = wallets.get(userId);

      if (!wallet) {
        return;
      }

      wallet.reserved += remaining * price;
      orders.push({
        id: randomUUID(),
        userId,
        marketId: spec.id,
        outcome,
        action: "BUY",
        type: "LIMIT",
        price,
        quantity,
        filledQuantity,
        status,
        idempotencyKey: `${PREFIX}${randomUUID()}`,
        createdAt: bookCreatedAt,
        updatedAt: bookCreatedAt,
      });
    }

    for (let level = 0; level < bidLevels; level += 1) {
      const price = last - (level + 1) * step;

      if (price < MIN_PRICE) {
        continue;
      }

      const quantity =
        spec.scenario === "deep" ? int(50, 400) : int(20, 250);
      const partial = chance(0.2) && quantity > 2;
      const filledQuantity = partial ? int(1, quantity - 1) : 0;

      reserveBuy(
        pick(traders).id,
        price,
        quantity,
        filledQuantity,
        "YES",
        partial ? "PARTIAL" : "OPEN",
      );
    }

    for (let level = 0; level < askLevels; level += 1) {
      const yesPrice = last + (level + 1) * step;

      if (yesPrice > MAX_PRICE) {
        continue;
      }

      const noPrice = 100 - yesPrice;
      const quantity =
        spec.scenario === "deep" ? int(50, 400) : int(20, 250);
      const partial = chance(0.2) && quantity > 2;
      const filledQuantity = partial ? int(1, quantity - 1) : 0;

      reserveBuy(
        pick(traders).id,
        noPrice,
        quantity,
        filledQuantity,
        "NO",
        partial ? "PARTIAL" : "OPEN",
      );
    }

    if (spec.scenario === "sells") {
      for (let index = 0; index < 2; index += 1) {
        const quantity = int(5, 40);
        const yesSeller = findHolder(
          traders.map((user) => user.id),
          spec,
          "YES",
          quantity,
        );
        const noSeller = findHolder(
          traders.map((user) => user.id),
          spec,
          "NO",
          quantity,
        );

        if (yesSeller) {
          const yesPrice = clampPrice(last + 2 + index);

          if (yesPrice <= MAX_PRICE) {
            const position = getPosition(yesSeller, spec);
            position.yesReserved += quantity;
            orders.push({
              id: randomUUID(),
              userId: yesSeller,
              marketId: spec.id,
              outcome: "YES",
              action: "SELL",
              type: "LIMIT",
              price: yesPrice,
              quantity,
              filledQuantity: 0,
              status: "OPEN",
              idempotencyKey: `${PREFIX}${randomUUID()}`,
              createdAt: bookCreatedAt,
              updatedAt: bookCreatedAt,
            });
          }
        }

        if (noSeller) {
          const noPrice = clampPrice(100 - last + 2 + index);

          if (noPrice <= MAX_PRICE) {
            const position = getPosition(noSeller, spec);
            position.noReserved += quantity;
            orders.push({
              id: randomUUID(),
              userId: noSeller,
              marketId: spec.id,
              outcome: "NO",
              action: "SELL",
              type: "LIMIT",
              price: noPrice,
              quantity,
              filledQuantity: 0,
              status: "OPEN",
              idempotencyKey: `${PREFIX}${randomUUID()}`,
              createdAt: bookCreatedAt,
              updatedAt: bookCreatedAt,
            });
          }
        }
      }
    }

    if (chance(0.25)) {
      const cancelledAt = new Date(NOW - int(2, 6) * DAY);
      orders.push({
        id: randomUUID(),
        userId: pick(traders).id,
        marketId: spec.id,
        outcome: "YES",
        action: "BUY",
        type: "LIMIT",
        price: clampPrice(last - 10),
        quantity: 25,
        filledQuantity: 0,
        status: "CANCELLED",
        idempotencyKey: `${PREFIX}${randomUUID()}`,
        createdAt: cancelledAt,
        updatedAt: cancelledAt,
      });
      orders.push({
        id: randomUUID(),
        userId: pick(traders).id,
        marketId: spec.id,
        outcome: "YES",
        action: "SELL",
        type: "LIMIT",
        price: clampPrice(last + 10),
        quantity: 10,
        filledQuantity: 0,
        status: "EXPIRED",
        idempotencyKey: `${PREFIX}${randomUUID()}`,
        createdAt: cancelledAt,
        updatedAt: cancelledAt,
      });
    }
  }

  for (const [userId, wallet] of wallets) {
    if (wallet.balance >= wallet.reserved) {
      continue;
    }

    const topUp = wallet.reserved - wallet.balance + 100_000;
    wallet.balance += topUp;
    ledgerRows.push({
      id: randomUUID(),
      userId,
      marketId: null,
      orderId: null,
      tradeId: null,
      amount: topUp,
      type: "ADMIN_ADJUSTMENT",
      createdAt: new Date(NOW),
    });
  }

  for (const spec of marketSpecs) {
    if (spec.status === "DRAFT") {
      continue;
    }

    const commentCount = int(0, 6);
    const commentEnd = Math.min(
      NOW,
      spec.resolutionAt?.getTime() ?? spec.closesAt.getTime(),
    );

    for (let index = 0; index < commentCount; index += 1) {
      const createdAt = new Date(
        spec.createdAt.getTime() +
          random() * Math.max(1, commentEnd - spec.createdAt.getTime()),
      );
      commentRows.push({
        id: randomUUID(),
        userId: pick(traders).id,
        marketId: spec.id,
        body: pick(commentBodies),
        createdAt,
      });
    }

    const watcherCount = int(0, 10);
    const watchers = new Set<string>();
    const watchersForMarket = new Set<string>();

    for (let index = 0; index < watcherCount; index += 1) {
      watchers.add(pick(traders).id);
    }

    for (const userId of watchers) {
      watchersForMarket.add(userId);
      watchlistRows.push({
        id: randomUUID(),
        userId,
        marketId: spec.id,
        createdAt: new Date(
          spec.createdAt.getTime() + random() * DAY,
        ),
      });
    }

    watchersByMarket.set(spec.id, watchersForMarket);

    if (spec.status === "RESOLVED" || spec.status === "VOID") {
      const at = spec.resolutionAt ?? new Date(spec.closesAt.getTime() + DAY);
      const recipients = new Set([
        ...(marketHolders.get(spec.id) ?? []),
        ...watchers,
      ]);

      for (const userId of recipients) {
        notificationRows.push({
          id: randomUUID(),
          userId,
          marketId: spec.id,
          type:
            spec.status === "RESOLVED"
              ? "MARKET_RESOLVED"
              : "MARKET_VOIDED",
          title:
            spec.status === "RESOLVED"
              ? `Market resolved ${spec.resolutionOutcome}`
              : "Market voided — positions unwound",
          body: spec.question,
          readAt: chance(0.5)
            ? new Date(Math.min(NOW, at.getTime() + int(1, 48) * HOUR))
            : null,
          createdAt: at,
        });
      }
    }
  }

  for (const spec of marketSpecs) {
    auditRows.push({
      id: randomUUID(),
      userId: adminId,
      marketId: spec.id,
      action: "MARKET_SEEDED",
      details: {
        dataset: "load",
        scenario: spec.scenario,
      },
      createdAt: spec.createdAt,
    });

    if (
      spec.status === "CLOSED" ||
      spec.status === "RESOLVED" ||
      spec.status === "VOID"
    ) {
      auditRows.push({
        id: randomUUID(),
        userId: adminId,
        marketId: spec.id,
        action: "MARKET_CLOSED",
        details: { dataset: "load" },
        createdAt: spec.closesAt,
      });
    }

    if (spec.status === "RESOLVED") {
      auditRows.push({
        id: randomUUID(),
        userId: adminId,
        marketId: spec.id,
        action: "MARKET_RESOLVED",
        details: {
          dataset: "load",
          outcome: spec.resolutionOutcome ?? "YES",
          payout: marketSettlement.get(spec.id)?.payout ?? 0,
          holders: marketSettlement.get(spec.id)?.holders ?? 0,
        },
        createdAt: spec.resolutionAt ?? spec.closesAt,
      });
    }

    if (spec.status === "VOID") {
      auditRows.push({
        id: randomUUID(),
        userId: adminId,
        marketId: spec.id,
        action: "MARKET_VOIDED",
        details: {
          dataset: "load",
          refunded: marketSettlement.get(spec.id)?.payout ?? 0,
          holders: marketSettlement.get(spec.id)?.holders ?? 0,
        },
        createdAt: spec.resolutionAt ?? spec.closesAt,
      });
    }
  }

  const positionRows: PositionRow[] = [...positions.values()]
    .filter((position) => position.touched)
    .map(({ touched: _touched, ...position }) => position);

  const walletRows: WalletRow[] = [...wallets.values()].map((wallet) => ({
    ...wallet,
    updatedAt: new Date(NOW),
  }));

  const marketRows: MarketRow[] = marketSpecs.map(
    ({ scenario: _scenario, basePrice: _basePrice, tradeCount: _tradeCount, resolutionOutcome: _outcome, resolutionAt: _resolutionAt, ...market }) =>
      market,
  );

  for (const spec of marketSpecs) {
    let yes = 0;
    let no = 0;

    for (const position of positions.values()) {
      if (position.marketId !== spec.id) {
        continue;
      }

      yes += position.yesShares;
      no += position.noShares;
    }

    if (yes !== no) {
      throw new Error(
        `Share conservation failed for ${spec.slug}: YES=${yes} NO=${no}`,
      );
    }
  }

  for (const wallet of walletRows) {
    if (wallet.balance < wallet.reserved) {
      throw new Error(
        `Wallet ${wallet.userId} has balance ${wallet.balance} below reserved ${wallet.reserved}`,
      );
    }
  }

  for (const position of positionRows) {
    if (
      position.yesReserved > position.yesShares ||
      position.noReserved > position.noShares
    ) {
      throw new Error(`Reserved shares exceed holdings for ${position.id}`);
    }
  }

  const statusCounts = marketRows.reduce<Record<string, number>>(
    (counts, market) => {
      counts[market.status] = (counts[market.status] ?? 0) + 1;
      return counts;
    },
    {},
  );

  console.log("Generated summary:", {
    users: userRows.length,
    markets: marketRows.length,
    statuses: statusCounts,
    trades: trades.length,
    orders: orders.length,
    positions: positionRows.length,
    ledger: ledgerRows.length,
    comments: commentRows.length,
    watchlist: watchlistRows.length,
    notifications: notificationRows.length,
    resolutions: resolutionRows.length,
    audit: auditRows.length,
  });

  async function batchInsert<T>(
    label: string,
    rows: T[],
    insert: (data: T[]) => Promise<unknown>,
  ) {
    const batchSize = 500;

    for (let index = 0; index < rows.length; index += batchSize) {
      await insert(rows.slice(index, index + batchSize));
    }

    console.log(`Inserted ${rows.length} ${label}`);
  }

  await batchInsert("users", userRows, (data) =>
    prisma.user.createMany({ data }),
  );
  await batchInsert("wallets", walletRows, (data) =>
    prisma.wallet.createMany({ data }),
  );
  await batchInsert("markets", marketRows, (data) =>
    prisma.market.createMany({ data }),
  );
  await batchInsert("orders", orders, (data) =>
    prisma.order.createMany({ data }),
  );
  await batchInsert("trades", trades, (data) =>
    prisma.trade.createMany({ data }),
  );
  await batchInsert("positions", positionRows, (data) =>
    prisma.position.createMany({ data }),
  );
  await batchInsert("ledger entries", ledgerRows, (data) =>
    prisma.ledgerEntry.createMany({ data }),
  );
  await batchInsert("comments", commentRows, (data) =>
    prisma.comment.createMany({ data }),
  );
  await batchInsert("watchlist rows", watchlistRows, (data) =>
    prisma.watchlist.createMany({ data }),
  );
  await batchInsert("notifications", notificationRows, (data) =>
    prisma.notification.createMany({ data }),
  );
  await batchInsert("resolutions", resolutionRows, (data) =>
    prisma.marketResolution.createMany({ data }),
  );
  await batchInsert("audit events", auditRows, (data) =>
    prisma.auditEvent.createMany({ data }),
  );

  console.log("Load-test seed completed.");
  console.log(
    `Login with any ${PREFIX}user-XX@example.com or ${PREFIX}admin@example.com using password: ${PASSWORD}`,
  );
}

main()
  .catch((error) => {
    console.error("Load seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
