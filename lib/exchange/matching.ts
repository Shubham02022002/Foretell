import type { OrderAction, Outcome } from "@/app/generated/prisma/enums";
import { SHARE_VALUE } from "./constants";

/**
 * A binary market has two tradable shares: YES and NO. Every order is an
 * expression of long or short YES exposure:
 *
 *   BUY YES  -> long YES   (pays the YES price)
 *   SELL NO  -> long YES   (receives SHARE_VALUE - YES price)
 *   SELL YES -> short YES  (receives the YES price)
 *   BUY NO   -> short YES  (pays SHARE_VALUE - YES price)
 *
 * Normalising every order to a YES price and a LONG/SHORT side lets one
 * price-time-priority book match all four combinations correctly:
 *
 *   long YES <-> short YES  -> transfer YES shares
 *   long YES <-> long YES   -> never (same side)
 *   long YES <-> sell NO?   -> buy YES + sell NO both long; never
 *   buy YES  <-> buy NO     -> mint a YES/NO pair
 *   sell YES <-> sell NO    -> merge a YES/NO pair
 */
export type BookSide = "LONG" | "SHORT";

export type MatchableOrder = {
  id: string;
  userId: string;
  outcome: Outcome;
  action: OrderAction;
  price: number;
  quantity: number;
  filledQuantity: number;
  createdAt: Date | string;
};

export type NormalizedOrder = MatchableOrder & {
  side: BookSide;
  /** YES price equivalent, always in [1, SHARE_VALUE - 1]. */
  yesPrice: number;
  remaining: number;
};

export type Fill = {
  makerOrderId: string;
  makerUserId: string;
  takerOrderId: string;
  takerUserId: string;
  makerOutcome: Outcome;
  makerAction: OrderAction;
  takerOutcome: Outcome;
  takerAction: OrderAction;
  /** Execution price expressed as a YES price. */
  yesPrice: number;
  /** Maker's own-side price (what they pay or receive). */
  makerPrice: number;
  /** Taker's own-side price (what they pay or receive). */
  takerPrice: number;
  quantity: number;
};

export function bookSideFor(
  action: OrderAction,
  outcome: Outcome,
): BookSide {
  return (action === "BUY") === (outcome === "YES") ? "LONG" : "SHORT";
}

export function yesPriceFor(outcome: Outcome, price: number) {
  return outcome === "YES" ? price : SHARE_VALUE - price;
}

export function ownPriceAt(outcome: Outcome, yesPrice: number) {
  return outcome === "YES" ? yesPrice : SHARE_VALUE - yesPrice;
}

export function normalizeOrder(order: MatchableOrder): NormalizedOrder {
  return {
    ...order,
    side: bookSideFor(order.action, order.outcome),
    yesPrice: yesPriceFor(order.outcome, order.price),
    remaining: Math.max(0, order.quantity - order.filledQuantity),
  };
}

function compareResting(a: NormalizedOrder, b: NormalizedOrder) {
  const aTime = new Date(a.createdAt).getTime();
  const bTime = new Date(b.createdAt).getTime();

  if (aTime !== bTime) {
    return aTime - bTime;
  }

  return a.id.localeCompare(b.id);
}

/**
 * Matches an incoming order against resting orders with price-time priority.
 *
 * The resting order is always the maker, so the trade prints at the maker's
 * YES price. The taker gets any price improvement. `maxTakerSpend`, when set,
 * caps how many credits a buying taker can spend (used for market orders and
 * for reservation-backed limit orders).
 */
export function matchOrders(params: {
  taker: MatchableOrder;
  resting: MatchableOrder[];
  maxTakerSpend?: number;
}): Fill[] {
  const taker = normalizeOrder(params.taker);

  if (taker.remaining <= 0) {
    return [];
  }

  const opposingSide: BookSide = taker.side === "LONG" ? "SHORT" : "LONG";

  const eligible = params.resting
    .filter((order) => order.userId !== taker.userId)
    .map(normalizeOrder)
    .filter(
      (order) =>
        order.remaining > 0 &&
        order.side === opposingSide &&
        (taker.side === "LONG"
          ? order.yesPrice <= taker.yesPrice
          : order.yesPrice >= taker.yesPrice),
    )
    .sort((a, b) =>
      taker.side === "LONG"
        ? a.yesPrice - b.yesPrice || compareResting(a, b)
        : b.yesPrice - a.yesPrice || compareResting(a, b),
    );

  const fills: Fill[] = [];
  let remaining = taker.remaining;
  let spend = 0;

  for (const maker of eligible) {
    if (remaining <= 0) {
      break;
    }

    const yesPrice = maker.yesPrice;
    const takerPrice = ownPriceAt(taker.outcome, yesPrice);
    let quantity = Math.min(remaining, maker.remaining);

    if (taker.action === "BUY" && params.maxTakerSpend !== undefined) {
      const affordable = Math.floor(
        (params.maxTakerSpend - spend) / takerPrice,
      );
      quantity = Math.min(quantity, affordable);
    }

    if (quantity <= 0) {
      break;
    }

    if (taker.action === "BUY") {
      spend += quantity * takerPrice;
    }

    fills.push({
      makerOrderId: maker.id,
      makerUserId: maker.userId,
      takerOrderId: taker.id,
      takerUserId: taker.userId,
      makerOutcome: maker.outcome,
      makerAction: maker.action,
      takerOutcome: taker.outcome,
      takerAction: taker.action,
      yesPrice,
      makerPrice: ownPriceAt(maker.outcome, yesPrice),
      takerPrice,
      quantity,
    });

    remaining -= quantity;
  }

  return fills;
}

export type BookLevel = {
  price: number;
  size: number;
};

export type BookSnapshot = {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
};

export function aggregateBook(
  orders: MatchableOrder[],
  depth = 24,
): BookSnapshot {
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();

  for (const raw of orders) {
    const order = normalizeOrder(raw);

    if (order.remaining <= 0) {
      continue;
    }

    const levels = order.side === "LONG" ? bids : asks;
    levels.set(order.yesPrice, (levels.get(order.yesPrice) ?? 0) + order.remaining);
  }

  const bidLevels = [...bids.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => b.price - a.price)
    .slice(0, depth);
  const askLevels = [...asks.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => a.price - b.price)
    .slice(0, depth);

  const bestBid = bidLevels[0]?.price ?? null;
  const bestAsk = askLevels[0]?.price ?? null;

  return {
    bids: bidLevels,
    asks: askLevels,
    bestBid,
    bestAsk,
    mid:
      bestBid !== null && bestAsk !== null
        ? (bestBid + bestAsk) / 2
        : null,
    spread:
      bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
  };
}

/**
 * Cost basis removed when selling `quantity` of `shares` at total cost
 * `cost`. Uses floor so the remaining basis never exceeds the original cost.
 */
export function releaseCostBasis(
  cost: number,
  shares: number,
  quantity: number,
) {
  if (shares <= 0 || quantity <= 0) {
    return 0;
  }

  return Math.min(cost, Math.floor((cost * quantity) / shares));
}
