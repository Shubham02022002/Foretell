import { NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { cancelUserOrders } from "@/lib/exchange/orders";
import { marketParamsSchema } from "@/lib/validations/market";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = rateLimit(`cancel-all:${session.user.id}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return rateLimitResponse(limit.retryAfterSeconds);
  }

  const parsedParams = marketParamsSchema.safeParse(await params);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid URL parameters" },
      { status: 400 },
    );
  }

  try {
    const market = await prisma.market.findUnique({
      where: { slug: parsedParams.data.slug },
      select: { id: true },
    });

    if (!market) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const result = await prisma.$transaction(
      (tx) =>
        cancelUserOrders(tx, {
          userId: session.user.id,
          marketId: market.id,
        }),
      { maxWait: 10_000, timeout: 15_000 },
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }

    console.error("Failed to cancel all orders:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
