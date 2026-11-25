import type { Outcome } from "@/app/generated/prisma/enums";
import { SHARE_VALUE } from "./constants";

export type SettleablePosition = {
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
};

export type PositionSettlement = {
  payout: number;
  realizedDelta: number;
  winningShares: number;
};

/**
 * At resolution the winning side receives the full share value and the losing
 * side expires worthless. Realized P&L compares the payout with the total cost
 * basis carried on both sides of the position.
 */
export function resolvePositionPayout(
  position: SettleablePosition,
  outcome: Outcome,
  shareValue = SHARE_VALUE,
): PositionSettlement {
  const winningShares =
    outcome === "YES" ? position.yesShares : position.noShares;
  const payout = winningShares * shareValue;

  return {
    payout,
    realizedDelta: payout - position.yesCost - position.noCost,
    winningShares,
  };
}

/**
 * A voided market unwinds every outstanding share at the last traded YES
 * price. A YES share is worth `lastYesPrice`; a NO share is worth the
 * complement. Exactly 100 credits per matched pair leave escrow, so the
 * unwind is conserved.
 */
export function voidPositionPayout(
  position: SettleablePosition,
  lastYesPrice: number,
  shareValue = SHARE_VALUE,
) {
  const payout =
    position.yesShares * lastYesPrice +
    position.noShares * (shareValue - lastYesPrice);

  return {
    payout,
    realizedDelta: payout - position.yesCost - position.noCost,
  };
}

export function totalPairCount(positions: SettleablePosition[]) {
  return positions.reduce(
    (sum, position) => sum + position.yesShares,
    0,
  );
}
