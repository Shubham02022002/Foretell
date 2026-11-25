import type { PrismaClient } from "@/app/generated/prisma/client";
import type { OrderAction, OrderStatus, OrderType, Outcome } from "@/app/generated/prisma/enums";
import { SHARE_VALUE } from "./constants";

export type PositionMarket = {
  slug: string;
  question: string;
  category: string;
  status: string;
  closesAt: string;
};

export type PositionView = {
  id: string;
  market: PositionMarket;
  yesShares: number;
  noShares: number;
  yesReserved: number;
  noReserved: number;
  yesCost: number;
  noCost: number;
  avgYesPrice: number | null;
  avgNoPrice: number | null;
  markPrice: number | null;
  yesValue: number;
  noValue: number;
  marketValue: number;
  costBasis: number;
  unrealized: number;
  realized: number;
};

export type OrderView = {
  id: string;
  market: PositionMarket;
  outcome: Outcome;
  action: OrderAction;
  type: OrderType;
  price: number;
  quantity: number;
  filledQuantity: number;
  remaining: number;
  status: OrderStatus;
  createdAt: string;
};

export type PortfolioSummary = {
  realizedNet: number;
  marketValue: number;
  costBasis: number;
  unrealized: number;
  openPositions: number;
  openOrders: number;
};

export async function getLatestPrices(
  prisma: PrismaClient,
  marketIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (marketIds.length === 0) {
    return result;
  }

  const trades = await prisma.trade.findMany({
    where: { marketId: { in: marketIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 4_000,
    select: { marketId: true, yesPrice: true },
  });

  for (const trade of trades) {
    if (!result.has(trade.marketId)) {
      result.set(trade.marketId, trade.yesPrice);
    }
  }

  return result;
}

export async function getPositions(
  prisma: PrismaClient,
  userId: string,
  marketId?: string,
): Promise<PositionView[]> {
  const positions = await prisma.position.findMany({
    where: {
      userId,
      ...(marketId ? { marketId } : {}),
      OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      marketId: true,
      yesShares: true,
      noShares: true,
      yesReserved: true,
      noReserved: true,
      yesCost: true,
      noCost: true,
      realized: true,
      market: {
        select: {
          slug: true,
          question: true,
          category: true,
          status: true,
          closesAt: true,
        },
      },
    },
  });

  const prices = await getLatestPrices(
    prisma,
    positions.map((position) => position.marketId),
  );

  return positions.map((position) => {
    const markPrice = prices.get(position.marketId) ?? null;
    const yesValue =
      markPrice === null ? 0 : position.yesShares * markPrice;
    const noValue =
      markPrice === null
        ? 0
        : position.noShares * (SHARE_VALUE - markPrice);
    const costBasis = position.yesCost + position.noCost;

    return {
      id: position.id,
      market: {
        slug: position.market.slug,
        question: position.market.question,
        category: position.market.category,
        status: position.market.status,
        closesAt: position.market.closesAt.toISOString(),
      },
      yesShares: position.yesShares,
      noShares: position.noShares,
      yesReserved: position.yesReserved,
      noReserved: position.noReserved,
      yesCost: position.yesCost,
      noCost: position.noCost,
      avgYesPrice:
        position.yesShares > 0
          ? Number((position.yesCost / position.yesShares).toFixed(2))
          : null,
      avgNoPrice:
        position.noShares > 0
          ? Number((position.noCost / position.noShares).toFixed(2))
          : null,
      markPrice,
      yesValue,
      noValue,
      marketValue: yesValue + noValue,
      costBasis,
      unrealized: markPrice === null ? 0 : yesValue + noValue - costBasis,
      realized: position.realized,
    };
  });
}

export async function getOpenOrders(
  prisma: PrismaClient,
  userId: string,
  marketId?: string,
): Promise<OrderView[]> {
  const orders = await prisma.order.findMany({
    where: {
      userId,
      status: { in: ["OPEN", "PARTIAL"] },
      ...(marketId ? { marketId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      outcome: true,
      action: true,
      type: true,
      price: true,
      quantity: true,
      filledQuantity: true,
      status: true,
      createdAt: true,
      market: {
        select: {
          slug: true,
          question: true,
          category: true,
          status: true,
          closesAt: true,
        },
      },
    },
  });

  return orders.map((order) => ({
    id: order.id,
    market: {
      slug: order.market.slug,
      question: order.market.question,
      category: order.market.category,
      status: order.market.status,
      closesAt: order.market.closesAt.toISOString(),
    },
    outcome: order.outcome,
    action: order.action,
    type: order.type,
    price: order.price,
    quantity: order.quantity,
    filledQuantity: order.filledQuantity,
    remaining: order.quantity - order.filledQuantity,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
  }));
}

export async function getPortfolio(
  prisma: PrismaClient,
  userId: string,
): Promise<{
  positions: PositionView[];
  orders: OrderView[];
  summary: PortfolioSummary;
}> {
  const [positions, orders, realized] = await Promise.all([
    getPositions(prisma, userId),
    getOpenOrders(prisma, userId),
    prisma.position.aggregate({
      where: { userId },
      _sum: { realized: true },
    }),
  ]);

  const marketValue = positions.reduce(
    (sum, position) => sum + position.marketValue,
    0,
  );
  const costBasis = positions.reduce(
    (sum, position) => sum + position.costBasis,
    0,
  );

  return {
    positions,
    orders,
    summary: {
      realizedNet: realized._sum.realized ?? 0,
      marketValue,
      costBasis,
      unrealized: marketValue - costBasis,
      openPositions: positions.length,
      openOrders: orders.length,
    },
  };
}
