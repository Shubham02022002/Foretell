import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { closeMarket } from "@/lib/exchange/market";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return false;
  }

  const header = request.headers.get("authorization");

  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);

  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const expired = await prisma.market.findMany({
    where: { status: "OPEN", closesAt: { lte: now } },
    orderBy: { closesAt: "asc" },
    take: 50,
    select: { id: true },
  });

  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  let closed = 0;
  let cancelledOrders = 0;

  for (const market of expired) {
    const result = await prisma.$transaction(
      async (tx) => {
        try {
          return await closeMarket(tx, {
            marketId: market.id,
            adminId: admin?.id,
          });
        } catch {
          return null;
        }
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    if (result?.closed) {
      closed += 1;
      cancelledOrders += result.cancelledOrders;
    }
  }

  return NextResponse.json({
    closed,
    cancelledOrders,
    remaining: Math.max(0, expired.length - closed),
    ranAt: now.toISOString(),
  });
}
