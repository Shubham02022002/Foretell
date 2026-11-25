import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getMarketCandles } from "@/lib/exchange/market";
import { marketParamsSchema } from "@/lib/validations/market";
import { candleQuerySchema } from "@/lib/validations/order";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const rawParams = await params;
    const parsedParams = marketParamsSchema.safeParse(rawParams);

    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid URL parameters" },
        { status: 400 },
      );
    }

    const parsedQuery = candleQuerySchema.safeParse({
      range: request.nextUrl.searchParams.get("range") ?? undefined,
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

    const market = await prisma.market.findUnique({
      where: { slug: parsedParams.data.slug },
      select: { id: true, status: true },
    });

    if (!market || market.status === "DRAFT") {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const result = await getMarketCandles(
      prisma,
      market.id,
      parsedQuery.data.range,
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Failed to fetch market candles:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
