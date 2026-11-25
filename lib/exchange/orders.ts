import { randomUUID } from "node:crypto";
import { Prisma } from "@/app/generated/prisma/client";
import type { Order, Position, Trade } from "@/app/generated/prisma/client";
import type { OrderAction, OrderType, Outcome } from "@/app/generated/prisma/enums";
import { ApiError } from "@/lib/api/errors";
import {
  MARKET_ORDER_PRICE,
  MAX_ORDER_QUANTITY,
  MAX_PRICE,
  MIN_PRICE,
} from "./constants";
import {
  bookSideFor,
  matchOrders,
  yesPriceFor,
  type Fill,
  type MatchableOrder,
} from "./matching";

type Tx = Prisma.TransactionClient;

export type PlaceOrderInput = {
  userId: string;
  marketId: string;
  outcome: Outcome;
  action: OrderAction;
  type: OrderType;
  price?: number;
  quantity: number;
  idempotencyKey: string;
  /** Backdating hook for the demo seed; matching still uses the real clock. */
  timestamp?: Date;
};

export type PlaceOrderResult = {
  order: Order;
  trades: Trade[];
  balance: number;
  reserved: number;
  position: Position | null;
  replayed: boolean;
  selfCrossed: boolean;
};

function storedPrice(input: PlaceOrderInput) {
  if (input.type === "MARKET") {
    return MARKET_ORDER_PRICE[input.action];
  }

  if (
    input.price === undefined ||
    !Number.isInteger(input.price) ||
    input.price < MIN_PRICE ||
    input.price > MAX_PRICE
  ) {
    throw new ApiError(400, "Limit price must be between 1 and 99 credits");
  }

  return input.price;
}

export async function lockMarket(tx: Tx, marketId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Market" WHERE "id" = ${marketId} FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "Market not found");
  }
}

async function requireOpenMarket(
  tx: Tx,
  marketId: string,
  now: Date,
) {
  // Lock and read the market in one statement; every order placement on a
  // market serialises on this row before touching the book.
  const rows = await tx.$queryRaw<
    { id: string; status: string; closesAt: Date }[]
  >`
    SELECT "id", "status", "closesAt"
    FROM "Market"
    WHERE "id" = ${marketId}
    FOR UPDATE
  `;
  const market = rows[0];

  if (!market) {
    throw new ApiError(404, "Market not found");
  }

  if (market.status !== "OPEN" || market.closesAt.getTime() <= now.getTime()) {
    throw new ApiError(409, "Market is not open for trading");
  }

  return market;
}

async function reserveCredits(tx: Tx, userId: string, amount: number) {
  if (amount <= 0) {
    return;
  }

  const updated = await tx.$executeRaw`
    UPDATE "Wallet"
    SET "reserved" = "reserved" + ${amount},
        "updatedAt" = NOW()
    WHERE "userId" = ${userId} AND "balance" - "reserved" >= ${amount}
  `;

  if (updated === 0) {
    throw new ApiError(409, "Insufficient credit balance");
  }
}

async function releaseCredits(tx: Tx, userId: string, amount: number) {
  if (amount <= 0) {
    return;
  }

  await tx.$executeRaw`
    UPDATE "Wallet"
    SET "reserved" = GREATEST(0, "reserved" - ${amount}),
        "updatedAt" = NOW()
    WHERE "userId" = ${userId}
  `;
}

async function reserveShares(
  tx: Tx,
  userId: string,
  marketId: string,
  outcome: Outcome,
  quantity: number,
) {
  const updated =
    outcome === "YES"
      ? await tx.$executeRaw`
          UPDATE "Position"
          SET "yesReserved" = "yesReserved" + ${quantity},
              "updatedAt" = NOW()
          WHERE "userId" = ${userId}
            AND "marketId" = ${marketId}
            AND "yesShares" - "yesReserved" >= ${quantity}
        `
      : await tx.$executeRaw`
          UPDATE "Position"
          SET "noReserved" = "noReserved" + ${quantity},
              "updatedAt" = NOW()
          WHERE "userId" = ${userId}
            AND "marketId" = ${marketId}
            AND "noShares" - "noReserved" >= ${quantity}
        `;

  if (updated === 0) {
    throw new ApiError(409, "Not enough shares to sell");
  }
}

async function releaseShares(
  tx: Tx,
  userId: string,
  marketId: string,
  outcome: Outcome,
  quantity: number,
) {
  if (quantity <= 0) {
    return;
  }

  if (outcome === "YES") {
    await tx.$executeRaw`
      UPDATE "Position"
      SET "yesReserved" = GREATEST(0, "yesReserved" - ${quantity}),
          "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "marketId" = ${marketId}
    `;
  } else {
    await tx.$executeRaw`
      UPDATE "Position"
      SET "noReserved" = GREATEST(0, "noReserved" - ${quantity}),
          "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "marketId" = ${marketId}
    `;
  }
}

async function applyBuy(
  tx: Tx,
  params: {
    userId: string;
    marketId: string;
    outcome: Outcome;
    quantity: number;
    ownPrice: number;
    reserveRelease: number;
    conditional: boolean;
  },
) {
  const cost = params.ownPrice * params.quantity;

  if (params.conditional) {
    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET "balance" = "balance" - ${cost},
          "updatedAt" = NOW()
      WHERE "userId" = ${params.userId}
        AND "balance" - "reserved" >= ${cost}
    `;

    if (updated === 0) {
      return false;
    }
  } else {
    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET "balance" = "balance" - ${cost},
          "reserved" = "reserved" - ${params.reserveRelease},
          "updatedAt" = NOW()
      WHERE "userId" = ${params.userId}
    `;

    if (updated === 0) {
      throw new ApiError(409, "Wallet not found");
    }
  }

  const positionId = randomUUID();

  if (params.outcome === "YES") {
    await tx.$executeRaw`
      INSERT INTO "Position" ("id", "userId", "marketId", "yesShares", "yesCost", "updatedAt")
      VALUES (${positionId}, ${params.userId}, ${params.marketId}, ${params.quantity}, ${cost}, NOW())
      ON CONFLICT ("userId", "marketId") DO UPDATE
      SET "yesShares" = "Position"."yesShares" + ${params.quantity},
          "yesCost" = "Position"."yesCost" + ${cost},
          "updatedAt" = NOW()
    `;
  } else {
    await tx.$executeRaw`
      INSERT INTO "Position" ("id", "userId", "marketId", "noShares", "noCost", "updatedAt")
      VALUES (${positionId}, ${params.userId}, ${params.marketId}, ${params.quantity}, ${cost}, NOW())
      ON CONFLICT ("userId", "marketId") DO UPDATE
      SET "noShares" = "Position"."noShares" + ${params.quantity},
          "noCost" = "Position"."noCost" + ${cost},
          "updatedAt" = NOW()
    `;
  }

  return true;
}

async function applySell(
  tx: Tx,
  params: {
    userId: string;
    marketId: string;
    outcome: Outcome;
    quantity: number;
    proceeds: number;
  },
) {
  const credited = await tx.$executeRaw`
    UPDATE "Wallet"
    SET "balance" = "balance" + ${params.proceeds},
        "updatedAt" = NOW()
    WHERE "userId" = ${params.userId}
  `;

  if (credited === 0) {
    throw new ApiError(409, "Wallet not found");
  }

  const updated =
    params.outcome === "YES"
      ? await tx.$executeRaw`
          UPDATE "Position"
          SET "yesShares" = "yesShares" - ${params.quantity},
              "yesReserved" = "yesReserved" - ${params.quantity},
              "realized" = "realized" + ${params.proceeds}::int
                - (("yesCost"::bigint * ${params.quantity}::bigint)
                    / GREATEST("yesShares", 1)::bigint)::int,
              "yesCost" = "yesCost"
                - (("yesCost"::bigint * ${params.quantity}::bigint)
                    / GREATEST("yesShares", 1)::bigint)::int,
              "updatedAt" = NOW()
          WHERE "userId" = ${params.userId}
            AND "marketId" = ${params.marketId}
            AND "yesShares" >= ${params.quantity}
        `
      : await tx.$executeRaw`
          UPDATE "Position"
          SET "noShares" = "noShares" - ${params.quantity},
              "noReserved" = "noReserved" - ${params.quantity},
              "realized" = "realized" + ${params.proceeds}::int
                - (("noCost"::bigint * ${params.quantity}::bigint)
                    / GREATEST("noShares", 1)::bigint)::int,
              "noCost" = "noCost"
                - (("noCost"::bigint * ${params.quantity}::bigint)
                    / GREATEST("noShares", 1)::bigint)::int,
              "updatedAt" = NOW()
          WHERE "userId" = ${params.userId}
            AND "marketId" = ${params.marketId}
            AND "noShares" >= ${params.quantity}
        `;

  if (updated === 0) {
    throw new ApiError(409, "Position changed; refresh and retry");
  }
}

type Party = {
  order: MatchableOrder;
  role: "maker" | "taker";
  ownPrice: number;
  isMarketTaker: boolean;
  reserveRelease: number;
};

async function applyPartyEffects(
  tx: Tx,
  party: Party,
  fill: Fill,
  marketId: string,
) {
  const { order, ownPrice } = party;
  const quantity = fill.quantity;

  if (order.action === "BUY") {
    return applyBuy(tx, {
      userId: order.userId,
      marketId,
      outcome: order.outcome,
      quantity,
      ownPrice,
      reserveRelease: party.reserveRelease * quantity,
      conditional: party.isMarketTaker,
    });
  }

  await applySell(tx, {
    userId: order.userId,
    marketId,
    outcome: order.outcome,
    quantity,
    proceeds: ownPrice * quantity,
  });

  return true;
}

async function applyFill(
  tx: Tx,
  fill: Fill,
  makeParty: (role: "maker" | "taker") => Party,
  context: { marketId: string; timestamp: Date },
) {
  const taker = makeParty("taker");
  const maker = makeParty("maker");

  // Apply the taker first: a market buy that cannot afford this level must
  // leave the book untouched, and any later failure rolls the whole
  // transaction back anyway.
  const applied = await applyPartyEffects(
    tx,
    taker,
    fill,
    context.marketId,
  );

  if (!applied) {
    return null;
  }

  await applyPartyEffects(tx, maker, fill, context.marketId);

  const trade = await tx.trade.create({
    data: {
      marketId: context.marketId,
      makerOrderId: fill.makerOrderId,
      takerOrderId: fill.takerOrderId,
      makerUserId: fill.makerUserId,
      takerUserId: fill.takerUserId,
      yesPrice: fill.yesPrice,
      quantity: fill.quantity,
      createdAt: context.timestamp,
    },
  });

  await tx.ledgerEntry.createMany({
    data: [taker, maker].map((party) => ({
      userId: party.order.userId,
      marketId: context.marketId,
      orderId: party.order.id,
      tradeId: trade.id,
      amount:
        party.order.action === "BUY"
          ? -party.ownPrice * fill.quantity
          : party.ownPrice * fill.quantity,
      type:
        party.order.action === "BUY" ? ("TRADE_BUY" as const) : ("TRADE_SELL" as const),
      createdAt: context.timestamp,
    })),
  });

  return trade;
}

export async function placeOrder(
  tx: Tx,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const now = new Date();
  const timestamp = input.timestamp ?? now;
  const price = storedPrice(input);

  if (
    !Number.isInteger(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > MAX_ORDER_QUANTITY
  ) {
    throw new ApiError(400, "Quantity is out of range");
  }

  const existing = await tx.order.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });

  if (existing) {
    const sameRequest =
      existing.marketId === input.marketId &&
      existing.outcome === input.outcome &&
      existing.action === input.action &&
      existing.type === input.type &&
      existing.price === price &&
      existing.quantity === input.quantity;

    if (!sameRequest) {
      throw new ApiError(
        409,
        "Idempotency key was already used for a different order",
      );
    }

    return replayResult(tx, existing);
  }

  await requireOpenMarket(tx, input.marketId, now);

  if (input.action === "BUY" && input.type === "LIMIT") {
    await reserveCredits(tx, input.userId, price * input.quantity);
  }

  if (input.action === "SELL") {
    await reserveShares(
      tx,
      input.userId,
      input.marketId,
      input.outcome,
      input.quantity,
    );
  }

  const order = await tx.order.create({
    data: {
      userId: input.userId,
      marketId: input.marketId,
      outcome: input.outcome,
      action: input.action,
      type: input.type,
      price,
      quantity: input.quantity,
      idempotencyKey: input.idempotencyKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });

  const restingOrders = await tx.order.findMany({
    where: {
      marketId: input.marketId,
      status: { in: ["OPEN", "PARTIAL"] },
      id: { not: order.id },
    },
    select: {
      id: true,
      userId: true,
      outcome: true,
      action: true,
      price: true,
      quantity: true,
      filledQuantity: true,
      createdAt: true,
    },
  });

  let maxTakerSpend: number | undefined;

  if (input.action === "BUY") {
    if (input.type === "MARKET") {
      const wallet = await tx.wallet.findUnique({
        where: { userId: input.userId },
        select: { balance: true, reserved: true },
      });

      if (!wallet) {
        throw new ApiError(409, "Insufficient credit balance");
      }

      maxTakerSpend = wallet.balance - wallet.reserved;
    } else {
      maxTakerSpend = price * input.quantity;
    }
  }

  const makerOrderById = new Map(
    restingOrders.map((resting) => [resting.id, resting]),
  );
  const makerFilled = new Map<string, number>();

  for (const resting of restingOrders) {
    makerFilled.set(resting.id, resting.filledQuantity);
  }

  const taker: MatchableOrder = {
    id: order.id,
    userId: input.userId,
    outcome: input.outcome,
    action: input.action,
    price,
    quantity: input.quantity,
    filledQuantity: 0,
    createdAt: timestamp,
  };

  const fills = matchOrders({
    taker,
    resting: restingOrders,
    maxTakerSpend,
  });

  let takerFilled = 0;
  const trades: Trade[] = [];

  const makeMakerParty = (fill: Fill): Party => {
    const resting = makerOrderById.get(fill.makerOrderId);

    if (!resting) {
      throw new ApiError(409, "Resting order disappeared; refresh and retry");
    }

    return {
      order: resting,
      role: "maker",
      ownPrice: fill.makerPrice,
      isMarketTaker: false,
      reserveRelease: resting.price,
    };
  };

  for (const fill of fills) {
    const maker = makerOrderById.get(fill.makerOrderId);

    if (!maker) {
      continue;
    }

    const makeParty = (role: "maker" | "taker"): Party =>
      role === "maker"
        ? makeMakerParty(fill)
        : {
            order: taker,
            role: "taker",
            ownPrice: fill.takerPrice,
            isMarketTaker: input.type === "MARKET",
            reserveRelease: price,
          };

    const trade = await applyFill(tx, fill, makeParty, {
      marketId: input.marketId,
      timestamp,
    });

    if (!trade) {
      break;
    }

    takerFilled += fill.quantity;
    makerFilled.set(
      fill.makerOrderId,
      (makerFilled.get(fill.makerOrderId) ?? 0) + fill.quantity,
    );
    trades.push(trade);
  }

  // Update maker orders once per touched order.
  for (const [makerOrderId, filled] of makerFilled) {
    const original = makerOrderById.get(makerOrderId);

    if (!original || filled === original.filledQuantity) {
      continue;
    }

    await tx.order.update({
      where: { id: makerOrderId },
      data: {
        filledQuantity: filled,
        status: filled >= original.quantity ? "FILLED" : "PARTIAL",
        updatedAt: timestamp,
      },
    });
  }

  const remaining = input.quantity - takerFilled;
  let selfCrossed = false;

  // Self-trade prevention: if the unfilled remainder would cross one of the
  // trader's own resting orders, cancel it instead of resting a crossed book.
  if (remaining > 0 && input.type === "LIMIT") {
    const takerYesPrice = yesPriceFor(input.outcome, price);
    const takerSide = bookSideFor(input.action, input.outcome);

    selfCrossed = restingOrders.some((resting) => {
      if (resting.userId !== input.userId) {
        return false;
      }

      const restingSide = bookSideFor(resting.action, resting.outcome);
      const restingYesPrice = yesPriceFor(
        resting.outcome,
        resting.price,
      );

      return (
        restingSide !== takerSide &&
        (takerSide === "LONG"
          ? restingYesPrice <= takerYesPrice
          : restingYesPrice >= takerYesPrice)
      );
    });

    if (selfCrossed) {
      if (input.action === "BUY") {
        await releaseCredits(tx, input.userId, remaining * price);
      } else {
        await releaseShares(
          tx,
          input.userId,
          input.marketId,
          input.outcome,
          remaining,
        );
      }
    }
  }

  let takerStatus: Order["status"];

  if (takerFilled >= input.quantity) {
    takerStatus = "FILLED";
  } else if (input.type === "MARKET" || selfCrossed) {
    takerStatus = "CANCELLED";
  } else if (takerFilled > 0) {
    takerStatus = "PARTIAL";
  } else {
    takerStatus = "OPEN";
  }

  if (input.action === "SELL" && input.type === "MARKET") {
    await releaseShares(
      tx,
      input.userId,
      input.marketId,
      input.outcome,
      input.quantity - takerFilled,
    );
  }

  const finalOrder =
    takerFilled > 0 || takerStatus !== "OPEN"
      ? await tx.order.update({
          where: { id: order.id },
          data: {
            filledQuantity: takerFilled,
            status: takerStatus,
            updatedAt: timestamp,
          },
        })
      : order;

  await tx.auditEvent.create({
    data: {
      userId: input.userId,
      marketId: input.marketId,
      action: "ORDER_PLACED",
      details: {
        orderId: order.id,
        outcome: input.outcome,
        action: input.action,
        type: input.type,
        price,
        quantity: input.quantity,
        filled: takerFilled,
        selfCrossed,
      },
      createdAt: timestamp,
    },
  });

  const freshWallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
    select: { balance: true, reserved: true },
  });
  const position = await tx.position.findUnique({
    where: {
      userId_marketId: { userId: input.userId, marketId: input.marketId },
    },
  });

  return {
    order: finalOrder,
    trades,
    balance: freshWallet?.balance ?? 0,
    reserved: freshWallet?.reserved ?? 0,
    position,
    replayed: false,
    selfCrossed,
  };
}

async function replayResult(
  tx: Tx,
  existing: Order,
): Promise<PlaceOrderResult> {
  const trades = await tx.trade.findMany({
    where: { takerOrderId: existing.id },
    orderBy: { createdAt: "asc" },
  });

  const wallet = await tx.wallet.findUnique({
    where: { userId: existing.userId },
    select: { balance: true, reserved: true },
  });
  const position = await tx.position.findUnique({
    where: {
      userId_marketId: {
        userId: existing.userId,
        marketId: existing.marketId,
      },
    },
  });

  return {
    order: existing,
    trades,
    balance: wallet?.balance ?? 0,
    reserved: wallet?.reserved ?? 0,
    position,
    replayed: true,
    selfCrossed: false,
  };
}

export type CancelResult = {
  order: Order;
  balance: number;
  reserved: number;
};

export async function cancelOrder(
  tx: Tx,
  params: { userId: string; orderId: string },
): Promise<CancelResult> {
  const order = await tx.order.findUnique({
    where: { id: params.orderId },
    select: {
      id: true,
      userId: true,
      marketId: true,
      outcome: true,
      action: true,
      price: true,
      quantity: true,
      filledQuantity: true,
      status: true,
    },
  });

  if (!order || order.userId !== params.userId) {
    throw new ApiError(404, "Order not found");
  }

  await lockMarket(tx, order.marketId);

  const fresh = await tx.order.findUnique({
    where: { id: order.id },
    select: {
      id: true,
      marketId: true,
      outcome: true,
      action: true,
      price: true,
      quantity: true,
      filledQuantity: true,
      status: true,
    },
  });

  if (!fresh || (fresh.status !== "OPEN" && fresh.status !== "PARTIAL")) {
    throw new ApiError(409, "Order is not open");
  }

  const remaining = fresh.quantity - fresh.filledQuantity;

  if (fresh.action === "BUY") {
    await releaseCredits(tx, params.userId, remaining * fresh.price);
  } else {
    await releaseShares(
      tx,
      params.userId,
      fresh.marketId,
      fresh.outcome,
      remaining,
    );
  }

  const cancelled = await tx.order.update({
    where: { id: fresh.id },
    data: { status: "CANCELLED" },
  });

  await tx.auditEvent.create({
    data: {
      userId: params.userId,
      marketId: fresh.marketId,
      action: "ORDER_CANCELLED",
      details: {
        orderId: fresh.id,
        remaining,
      },
    },
  });

  const wallet = await tx.wallet.findUnique({
    where: { userId: params.userId },
    select: { balance: true, reserved: true },
  });

  return {
    order: cancelled,
    balance: wallet?.balance ?? 0,
    reserved: wallet?.reserved ?? 0,
  };
}

/**
 * Cancels every resting order on a market. The caller must hold the market
 * row lock (see `lockMarket`).
 */
export async function cancelOpenOrders(
  tx: Tx,
  marketId: string,
  status: "CANCELLED" | "EXPIRED" = "EXPIRED",
) {
  const orders = await tx.order.findMany({
    where: {
      marketId,
      status: { in: ["OPEN", "PARTIAL"] },
    },
    select: {
      id: true,
      userId: true,
      outcome: true,
      action: true,
      price: true,
      quantity: true,
      filledQuantity: true,
    },
  });

  const creditsByUser = new Map<string, number>();
  const sharesByPosition = new Map<
    string,
    { userId: string; outcome: Outcome; quantity: number }
  >();

  for (const order of orders) {
    const remaining = order.quantity - order.filledQuantity;

    if (remaining <= 0) {
      continue;
    }

    if (order.action === "BUY") {
      creditsByUser.set(
        order.userId,
        (creditsByUser.get(order.userId) ?? 0) + remaining * order.price,
      );
    } else {
      const key = `${order.userId}:${order.outcome}`;
      const existing = sharesByPosition.get(key);

      if (existing) {
        existing.quantity += remaining;
      } else {
        sharesByPosition.set(key, {
          userId: order.userId,
          outcome: order.outcome,
          quantity: remaining,
        });
      }
    }
  }

  for (const [userId, amount] of creditsByUser) {
    await releaseCredits(tx, userId, amount);
  }

  for (const entry of sharesByPosition.values()) {
    await releaseShares(
      tx,
      entry.userId,
      marketId,
      entry.outcome,
      entry.quantity,
    );
  }

  if (orders.length > 0) {
    await tx.order.updateMany({
      where: { id: { in: orders.map((order) => order.id) } },
      data: { status },
    });
  }

  return orders.length;
}
