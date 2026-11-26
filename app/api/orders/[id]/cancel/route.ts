import { NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { cancelOrder } from "@/lib/exchange/orders";
import { orderIdParamsSchema } from "@/lib/validations/order";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = rateLimit(`cancel:${session.user.id}`, {
    limit: 20,
    windowMs: 60_000,
  });

  if (!limit.ok) {
    return rateLimitResponse(limit.retryAfterSeconds);
  }

  const rawParams = await params;
  const parsedParams = orderIdParamsSchema.safeParse(rawParams);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid URL parameters" },
      { status: 400 },
    );
  }

  try {
    const result = await prisma.$transaction(
      (tx) =>
        cancelOrder(tx, {
          userId: session.user.id,
          orderId: parsedParams.data.id,
        }),
      { maxWait: 10_000, timeout: 15_000 },
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }

    console.error("Failed to cancel order:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
