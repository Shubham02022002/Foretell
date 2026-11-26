import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { requireAdmin } from "@/lib/auth/authorization";
import prisma from "@/lib/prisma";
import { voidMarket } from "@/lib/exchange/market";
import {
  marketParamsSchema,
  marketVoidSchema,
} from "@/lib/validations/market";

export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
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

  let requestBody: unknown = {};

  try {
    const text = await request.text();
    requestBody = text.trim() ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON in request body" },
      { status: 400 },
    );
  }

  const bodyResult = marketVoidSchema.safeParse(requestBody);

  if (!bodyResult.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        details: bodyResult.error.flatten(),
      },
      { status: 400 },
    );
  }

  const { slug } = paramsResult.data;
  const { notes } = bodyResult.data;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const market = await tx.market.findUnique({
          where: { slug },
          select: { id: true },
        });

        if (!market) {
          throw new ApiError(404, "Market not found");
        }

        const refund = await voidMarket(tx, {
          marketId: market.id,
          adminId: admin.userId,
          notes: notes ?? null,
        });

        return {
          market: { slug, status: "VOID" as const },
          refund,
        };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }

    console.error("Failed to void market:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
