import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getMarketSnapshot } from "@/lib/exchange/market";
import { marketParamsSchema } from "@/lib/validations/market";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  try {
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
      select: {
        id: true,
        slug: true,
        question: true,
        status: true,
        closesAt: true,
      },
    });

    if (!market || market.status === "DRAFT") {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const snapshot = await getMarketSnapshot(prisma, market.id);

    return NextResponse.json(
      {
        market: {
          slug: market.slug,
          question: market.question,
          status: market.status,
          closesAt: market.closesAt,
        },
        book: snapshot.book,
        stats: snapshot.stats,
        trades: snapshot.trades,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Failed to fetch market book:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
