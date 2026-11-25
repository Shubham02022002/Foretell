export const SHARE_VALUE = 100;
export const MIN_PRICE = 1;
export const MAX_PRICE = SHARE_VALUE - 1;
export const MAX_ORDER_QUANTITY = 10_000;

export const MARKET_ORDER_PRICE = {
  BUY: MAX_PRICE,
  SELL: MIN_PRICE,
} as const;
