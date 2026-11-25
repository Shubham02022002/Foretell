import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getLatestPrices } from "@/lib/exchange/portfolio";
import { getTraderStandings } from "@/lib/leaderboard";
import { SHARE_VALUE } from "@/lib/exchange/constants";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const traderParamsSchema = z.object({
  id: z.uuid(),
});

const RECENT_POSITION_LIMIT = 20;

export async function GET(_request: Request, { params }: RouteContext) {
  const paramsResult = traderParamsSchema.safeParse(await params);

  if (!paramsResult.success) {
    return NextResponse.json({ error: "Trader not found" }, { status: 404 });
  }

  const { id } = paramsResult.data;

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, image: true, createdAt: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Trader not found" }, { status: 404 });
    }

    const [standings, openPositions, positions] = await Promise.all([
      getTraderStandings("all"),
      prisma.position.count({
        where: {
          userId: id,
          market: { status: "OPEN" },
          OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }],
        },
      }),
      prisma.position.findMany({
        where: {
          userId: id,
          OR: [
            { yesShares: { gt: 0 } },
            { noShares: { gt: 0 } },
            { realized: { not: 0 } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: RECENT_POSITION_LIMIT,
        select: {
          id: true,
          marketId: true,
          yesShares: true,
          noShares: true,
          yesCost: true,
          noCost: true,
          realized: true,
          updatedAt: true,
          market: {
            select: {
              slug: true,
              question: true,
              category: true,
              status: true,
              closesAt: true,
            },
          },
        },
      }),
    ]);

    const prices = await getLatestPrices(
      prisma,
      positions.map((position) => position.marketId),
    );

    const mappedPositions = positions.map((position) => {
      const markPrice = prices.get(position.marketId) ?? null;
      const marketValue =
        markPrice === null
          ? 0
          : position.yesShares * markPrice +
            position.noShares * (SHARE_VALUE - markPrice);

      return {
        id: position.id,
        market: position.market,
        yesShares: position.yesShares,
        noShares: position.noShares,
        yesCost: position.yesCost,
        noCost: position.noCost,
        avgYesPrice:
          position.yesShares > 0
            ? Number((position.yesCost / position.yesShares).toFixed(2))
            : null,
        avgNoPrice:
          position.noShares > 0
            ? Number((position.noCost / position.noShares).toFixed(2))
            : null,
        realized: position.realized,
        markPrice,
        marketValue,
        updatedAt: position.updatedAt,
      };
    });

    const rank = standings.findIndex((entry) => entry.userId === id);

    if (rank < 0) {
      return NextResponse.json({
        trader: {
          id: user.id,
          name: user.name,
          image: user.image,
          memberSince: user.createdAt,
          stats: {
            net: 0,
            volume: 0,
            bets: 0,
            wins: 0,
            openPositions,
            rank: null,
          },
        },
        positions: mappedPositions,
      });
    }

    const standing = standings[rank];

    return NextResponse.json({
      trader: {
        id: user.id,
        name: user.name,
        image: user.image,
        memberSince: user.createdAt,
        stats: {
          net: standing.net,
          volume: standing.volume,
          bets: standing.bets,
          wins: standing.wins,
          openPositions,
          rank: rank + 1,
        },
      },
      positions: mappedPositions,
    });
  } catch (error) {
    console.error("Failed to fetch trader:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
