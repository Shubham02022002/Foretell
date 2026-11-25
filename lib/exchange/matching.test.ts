import { describe, expect, it } from "bun:test";
import {
  aggregateBook,
  bookSideFor,
  matchOrders,
  normalizeOrder,
  releaseCostBasis,
  yesPriceFor,
  type MatchableOrder,
} from "./matching";

function order(
  overrides: Partial<MatchableOrder> & Pick<MatchableOrder, "id" | "userId">,
): MatchableOrder {
  return {
    outcome: "YES",
    action: "BUY",
    price: 50,
    quantity: 10,
    filledQuantity: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("order normalization", () => {
  it("maps all four order types onto long/short YES exposure", () => {
    expect(bookSideFor("BUY", "YES")).toBe("LONG");
    expect(bookSideFor("SELL", "NO")).toBe("LONG");
    expect(bookSideFor("SELL", "YES")).toBe("SHORT");
    expect(bookSideFor("BUY", "NO")).toBe("SHORT");

    expect(yesPriceFor("YES", 60)).toBe(60);
    expect(yesPriceFor("NO", 40)).toBe(60);
  });

  it("keeps remaining quantity", () => {
    const normalized = normalizeOrder(
      order({ id: "o1", userId: "u1", quantity: 10, filledQuantity: 4 }),
    );
    expect(normalized.remaining).toBe(6);
  });
});

describe("matching", () => {
  it("executes a YES buyer against the best YES ask at the maker price", () => {
    const fills = matchOrders({
      taker: order({ id: "taker", userId: "buyer", price: 62 }),
      resting: [
        order({
          id: "ask-60",
          userId: "seller",
          action: "SELL",
          price: 60,
        }),
        order({
          id: "ask-61",
          userId: "seller",
          action: "SELL",
          price: 61,
        }),
      ],
    });

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      makerOrderId: "ask-60",
      yesPrice: 60,
      makerPrice: 60,
      takerPrice: 60,
      quantity: 10,
    });
  });

  it("sweeps multiple levels in price order and partially fills", () => {
    const fills = matchOrders({
      taker: order({
        id: "taker",
        userId: "buyer",
        price: 99,
        quantity: 25,
      }),
      resting: [
        order({
          id: "ask-61",
          userId: "seller-a",
          action: "SELL",
          price: 61,
          quantity: 10,
        }),
        order({
          id: "ask-60",
          userId: "seller-b",
          action: "SELL",
          price: 60,
          quantity: 10,
        }),
      ],
    });

    expect(fills.map((fill) => fill.makerOrderId)).toEqual([
      "ask-60",
      "ask-61",
    ]);
    expect(fills.map((fill) => fill.quantity)).toEqual([10, 10]);
    expect(fills.every((fill) => fill.takerPrice === fill.yesPrice)).toBe(true);
  });

  it("mints a pair when a YES buyer crosses a NO buyer", () => {
    // NO bid 45 => short YES at 55. YES bid 60 crosses it.
    const fills = matchOrders({
      taker: order({
        id: "yes-buyer",
        userId: "alice",
        price: 60,
        quantity: 5,
      }),
      resting: [
        order({
          id: "no-buyer",
          userId: "bob",
          outcome: "NO",
          action: "BUY",
          price: 45,
          quantity: 5,
        }),
      ],
    });

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      yesPrice: 55,
      makerPrice: 45,
      takerPrice: 55,
      quantity: 5,
    });
  });

  it("matches a SELL NO against a YES ask as a pair merge", () => {
    // SELL NO at 40 => long YES at 60; resting YES ask at 58.
    const fills = matchOrders({
      taker: order({
        id: "no-seller",
        userId: "carol",
        outcome: "NO",
        action: "SELL",
        price: 40,
        quantity: 5,
      }),
      resting: [
        order({
          id: "yes-ask",
          userId: "dave",
          action: "SELL",
          price: 58,
          quantity: 5,
        }),
      ],
    });

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      yesPrice: 58,
      makerPrice: 58,
      takerPrice: 42,
      quantity: 5,
    });
  });

  it("does not cross orders that miss the limit", () => {
    const fills = matchOrders({
      taker: order({ id: "taker", userId: "buyer", price: 55 }),
      resting: [
        order({
          id: "ask-56",
          userId: "seller",
          action: "SELL",
          price: 56,
        }),
      ],
    });

    expect(fills).toHaveLength(0);
  });

  it("prioritises older orders at the same price", () => {
    const fills = matchOrders({
      taker: order({ id: "taker", userId: "buyer", price: 99 }),
      resting: [
        order({
          id: "newer",
          userId: "seller-a",
          action: "SELL",
          price: 60,
          createdAt: new Date("2026-01-02T00:00:00Z"),
        }),
        order({
          id: "older",
          userId: "seller-b",
          action: "SELL",
          price: 60,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }),
      ],
    });

    expect(fills[0].makerOrderId).toBe("older");
  });

  it("never self-matches", () => {
    const fills = matchOrders({
      taker: order({ id: "taker", userId: "same", price: 99 }),
      resting: [
        order({
          id: "own",
          userId: "same",
          action: "SELL",
          price: 50,
        }),
      ],
    });

    expect(fills).toHaveLength(0);
  });

  it("caps a market buyer by available spend", () => {
    const fills = matchOrders({
      taker: order({
        id: "taker",
        userId: "buyer",
        price: 99,
        quantity: 100,
      }),
      resting: [
        order({
          id: "ask",
          userId: "seller",
          action: "SELL",
          price: 50,
          quantity: 100,
        }),
      ],
      maxTakerSpend: 120,
    });

    expect(fills).toHaveLength(1);
    expect(fills[0].quantity).toBe(2);
  });
});

describe("book aggregation", () => {
  it("groups long orders as bids and short orders as asks", () => {
    const book = aggregateBook([
      order({ id: "b1", userId: "a", price: 48, quantity: 10 }),
      order({
        id: "b2",
        userId: "b",
        outcome: "NO",
        action: "SELL",
        price: 50, // long at YES 50
        quantity: 5,
      }),
      order({
        id: "a1",
        userId: "c",
        action: "SELL",
        price: 52,
        quantity: 7,
      }),
      order({
        id: "a2",
        userId: "d",
        outcome: "NO",
        action: "BUY",
        price: 45, // short at YES 55
        quantity: 3,
      }),
    ]);

    expect(book.bids).toEqual([
      { price: 50, size: 5 },
      { price: 48, size: 10 },
    ]);
    expect(book.asks).toEqual([
      { price: 52, size: 7 },
      { price: 55, size: 3 },
    ]);
    expect(book.bestBid).toBe(50);
    expect(book.bestAsk).toBe(52);
    expect(book.spread).toBe(2);
  });
});

describe("cost basis", () => {
  it("releases basis proportionally and never exceeds it", () => {
    expect(releaseCostBasis(600, 10, 3)).toBe(180);
    expect(releaseCostBasis(999, 3, 1)).toBe(333);
    expect(releaseCostBasis(50, 0, 1)).toBe(0);
  });
});
