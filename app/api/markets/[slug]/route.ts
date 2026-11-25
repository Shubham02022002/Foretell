import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { getMarketStatsMap } from "@/lib/exchange/market";
import { marketParamsSchema } from "@/lib/validations/market";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const rawParams = await params;
    const result = marketParamsSchema.safeParse(rawParams);

    if (!result.success) {
      return NextResponse.json(
        {
          error: "Invalid URL parameters",
          details: result.error.format(),
        },
        { status: 400 },
      );
    }

    const { slug } = result.data;

    const market = await prisma.market.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        question: true,
        description: true,
        rules: true,
        category: true,
        status: true,
        closesAt: true,
        createdAt: true,
        resolution: {
          select: {
            outcome: true,
            notes: true,
            evidenceUrl: true,
            resolvedAt: true,
          },
        },
      },
    });

    if (!market || market.status === "DRAFT") {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const session = await auth();
    let watched = false;

    if (session?.user?.id) {
      const watch = await prisma.watchlist.findUnique({
        where: {
          userId_marketId: {
            userId: session.user.id,
            marketId: market.id,
          },
        },
        select: { id: true },
      });
      watched = Boolean(watch);
    }

    const statsByMarket = await getMarketStatsMap(prisma, [market.id]);
    const stats = statsByMarket.get(market.id);

    return NextResponse.json(
      {
        market: { ...market, watched },
        stats: stats ?? null,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Failed to fetch market:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
