import prisma from "@/lib/prisma";
import {
  WINDOW_DURATION_MS,
  type LeaderboardWindow,
} from "@/lib/validations/leaderboard";

const PROFIT_TYPES = [
  "TRADE_BUY",
  "TRADE_SELL",
  "SETTLEMENT_PAYOUT",
  "REFUND",
] as const;

export type TraderStanding = {
  userId: string;
  net: number;
  volume: number;
  bets: number;
  wins: number;
};

export async function getTraderStandings(
  window: LeaderboardWindow = "all",
): Promise<TraderStanding[]> {
  const duration = WINDOW_DURATION_MS[window];
  const since = duration === null ? undefined : new Date(Date.now() - duration);
  const windowFilter = since ? { createdAt: { gte: since } } : {};

  const [profitRows, buyRows, sellRows, payoutRows] = await Promise.all([
    prisma.ledgerEntry.groupBy({
      by: ["userId"],
      where: { type: { in: [...PROFIT_TYPES] }, ...windowFilter },
      _sum: { amount: true },
    }),
    prisma.ledgerEntry.groupBy({
      by: ["userId"],
      where: { type: "TRADE_BUY", ...windowFilter },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.ledgerEntry.groupBy({
      by: ["userId"],
      where: { type: "TRADE_SELL", ...windowFilter },
      _count: { _all: true },
    }),
    prisma.ledgerEntry.groupBy({
      by: ["userId"],
      where: { type: "SETTLEMENT_PAYOUT", ...windowFilter },
      _count: { _all: true },
    }),
  ]);

  const buyById = new Map(
    buyRows.map((row) => [
      row.userId,
      {
        volume: Math.abs(row._sum.amount ?? 0),
        buys: row._count._all,
      },
    ]),
  );
  const sellById = new Map(
    sellRows.map((row) => [row.userId, row._count._all]),
  );
  const winsById = new Map(
    payoutRows.map((row) => [row.userId, row._count._all]),
  );

  return profitRows
    .filter((row) => buyById.has(row.userId) || sellById.has(row.userId))
    .map((row) => {
      const buys = buyById.get(row.userId);

      return {
        userId: row.userId,
        net: row._sum.amount ?? 0,
        volume: buys?.volume ?? 0,
        bets: (buys?.buys ?? 0) + (sellById.get(row.userId) ?? 0),
        wins: winsById.get(row.userId) ?? 0,
      };
    })
    .sort((a, b) => b.net - a.net || b.volume - a.volume);
}
