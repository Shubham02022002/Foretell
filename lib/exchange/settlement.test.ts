import { describe, expect, it } from "bun:test";
import {
  resolvePositionPayout,
  totalPairCount,
  voidPositionPayout,
  type SettleablePosition,
} from "./settlement";

const alice: SettleablePosition = {
  yesShares: 10,
  noShares: 0,
  yesCost: 600,
  noCost: 0,
};

const bob: SettleablePosition = {
  yesShares: 0,
  noShares: 10,
  yesCost: 0,
  noCost: 400,
};

describe("resolution", () => {
  it("pays 100 credits per winning share and zero to the losing side", () => {
    expect(resolvePositionPayout(alice, "YES")).toEqual({
      payout: 1000,
      realizedDelta: 400,
      winningShares: 10,
    });
    expect(resolvePositionPayout(bob, "YES")).toEqual({
      payout: 0,
      realizedDelta: -400,
      winningShares: 0,
    });
  });

  it("conserves escrow across both outcomes", () => {
    const pairs = totalPairCount([alice, bob]);

    for (const outcome of ["YES", "NO"] as const) {
      const total = [alice, bob]
        .map((position) => resolvePositionPayout(position, outcome).payout)
        .reduce((sum, payout) => sum + payout, 0);

      expect(total).toBe(pairs * 100);
    }
  });

  it("charges the losing basis against realized P&L", () => {
    const bothSides: SettleablePosition = {
      yesShares: 4,
      noShares: 6,
      yesCost: 240,
      noCost: 300,
    };

    const result = resolvePositionPayout(bothSides, "NO");

    expect(result.payout).toBe(600);
    expect(result.realizedDelta).toBe(60);
  });
});

describe("void", () => {
  it("unwinds YES and NO at complementary prices", () => {
    expect(voidPositionPayout(alice, 62).payout).toBe(620);
    expect(voidPositionPayout(bob, 62).payout).toBe(380);
  });

  it("conserves escrow at any unwind price", () => {
    const pairs = totalPairCount([alice, bob]);

    for (const price of [1, 25, 50, 62, 99]) {
      const total =
        voidPositionPayout(alice, price).payout +
        voidPositionPayout(bob, price).payout;

      expect(total).toBe(pairs * 100);
    }
  });

  it("realizes the difference between unwind value and cost", () => {
    expect(voidPositionPayout(alice, 50).realizedDelta).toBe(-100);
    expect(voidPositionPayout(bob, 50).realizedDelta).toBe(100);
  });
});
