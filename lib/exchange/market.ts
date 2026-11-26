import { Prisma } from "@/app/generated/prisma/client";
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Outcome } from "@/app/generated/prisma/enums";
import { ApiError } from "@/lib/api/errors";
import {
  aggregateBook,
  type BookSnapshot,
  type MatchableOrder,
} from "./matching";
import { resolvePositionPayout, voidPositionPayout } from "./settlement";
import { cancelOpenOrders, lockMarket } from "./orders";

type Tx = Prisma.TransactionClient;

const ORDER_SELECT = {
  id: true,
  marketId: true,
  userId: true,
  outcome: true,
  action: true,
  price: true,
  quantity: true,
  filledQuantity: true,
  createdAt: true,
} as const;

export type MarketStats = {
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  volume24h: number;
  trades24h: number;
  openInterest: number;
  change24h: number | null;
  spark: number[];
  high24h: number | null;
  low24h: number | null;
};

export type TradeTapeItem = {
  id: string;
  yesPrice: number;
  quantity: number;
  createdAt: string;
  takerAction: "BUY" | "SELL";
  takerOutcome: Outcome;
};

export type MarketSnapshot = {
  stats: MarketStats;
  book: BookSnapshot;
  trades: TradeTapeItem[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadBookOrders(
  prisma: PrismaClient | Tx,
  marketId: string,
): Promise<MatchableOrder[]> {
  return prisma.order.findMany({
    where: {
      marketId,
      status: { in: ["OPEN", "PARTIAL"] },
    },
    select: ORDER_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function getLatestTrade(
  prisma: PrismaClient | Tx,
  marketId: string,
) {
  return prisma.trade.findFirst({
    where: { marketId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      yesPrice: true,
      quantity: true,
      createdAt: true,
      takerOrder: { select: { action: true, outcome: true } },
    },
  });
}

export async function getMarketSnapshot(
  prisma: PrismaClient,
  marketId: string,
): Promise<MarketSnapshot> {
  const cutoff = new Date(Date.now() - DAY_MS);

  const [orders, trades, volume, openInterest] = await Promise.all([
    loadBookOrders(prisma, marketId),
    prisma.trade.findMany({
      where: { marketId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 30,
      select: {
        id: true,
        yesPrice: true,
        quantity: true,
        createdAt: true,
        takerOrder: { select: { action: true, outcome: true } },
      },
    }),
    prisma.trade.aggregate({
      where: { marketId, createdAt: { gte: cutoff } },
      _sum: { quantity: true },
      _count: { _all: true },
      _min: { yesPrice: true },
      _max: { yesPrice: true },
    }),
    prisma.position.aggregate({
      where: { marketId },
      _sum: { yesShares: true },
    }),
  ]);

  const book = aggregateBook(orders);
  const lastTrade = trades[0] ?? null;
  const lastPrice = lastTrade?.yesPrice ?? null;

  const tradesInWindow = trades.filter(
    (trade) => trade.createdAt.getTime() >= cutoff.getTime(),
  );
  const oldestInWindow = tradesInWindow[tradesInWindow.length - 1];
  const change24h =
    lastPrice !== null && oldestInWindow
      ? lastPrice - oldestInWindow.yesPrice
      : null;

  return {
    book,
    stats: {
      lastPrice,
      high24h: volume._max.yesPrice ?? null,
      low24h: volume._min.yesPrice ?? null,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      mid: book.mid,
      spread: book.spread,
      volume24h: volume._sum.quantity ?? 0,
      trades24h: volume._count._all,
      openInterest: openInterest._sum.yesShares ?? 0,
      change24h,
      spark: [...tradesInWindow]
        .reverse()
        .slice(-24)
        .map((trade) => trade.yesPrice),
    },
    trades: trades.map((trade) => ({
      id: trade.id,
      yesPrice: trade.yesPrice,
      quantity: trade.quantity,
      createdAt: trade.createdAt.toISOString(),
      takerAction: trade.takerOrder.action,
      takerOutcome: trade.takerOrder.outcome,
    })),
  };
}

/**
 * Lightweight stats for list screens. Fetches the open book, the most recent
 * trades, and 24h volume for a batch of markets in three queries.
 */
export async function getMarketStatsMap(
  prisma: PrismaClient,
  marketIds: string[],
): Promise<Map<string, MarketStats>> {
  const result = new Map<string, MarketStats>();

  if (marketIds.length === 0) {
    return result;
  }

  const cutoff = new Date(Date.now() - DAY_MS);

  const [orders, trades, volumes, openInterest] = await Promise.all([
    prisma.order.findMany({
      where: {
        marketId: { in: marketIds },
        status: { in: ["OPEN", "PARTIAL"] },
      },
      select: ORDER_SELECT,
    }),
    prisma.trade.findMany({
      where: { marketId: { in: marketIds } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 4_000,
      select: {
        marketId: true,
        yesPrice: true,
        quantity: true,
        createdAt: true,
      },
    }),
    prisma.trade.groupBy({
      by: ["marketId"],
      where: { marketId: { in: marketIds }, createdAt: { gte: cutoff } },
      _sum: { quantity: true },
      _count: { _all: true },
      _max: { yesPrice: true },
      _min: { yesPrice: true },
    }),
    prisma.position.groupBy({
      by: ["marketId"],
      where: { marketId: { in: marketIds } },
      _sum: { yesShares: true },
    }),
  ]);

  const ordersByMarket = new Map<string, MatchableOrder[]>();
  for (const order of orders) {
    const bucket = ordersByMarket.get(order.marketId);
    if (bucket) {
      bucket.push(order);
    } else {
      ordersByMarket.set(order.marketId, [order]);
    }
  }

  const volumeByMarket = new Map(
    volumes.map((row) => [
      row.marketId,
      {
        volume: row._sum.quantity ?? 0,
        trades: row._count._all,
        low: row._min.yesPrice ?? null,
        high: row._max.yesPrice ?? null,
      },
    ]),
  );
  const interestByMarket = new Map(
    openInterest.map((row) => [row.marketId, row._sum.yesShares ?? 0]),
  );

  const tradesByMarket = new Map<
    string,
    { yesPrice: number; quantity: number; createdAt: Date }[]
  >();
  for (const trade of trades) {
    const bucket = tradesByMarket.get(trade.marketId);
    if (bucket) {
      bucket.push(trade);
    } else {
      tradesByMarket.set(trade.marketId, [trade]);
    }
  }

  for (const marketId of marketIds) {
    const book = aggregateBook(ordersByMarket.get(marketId) ?? []);
    const marketTrades = tradesByMarket.get(marketId) ?? [];
    const lastPrice = marketTrades[0]?.yesPrice ?? null;
    const windowTrades = marketTrades.filter(
      (trade) => trade.createdAt.getTime() >= cutoff.getTime(),
    );
    const oldestInWindow = windowTrades[windowTrades.length - 1];
    const volume = volumeByMarket.get(marketId);

    result.set(marketId, {
      lastPrice,
      low24h: volume?.low ?? null,
      high24h: volume?.high ?? null,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      mid: book.mid,
      spread: book.spread,
      volume24h: volume?.volume ?? 0,
      trades24h: volume?.trades ?? 0,
      openInterest: interestByMarket.get(marketId) ?? 0,
      change24h:
        lastPrice !== null && oldestInWindow
          ? lastPrice - oldestInWindow.yesPrice
          : null,
      spark: [...windowTrades]
        .reverse()
        .slice(-24)
        .map((trade) => trade.yesPrice),
    });
  }

  return result;
}

export const CANDLE_RANGES = ["1H", "1D", "1W", "1M", "ALL"] as const;
export type CandleRange = (typeof CANDLE_RANGES)[number];

export type Candle = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RANGE_CONFIG: Record<
  Exclude<CandleRange, "ALL">,
  { windowMs: number; intervalMs: number }
> = {
  "1H": { windowMs: HOUR, intervalMs: MINUTE },
  "1D": { windowMs: DAY, intervalMs: 5 * MINUTE },
  "1W": { windowMs: 7 * DAY, intervalMs: HOUR },
  "1M": { windowMs: 30 * DAY, intervalMs: 6 * HOUR },
};

const ALL_INTERVALS = [
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  4 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
];

function pickInterval(spanMs: number) {
  const target = Math.max(spanMs / 240, MINUTE);

  for (const interval of ALL_INTERVALS) {
    if (interval >= target) {
      return interval;
    }
  }

  return ALL_INTERVALS[ALL_INTERVALS.length - 1];
}

export function buildCandles(
  trades: { yesPrice: number; quantity: number; createdAt: Date }[],
  intervalMs: number,
): Candle[] {
  const buckets = new Map<
    number,
    { o: number; h: number; l: number; c: number; v: number }
  >();

  for (const trade of trades) {
    const start =
      Math.floor(trade.createdAt.getTime() / intervalMs) * intervalMs;
    const bucket = buckets.get(start);

    if (!bucket) {
      buckets.set(start, {
        o: trade.yesPrice,
        h: trade.yesPrice,
        l: trade.yesPrice,
        c: trade.yesPrice,
        v: trade.quantity,
      });
      continue;
    }

    bucket.h = Math.max(bucket.h, trade.yesPrice);
    bucket.l = Math.min(bucket.l, trade.yesPrice);
    bucket.c = trade.yesPrice;
    bucket.v += trade.quantity;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, bucket]) => ({
      t: new Date(start).toISOString(),
      ...bucket,
    }));
}

export async function getMarketCandles(
  prisma: PrismaClient,
  marketId: string,
  range: CandleRange,
): Promise<{ range: CandleRange; intervalMs: number; candles: Candle[] }> {
  const now = Date.now();
  const config =
    range === "ALL" ? null : RANGE_CONFIG[range as Exclude<CandleRange, "ALL">];
  const cutoff = config ? new Date(now - config.windowMs) : null;

  const trades = await prisma.trade.findMany({
    where: {
      marketId,
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { yesPrice: true, quantity: true, createdAt: true },
    take: 20_000,
  });

  let intervalMs = config?.intervalMs ?? 0;

  if (range === "ALL") {
    const first = trades[0]?.createdAt.getTime() ?? now;
    const last = trades[trades.length - 1]?.createdAt.getTime() ?? now;
    intervalMs = pickInterval(Math.max(HOUR, last - first));
  }

  return {
    range,
    intervalMs,
    candles: buildCandles(trades, intervalMs),
  };
}

export async function getLastTradePrice(
  tx: Prisma.TransactionClient,
  marketId: string,
) {
  const trade = await tx.trade.findFirst({
    where: { marketId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { yesPrice: true },
  });

  return trade?.yesPrice ?? null;
}

export type CloseMarketResult = {
  closed: boolean;
  cancelledOrders: number;
};

export async function closeMarket(
  tx: Tx,
  params: { marketId: string; adminId?: string },
): Promise<CloseMarketResult> {
  await lockMarket(tx, params.marketId);

  const market = await tx.market.findUnique({
    where: { id: params.marketId },
    select: { id: true, slug: true, status: true },
  });

  if (!market) {
    throw new ApiError(404, "Market not found");
  }

  if (market.status !== "OPEN") {
    throw new ApiError(409, "Only open markets can be closed");
  }

  const cancelledOrders = await cancelOpenOrders(
    tx,
    params.marketId,
    "EXPIRED",
  );

  await tx.market.update({
    where: { id: params.marketId },
    data: { status: "CLOSED" },
  });

  if (params.adminId) {
    await tx.auditEvent.create({
      data: {
        userId: params.adminId,
        marketId: params.marketId,
        action: "MARKET_CLOSED",
        details: { slug: market.slug, cancelledOrders },
      },
    });
  }

  return { closed: true, cancelledOrders };
}

type PositionRow = {
  id: string;
  userId: string;
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
  realized: number;
};

async function zeroPosition(
  tx: Tx,
  position: PositionRow,
  realizedDelta: number,
) {
  await tx.position.update({
    where: { id: position.id },
    data: {
      yesShares: 0,
      noShares: 0,
      yesReserved: 0,
      noReserved: 0,
      yesCost: 0,
      noCost: 0,
      realized: position.realized + realizedDelta,
    },
  });
}

async function notifyTraders(
  tx: Tx,
  marketId: string,
  params: { type: string; title: string; body: string },
) {
  const [positions, watchers] = await Promise.all([
    tx.position.findMany({
      where: { marketId },
      select: { userId: true },
    }),
    tx.watchlist.findMany({
      where: { marketId },
      select: { userId: true },
    }),
  ]);

  const recipients = new Set<string>();

  for (const position of positions) {
    recipients.add(position.userId);
  }

  for (const watcher of watchers) {
    recipients.add(watcher.userId);
  }

  if (recipients.size === 0) {
    return;
  }

  await tx.notification.createMany({
    data: [...recipients].map((userId) => ({
      userId,
      marketId,
      type: params.type,
      title: params.title,
      body: params.body,
    })),
  });
}

export type ResolveMarketResult = {
  outcome: Outcome;
  totalShares: number;
  winningShares: number;
  totalPayout: number;
  winners: number;
  losers: number;
};

export async function resolveMarket(
  tx: Tx,
  params: {
    marketId: string;
    adminId: string;
    outcome: Outcome;
    notes?: string | null;
    evidenceUrl?: string | null;
  },
): Promise<ResolveMarketResult> {
  await lockMarket(tx, params.marketId);

  const market = await tx.market.findUnique({
    where: { id: params.marketId },
    select: {
      id: true,
      slug: true,
      question: true,
      status: true,
    },
  });

  if (!market) {
    throw new ApiError(404, "Market not found");
  }

  if (market.status !== "CLOSED") {
    throw new ApiError(409, "Only closed markets can be resolved");
  }

  await cancelOpenOrders(tx, params.marketId, "EXPIRED");

  const positions = await tx.position.findMany({
    where: { marketId: params.marketId },
    select: {
      id: true,
      userId: true,
      yesShares: true,
      noShares: true,
      yesCost: true,
      noCost: true,
      realized: true,
    },
  });

  let totalShares = 0;
  let winningShares = 0;
  let totalPayout = 0;
  let winners = 0;
  let losers = 0;

  for (const position of positions) {
    totalShares += position.yesShares + position.noShares;

    if (position.yesShares === 0 && position.noShares === 0) {
      continue;
    }

    const {
      payout,
      realizedDelta,
      winningShares: won,
    } = resolvePositionPayout(position, params.outcome);

    winningShares += won;
    totalPayout += payout;

    if (payout > 0) {
      winners += 1;
      await tx.wallet.update({
        where: { userId: position.userId },
        data: { balance: { increment: payout } },
      });
      await tx.ledgerEntry.create({
        data: {
          userId: position.userId,
          marketId: params.marketId,
          amount: payout,
          type: "SETTLEMENT_PAYOUT",
        },
      });
    } else {
      losers += 1;
    }

    await zeroPosition(tx, position, realizedDelta);
  }

  await tx.market.update({
    where: { id: params.marketId },
    data: { status: "RESOLVED" },
  });

  await tx.marketResolution.create({
    data: {
      marketId: params.marketId,
      outcome: params.outcome,
      notes: params.notes ?? null,
      evidenceUrl: params.evidenceUrl ?? null,
      resolvedBy: params.adminId,
    },
  });

  await notifyTraders(tx, params.marketId, {
    type: "MARKET_RESOLVED",
    title: `Market resolved ${params.outcome}`,
    body: market.question,
  });

  await tx.auditEvent.create({
    data: {
      userId: params.adminId,
      marketId: params.marketId,
      action: "MARKET_RESOLVED",
      details: {
        slug: market.slug,
        outcome: params.outcome,
        totalShares,
        winningShares,
        totalPayout,
        winners,
        losers,
      },
    },
  });

  return {
    outcome: params.outcome,
    totalShares,
    winningShares,
    totalPayout,
    winners,
    losers,
  };
}

export type VoidMarketResult = {
  price: number;
  totalShares: number;
  totalRefund: number;
  holders: number;
};

export async function voidMarket(
  tx: Tx,
  params: {
    marketId: string;
    adminId: string;
    notes?: string | null;
  },
): Promise<VoidMarketResult> {
  await lockMarket(tx, params.marketId);

  const market = await tx.market.findUnique({
    where: { id: params.marketId },
    select: { id: true, slug: true, question: true, status: true },
  });

  if (!market) {
    throw new ApiError(404, "Market not found");
  }

  if (market.status !== "OPEN" && market.status !== "CLOSED") {
    throw new ApiError(409, "Market can no longer be voided");
  }

  const lastPrice = (await getLastTradePrice(tx, params.marketId)) ?? 50;

  await cancelOpenOrders(tx, params.marketId, "EXPIRED");

  const positions = await tx.position.findMany({
    where: { marketId: params.marketId },
    select: {
      id: true,
      userId: true,
      yesShares: true,
      noShares: true,
      yesCost: true,
      noCost: true,
      realized: true,
    },
  });

  let totalShares = 0;
  let totalRefund = 0;
  let holders = 0;

  for (const position of positions) {
    totalShares += position.yesShares + position.noShares;

    if (position.yesShares === 0 && position.noShares === 0) {
      continue;
    }

    const { payout, realizedDelta } = voidPositionPayout(position, lastPrice);

    totalRefund += payout;
    holders += 1;

    if (payout > 0) {
      await tx.wallet.update({
        where: { userId: position.userId },
        data: { balance: { increment: payout } },
      });
      await tx.ledgerEntry.create({
        data: {
          userId: position.userId,
          marketId: params.marketId,
          amount: payout,
          type: "REFUND",
        },
      });
    }

    await zeroPosition(tx, position, realizedDelta);
  }

  await tx.market.update({
    where: { id: params.marketId },
    data: { status: "VOID" },
  });

  await notifyTraders(tx, params.marketId, {
    type: "MARKET_VOIDED",
    title: "Market voided — positions unwound",
    body: market.question,
  });

  await tx.auditEvent.create({
    data: {
      userId: params.adminId,
      marketId: params.marketId,
      action: "MARKET_VOIDED",
      details: {
        slug: market.slug,
        price: lastPrice,
        totalShares,
        totalRefund,
        holders,
        notes: params.notes ?? null,
      },
    },
  });

  return { price: lastPrice, totalShares, totalRefund, holders };
}
