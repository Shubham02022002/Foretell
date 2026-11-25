import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { requireAdmin } from "@/lib/auth/authorization";
import prisma from "@/lib/prisma";
import { closeMarket } from "@/lib/exchange/market";
import { marketParamsSchema } from "@/lib/validations/market";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const admin = await requireAdmin();

  if (!admin.ok) {
    return NextResponse.json(
      { error: admin.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: admin.status },
    );
  }

  const paramsResult = marketParamsSchema.safeParse(await params);

  if (!paramsResult.success) {
    return NextResponse.json(
      { error: "Invalid URL parameters" },
      { status: 400 },
    );
  }

  const { slug } = paramsResult.data;

  try {
    const market = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.market.findUnique({
          where: { slug },
          select: { id: true },
        });

        if (!existing) {
          throw new ApiError(404, "Market not found");
        }

        const result = await closeMarket(tx, {
          marketId: existing.id,
          adminId: admin.userId,
        });

        return {
          slug,
          status: "CLOSED" as const,
          cancelledOrders: result.cancelledOrders,
        };
      },
      { maxWait: 10_000, timeout: 15_000 },
    );

    return NextResponse.json({ market });
  } catch (error) {
    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }

    console.error("Failed to close market:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
