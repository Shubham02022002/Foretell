import { NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { getOpenOrders } from "@/lib/exchange/portfolio";
import { placeOrder, type PlaceOrderInput } from "@/lib/exchange/orders";
import { marketParamsSchema } from "@/lib/validations/market";
import { orderPlacementSchema } from "@/lib/validations/order";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawParams = await params;
    const parsedParams = marketParamsSchema.safeParse(rawParams);

    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid URL parameters" },
        { status: 400 },
      );
    }

    const market = await prisma.market.findUnique({
      where: { slug: parsedParams.data.slug },
      select: { id: true, status: true },
    });

    if (!market || market.status === "DRAFT") {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const orders = await getOpenOrders(prisma, session.user.id, market.id);

    return NextResponse.json({ orders }, { status: 200 });
  } catch (error) {
    console.error("Failed to fetch orders:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = rateLimit(`orders:${session.user.id}`, {
    limit: 30,
    windowMs: 60_000,
  });

  if (!limit.ok) {
    return rateLimitResponse(limit.retryAfterSeconds);
  }

  const rawParams = await params;
  const parsedParams = marketParamsSchema.safeParse(rawParams);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid URL parameters" },
      { status: 400 },
    );
  }

  let requestBody: unknown;

  try {
    requestBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON in request body" },
      { status: 400 },
    );
  }

  const parsedBody = orderPlacementSchema.safeParse(requestBody);

  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        details: parsedBody.error.flatten(),
      },
      { status: 400 },
    );
  }

  try {
    const market = await prisma.market.findUnique({
      where: { slug: parsedParams.data.slug },
      select: { id: true, status: true, closesAt: true },
    });

    if (!market || market.status === "DRAFT") {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    if (
      market.status !== "OPEN" ||
      market.closesAt.getTime() <= Date.now()
    ) {
      return NextResponse.json(
        { error: "Market is not open for trading" },
        { status: 409 },
      );
    }

    const input: PlaceOrderInput = {
      userId: session.user.id,
      marketId: market.id,
      outcome: parsedBody.data.outcome,
      action: parsedBody.data.action,
      type: parsedBody.data.type,
      price: parsedBody.data.price,
      quantity: parsedBody.data.quantity,
      idempotencyKey: parsedBody.data.idempotencyKey,
    };

    const result = await prisma.$transaction(
      (tx) => placeOrder(tx, input),
      TRANSACTION_OPTIONS,
    );

    return NextResponse.json(
      {
        order: result.order,
        fills: result.trades,
        balance: result.balance,
        reserved: result.reserved,
        position: result.position,
        replayed: result.replayed,
        selfCrossed: result.selfCrossed,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Duplicate order request; refresh and retry" },
        { status: 409 },
      );
    }

    console.error("Failed to place order:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
