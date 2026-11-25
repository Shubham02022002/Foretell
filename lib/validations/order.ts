import { z } from "zod";
import {
  OrderAction,
  OrderStatus,
  OrderType,
  Outcome,
} from "@/app/generated/prisma/enums";
import { MAX_ORDER_QUANTITY, MAX_PRICE, MIN_PRICE } from "@/lib/exchange/constants";

export const orderPlacementSchema = z
  .object({
    outcome: z.enum(Outcome),
    action: z.enum(OrderAction),
    type: z.enum(OrderType).default("LIMIT"),
    price: z.number().int().min(MIN_PRICE).max(MAX_PRICE).optional(),
    quantity: z.number().int().positive().max(MAX_ORDER_QUANTITY),
    idempotencyKey: z
      .string()
      .trim()
      .min(8, "Idempotency key is too short")
      .max(100, "Idempotency key is too long"),
  })
  .refine(
    (data) => data.type === "MARKET" || data.price !== undefined,
    {
      message: "A limit price is required for limit orders",
      path: ["price"],
    },
  );

export const orderListQuerySchema = z.object({
  status: z.enum(OrderStatus).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const orderIdParamsSchema = z.object({
  id: z.uuid(),
});

export const candleQuerySchema = z.object({
  range: z.enum(["1H", "1D", "1W", "1M", "ALL"]).default("1D"),
});

export type OrderPlacement = z.infer<typeof orderPlacementSchema>;
