import "dotenv/config";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { INITIAL_CREDITS } from "../lib/credits";
import { closeMarket, resolveMarket } from "../lib/exchange/market";
import { placeOrder } from "../lib/exchange/orders";
import { MAX_PRICE, MIN_PRICE } from "../lib/exchange/constants";

const DEV_PASSWORD = "password123";
const LIQUIDITY_BALANCE = 100_000;
const SEED_TRADE_COUNT = 10;
const SEED_DAYS = 7;

const userSeeds = [
  { email: "admin@example.com", name: "Market Admin", role: "ADMIN" as const },
  { email: "alice@example.com", name: "Alice", role: "USER" as const },
  { email: "bob@example.com", name: "Bob", role: "USER" as const },
  { email: "charlie@example.com", name: "Charlie", role: "USER" as const },
  { email: "dana@example.com", name: "Dana", role: "USER" as const },
  { email: "erin@example.com", name: "Erin", role: "USER" as const },
];

type MarketSeed = {
  slug: string;
  question: string;
  description: string;
  rules: string;
  category: string;
  closesAt: Date;
  mid: number;
  resolution?: "YES" | "NO";
};

const marketSeeds: MarketSeed[] = [
  {
    slug: "claude-next-model-2026",
    question:
      "Will Anthropic announce a new flagship Claude model before 2027?",
    description:
      "A live market about Anthropic's next flagship model, with a seeded order book.",
    rules:
      "Resolve YES if an official announcement is made before the closing date.",
    category: "AI Models",
    closesAt: new Date("2026-12-15T18:00:00Z"),
    mid: 62,
  },
  {
    slug: "openai-flagship-2026",
    question: "Will OpenAI announce another flagship model before 2027?",
    description: "Track official announcements from OpenAI.",
    rules:
      "Resolve YES only when OpenAI officially announces a new flagship model before closing.",
    category: "AI Models",
    closesAt: new Date("2026-12-20T18:00:00Z"),
    mid: 48,
  },
  {
    slug: "coding-agent-benchmark-2026",
    question:
      "Will an AI coding agent exceed 80% on SWE-bench Verified by year-end 2026?",
    description: "A live market about AI coding-agent benchmark performance.",
    rules:
      "Use a published benchmark result with a clearly identified agent and evaluation setup.",
    category: "AI Benchmarks",
    closesAt: new Date("2026-12-31T18:00:00Z"),
    mid: 71,
  },
  {
    slug: "gemini-4-release-2026",
    question: "Will Google release Gemini 4 before 2027?",
    description:
      "A live market about the next Gemini flagship release and its timing.",
    rules:
      "Resolve YES if Google publicly announces general availability of Gemini 4 before the closing date.",
    category: "AI Models",
    closesAt: new Date("2026-12-28T18:00:00Z"),
    mid: 35,
  },
  {
    slug: "agentic-coding-benchmark-2025",
    question:
      "Did any coding agent finish above 70% on a public agentic benchmark in 2025?",
    description:
      "A resolved fixture used to exercise settlement, payouts, and history.",
    rules:
      "Resolve YES if a published 2025 result reports above 70% on a public agentic coding benchmark.",
    category: "AI Benchmarks",
    closesAt: new Date("2026-12-05T18:00:00Z"),
    mid: 58,
    resolution: "YES",
  },
];

const liquiditySizes = [80, 120, 160, 200];

function clampPrice(price: number) {
  return Math.min(MAX_PRICE, Math.max(MIN_PRICE, price));
}

function traderFor(index: number, traders: { id: string }[]) {
  return traders[index % traders.length];
}

async function ensureUsers() {
  const devPasswordHash = await bcrypt.hash(DEV_PASSWORD, 12);

  return prisma.$transaction(
    async (tx) => {
      const users = new Map<string, { id: string }>();

      for (const seed of userSeeds) {
        let user = await tx.user.findUnique({
          where: { email: seed.email },
          select: { id: true, passwordHash: true },
        });

        if (!user) {
          user = await tx.user.create({
            data: {
              email: seed.email,
              name: seed.name,
              role: seed.role,
              passwordHash: devPasswordHash,
            },
            select: { id: true, passwordHash: true },
          });
        } else if (!user.passwordHash) {
          await tx.user.update({
            where: { id: user.id },
            data: { passwordHash: devPasswordHash },
          });
        }

        users.set(seed.email, user);

        const wallet = await tx.wallet.findUnique({
          where: { userId: user.id },
          select: { balance: true, reserved: true },
        });

        if (!wallet) {
          const opening =
            seed.role === "ADMIN" ? INITIAL_CREDITS : LIQUIDITY_BALANCE;

          await tx.wallet.create({
            data: { userId: user.id, balance: opening },
          });
          await tx.ledgerEntry.create({
            data: {
              userId: user.id,
              amount: opening,
              type: "INITIAL_CREDIT",
            },
          });
        } else if (seed.role !== "ADMIN") {
          const available = wallet.balance - wallet.reserved;

          if (available < LIQUIDITY_BALANCE / 2) {
            const topUp = LIQUIDITY_BALANCE - available;

            await tx.wallet.update({
              where: { userId: user.id },
              data: { balance: { increment: topUp } },
            });
            await tx.ledgerEntry.create({
              data: {
                userId: user.id,
                amount: topUp,
                type: "ADMIN_ADJUSTMENT",
              },
            });
          }
        }
      }

      return users;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

async function ensureMarkets(adminId: string) {
  const markets = new Map<string, { id: string; status: string }>();

  for (const seed of marketSeeds) {
    const market = await prisma.market.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        question: seed.question,
        description: seed.description,
        rules: seed.rules,
        category: seed.category,
        status: "OPEN",
        closesAt: seed.closesAt,
      },
      update: {},
      select: { id: true, status: true },
    });

    markets.set(seed.slug, market);

    const auditEvent = await prisma.auditEvent.findFirst({
      where: {
        marketId: market.id,
        userId: adminId,
        action: "MARKET_SEEDED",
      },
      select: { id: true },
    });

    if (!auditEvent) {
      await prisma.auditEvent.create({
        data: {
          userId: adminId,
          marketId: market.id,
          action: "MARKET_SEEDED",
          details: { source: "development-seed" },
        },
      });
    }
  }

  return markets;
}

async function seedOrderBook(params: {
  market: MarketSeed;
  marketId: string;
  traders: { id: string }[];
}) {
  const { market, marketId, traders } = params;

  const now = Date.now();
  const start = now - SEED_DAYS * 24 * 60 * 60 * 1000;
  const mid = market.mid;
  let didWork = false;

  const orderCount = await prisma.order.count({ where: { marketId } });

  // 1. Resting depth: YES bids below the mid, NO bids that imply YES asks
  //    above the mid. Both sides are funded limit orders.
  if (orderCount === 0) {
    await prisma.$transaction(
      async (tx) => {
        for (let level = 0; level < liquiditySizes.length; level += 1) {
          const size = liquiditySizes[level];
          const bidUser = traderFor(level, traders);
          const askUser = traderFor(level + 2, traders);
          const bidPrice = clampPrice(mid - 1 - level);
          const askYesPrice = clampPrice(mid + 1 + level);
          const askNoPrice = clampPrice(100 - askYesPrice);

          await placeOrder(tx, {
            userId: bidUser.id,
            marketId,
            outcome: "YES",
            action: "BUY",
            type: "LIMIT",
            price: bidPrice,
            quantity: size,
            idempotencyKey: `seed-${market.slug}-bid-${level}`,
            timestamp: new Date(start + level * 1_000),
          });

          await placeOrder(tx, {
            userId: askUser.id,
            marketId,
            outcome: "NO",
            action: "BUY",
            type: "LIMIT",
            price: askNoPrice,
            quantity: size,
            idempotencyKey: `seed-${market.slug}-ask-${level}`,
            timestamp: new Date(start + 10_000 + level * 1_000),
          });
        }
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
    didWork = true;
  }

  const tradeCount = await prisma.trade.count({ where: { marketId } });

  // 2. Backdated market orders so the chart has OHLC and volume.
  if (tradeCount === 0) {
    await prisma.$transaction(
      async (tx) => {
        for (let index = 0; index < SEED_TRADE_COUNT; index += 1) {
          const user = traderFor(index + 1, traders);
          const outcome = index % 3 === 2 ? "NO" : "YES";
          const quantity = 5 + ((index * 7) % 11);
          const at =
            start +
            60 * 60 * 1000 +
            Math.floor(
              ((SEED_DAYS * 24 - 2) * 60 * 60 * 1000 * index) /
                SEED_TRADE_COUNT,
            );

          await placeOrder(tx, {
            userId: user.id,
            marketId,
            outcome,
            action: "BUY",
            type: "MARKET",
            quantity,
            idempotencyKey: `seed-${market.slug}-trade-${index}`,
            timestamp: new Date(at),
          });
        }
      },
      { maxWait: 10_000, timeout: 300_000 },
    );
    didWork = true;
  }

  return didWork;
}

async function settleFixture(params: {
  market: MarketSeed;
  marketId: string;
  adminId: string;
}) {
  const { market, marketId, adminId } = params;

  if (!market.resolution) {
    return;
  }

  const current = await prisma.market.findUnique({
    where: { id: marketId },
    select: { status: true },
  });

  if (!current || current.status === "RESOLVED" || current.status === "VOID") {
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      if (current.status === "OPEN") {
        await closeMarket(tx, { marketId, adminId });
      }

      await resolveMarket(tx, {
        marketId,
        adminId,
        outcome: market.resolution!,
        notes: "Development fixture resolved by the seed.",
        evidenceUrl: "https://example.com/benchmarks",
      });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

async function main() {
  const users = await ensureUsers();
  const admin = users.get("admin@example.com");

  if (!admin) {
    throw new Error("Seed admin was not created");
  }

  const traders = userSeeds
    .filter((seed) => seed.role === "USER")
    .map((seed) => users.get(seed.email))
    .filter((user): user is { id: string } => Boolean(user));

  const markets = await ensureMarkets(admin.id);

  for (const market of marketSeeds) {
    const stored = markets.get(market.slug);

    if (!stored) {
      throw new Error(`Market ${market.slug} was not created`);
    }

    if (stored.status === "OPEN") {
      const seeded = await seedOrderBook({
        market,
        marketId: stored.id,
        traders,
      });

      if (seeded) {
        console.log(`Seeded book and trades for ${market.slug}`);
      }
    }

    await settleFixture({
      market,
      marketId: stored.id,
      adminId: admin.id,
    });
  }

  console.log("Development seed completed successfully.");
  console.log(`Seed accounts use password: ${DEV_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error("Development seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
