import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import {
  getOpenOrders,
  getPortfolio,
  getPositions,
  type PortfolioSummary,
} from "@/lib/exchange/portfolio";

const querySchema = z.object({
  market: z.string().trim().min(1).max(100).optional(),
});

function summarize(
  positions: Awaited<ReturnType<typeof getPositions>>,
  orderCount: number,
): PortfolioSummary {
  const marketValue = positions.reduce(
    (sum, position) => sum + position.marketValue,
    0,
  );
  const costBasis = positions.reduce(
    (sum, position) => sum + position.costBasis,
    0,
  );

  return {
    realizedNet: positions.reduce(
      (sum, position) => sum + position.realized,
      0,
    ),
    marketValue,
    costBasis,
    unrealized: marketValue - costBasis,
    openPositions: positions.length,
    openOrders: orderCount,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsedQuery = querySchema.safeParse({
      market: request.nextUrl.searchParams.get("market") ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          error: "Invalid query parameters",
          details: parsedQuery.error.flatten(),
        },
        { status: 400 },
      );
    }

    const slug = parsedQuery.data.market;

    if (!slug) {
      const portfolio = await getPortfolio(prisma, session.user.id);
      return NextResponse.json(portfolio, { status: 200 });
    }

    const market = await prisma.market.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });

    if (!market || market.status === "DRAFT") {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const [positions, orders] = await Promise.all([
      getPositions(prisma, session.user.id, market.id),
      getOpenOrders(prisma, session.user.id, market.id),
    ]);

    return NextResponse.json(
      {
        positions,
        orders,
        summary: summarize(positions, orders.length),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Failed to fetch positions:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
