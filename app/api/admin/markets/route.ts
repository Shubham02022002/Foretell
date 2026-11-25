import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/authorization";
import prisma from "@/lib/prisma";
import { getMarketStatsMap } from "@/lib/exchange/market";
import { marketQuerySchema } from "@/lib/validations/market";

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();

  if (!admin.ok) {
    return NextResponse.json(
      { error: admin.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: admin.status },
    );
  }

  const result = marketQuerySchema.safeParse({
    status: request.nextUrl.searchParams.get("status") ?? undefined,
    category: request.nextUrl.searchParams.get("category") ?? undefined,
    page: request.nextUrl.searchParams.get("page") ?? undefined,
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });

  if (!result.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: result.error.flatten() },
      { status: 400 },
    );
  }

  const { status, category, page, limit } = result.data;
  const where = { status, category };

  try {
    const [markets, totalMarkets] = await Promise.all([
      prisma.market.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          slug: true,
          question: true,
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
      }),
      prisma.market.count({ where }),
    ]);

    const marketIds = markets.map((market) => market.id);
    const statsByMarket = await getMarketStatsMap(prisma, marketIds);

    const marketsWithStats = markets.map((market) => ({
      ...market,
      stats: statsByMarket.get(market.id) ?? null,
    }));

    return NextResponse.json({
      markets: marketsWithStats,
      pagination: {
        page,
        limit,
        totalMarkets,
        totalPages: Math.ceil(totalMarkets / limit),
      },
    });
  } catch (error) {
    console.error("Failed to fetch admin markets:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
