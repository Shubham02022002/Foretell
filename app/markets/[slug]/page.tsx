"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StatusPill } from "@/components/market-ui";
import { MarketDiscussion } from "@/components/market-discussion";
import {
  OrderBook,
  TradeTape,
  type BookData,
  type BookView,
  type TradeTapeItem,
} from "@/components/order-book";
import {
  PriceChart,
  type CandleInput,
  type ChartMode,
  type ChartRange,
} from "@/components/probability-chart";
import { formatCents, formatCredits, formatDate } from "@/lib/format";

type MarketDetail = {
  id: string;
  slug: string;
  question: string;
  description: string | null;
  rules: string | null;
  category: string;
  status: string;
  closesAt: string;
  createdAt: string;
  watched?: boolean;
  resolution: {
    outcome: "YES" | "NO";
    notes: string | null;
    evidenceUrl: string | null;
    resolvedAt: string;
  } | null;
};

type MarketStats = {
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  volume24h: number;
  trades24h: number;
  high24h: number | null;
  low24h: number | null;
  openInterest: number;
  change24h: number | null;
  spark: number[];
};

type Outcome = "YES" | "NO";
type Action = "BUY" | "SELL";
type OrderType = "LIMIT" | "MARKET";

type Position = {
  id: string;
  yesShares: number;
  noShares: number;
  yesReserved: number;
  noReserved: number;
  avgYesPrice: number | null;
  avgNoPrice: number | null;
  markPrice: number | null;
  marketValue: number;
  costBasis: number;
  unrealized: number;
};

type OpenOrder = {
  id: string;
  outcome: Outcome;
  action: Action;
  type: OrderType;
  price: number;
  quantity: number;
  filledQuantity: number;
  remaining: number;
  status: string;
  createdAt: string;
};

type WalletState = {
  balance: number;
  reserved: number;
  available: number;
};

const EMPTY_BOOK: BookData = {
  bids: [],
  asks: [],
  bestBid: null,
  bestAsk: null,
  mid: null,
  spread: null,
};

const EMPTY_STATS: MarketStats = {
  lastPrice: null,
  bestBid: null,
  bestAsk: null,
  mid: null,
  spread: null,
  volume24h: 0,
  trades24h: 0,
  high24h: null,
  low24h: null,
  openInterest: 0,
  change24h: null,
  spark: [],
};

function MarketSkeleton() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <div className="h-3 w-24 animate-pulse bg-line" />
      <div className="mt-8 h-4 w-40 animate-pulse bg-line" />
      <div className="mt-4 h-12 w-3/4 animate-pulse bg-line" />
      <div className="mt-10 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="h-96 animate-pulse border border-line bg-surface" />
        <div className="h-96 animate-pulse border border-line bg-surface" />
      </div>
    </main>
  );
}

export default function MarketPage() {
  return (
    <Suspense fallback={<MarketSkeleton />}>
      <MarketPageContent />
    </Suspense>
  );
}

function MarketPageContent() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const { status: sessionStatus } = useSession();

  const [market, setMarket] = useState<MarketDetail | null>(null);
  const [stats, setStats] = useState<MarketStats>(EMPTY_STATS);
  const [book, setBook] = useState<BookData>(EMPTY_BOOK);
  const [trades, setTrades] = useState<TradeTapeItem[]>([]);
  const [candles, setCandles] = useState<CandleInput[]>([]);
  const [range, setRange] = useState<ChartRange>("1W");
  const [chartMode, setChartMode] = useState<ChartMode>("line");
  const [chartLoading, setChartLoading] = useState(true);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mounted, setMounted] = useState(false);

  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);

  const [bookView, setBookView] = useState<BookView>("YES");
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [action, setAction] = useState<Action>("BUY");
  const [orderType, setOrderType] = useState<OrderType>("LIMIT");
  const [price, setPrice] = useState("50");
  const [quantity, setQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const priceTouched = useRef(false);

  const [watched, setWatched] = useState(false);
  const [watchPending, setWatchPending] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const response = await fetch(`/api/markets/${slug}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Unable to load market.");
      }

      setMarket(data.market);
      setStats(data.stats ?? EMPTY_STATS);
      setWatched(Boolean(data.market.watched));
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load market.",
      );
    } finally {
      setLoading(false);
    }
  }, [slug]);

  const loadBook = useCallback(async () => {
    try {
      const response = await fetch(`/api/markets/${slug}/book`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      setBook(data.book ?? EMPTY_BOOK);
      setStats(data.stats ?? EMPTY_STATS);
      setTrades(Array.isArray(data.trades) ? data.trades : []);

      if (!priceTouched.current && data.stats?.bestAsk != null) {
        setPrice(String(data.stats.bestAsk));
      }
      setMarket((current) =>
        current && data.market
          ? { ...current, status: data.market.status }
          : current,
      );
    } catch {
      // The book is refreshed on the next poll.
    }
  }, [slug]);

  const loadCandles = useCallback(
    async (nextRange: ChartRange) => {
      setChartLoading(true);
      try {
        const response = await fetch(
          `/api/markets/${slug}/candles?range=${nextRange}`,
        );
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        setCandles(Array.isArray(data.candles) ? data.candles : []);
      } catch {
        setCandles([]);
      } finally {
        setChartLoading(false);
      }
    },
    [slug],
  );

  const loadAccount = useCallback(async () => {
    if (sessionStatus !== "authenticated") {
      setWallet(null);
      setPosition(null);
      setOrders([]);
      return;
    }

    try {
      const [walletResponse, positionsResponse] = await Promise.all([
        fetch("/api/wallet"),
        fetch(`/api/positions/me?market=${slug}`),
      ]);

      if (walletResponse.ok) {
        const data = await walletResponse.json();
        setWallet(data.wallet);
      }

      if (positionsResponse.ok) {
        const data = await positionsResponse.json();
        setPosition(
          Array.isArray(data.positions) && data.positions.length > 0
            ? data.positions[0]
            : null,
        );
        setOrders(Array.isArray(data.orders) ? data.orders : []);
      }
    } catch {
      // Account data is opportunistic; order endpoints enforce balances.
    }
  }, [sessionStatus, slug]);

  useEffect(() => {
    void loadMeta();
    void loadBook();
  }, [loadMeta, loadBook]);

  useEffect(() => {
    void loadCandles(range);
  }, [loadCandles, range]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  useEffect(() => {
    let tick = 0;

    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }

      tick += 1;
      void loadBook();
      void loadAccount();

      if (tick % 4 === 0) {
        void loadMeta();
        void loadCandles(range);
      }
    }, 5_000);

    return () => clearInterval(interval);
  }, [loadBook, loadAccount, loadMeta, loadCandles, range]);

  const viewStatus = mounted ? sessionStatus : "loading";
  const isPastClose = market ? new Date(market.closesAt) <= new Date() : false;
  const canTrade =
    viewStatus === "authenticated" && market?.status === "OPEN" && !isPastClose;

  const heldYes = position
    ? Math.max(0, position.yesShares - position.yesReserved)
    : 0;
  const heldNo = position
    ? Math.max(0, position.noShares - position.noReserved)
    : 0;
  const heldShares = outcome === "YES" ? heldYes : heldNo;

  const numericPrice = Number(price);
  const numericQuantity = Number(quantity);
  const validPrice =
    orderType === "MARKET" ||
    (Number.isInteger(numericPrice) && numericPrice >= 1 && numericPrice <= 99);
  const validQuantity =
    Number.isInteger(numericQuantity) && numericQuantity > 0;

  const estimate = useMemo(() => {
    if (!validQuantity) {
      return null;
    }

    if (orderType === "LIMIT") {
      if (!validPrice) {
        return null;
      }

      return {
        notional: numericPrice * numericQuantity,
        shares: numericQuantity,
        averagePrice: numericPrice,
        remainder: 0,
      };
    }

    const levels =
      action === "BUY"
        ? outcome === "YES"
          ? [...book.asks].sort((a, b) => a.price - b.price)
          : [...book.bids].sort((a, b) => b.price - a.price)
        : outcome === "YES"
          ? [...book.bids].sort((a, b) => b.price - a.price)
          : [...book.asks].sort((a, b) => a.price - b.price);

    let remaining = numericQuantity;
    let notional = 0;
    let filled = 0;

    for (const level of levels) {
      if (remaining <= 0) {
        break;
      }

      const unitPrice = outcome === "YES" ? level.price : 100 - level.price;
      const filledHere = Math.min(remaining, level.size);
      notional += unitPrice * filledHere;
      filled += filledHere;
      remaining -= filledHere;
    }

    return {
      notional,
      shares: filled,
      averagePrice: filled > 0 ? notional / filled : 0,
      remainder: remaining,
    };
  }, [
    action,
    book.asks,
    book.bids,
    numericPrice,
    numericQuantity,
    orderType,
    outcome,
    validPrice,
    validQuantity,
  ]);

  const referencePrice =
    action === "BUY"
      ? outcome === "YES"
        ? stats.bestAsk
        : stats.bestBid !== null
          ? 100 - stats.bestBid
          : null
      : outcome === "YES"
        ? stats.bestBid
        : stats.bestAsk !== null
          ? 100 - stats.bestAsk
          : null;

  function chooseOutcome(nextOutcome: Outcome) {
    priceTouched.current = true;
    setOutcome(nextOutcome);
    setFormError("");
    setSuccessMessage("");

    const nextBuy =
      nextOutcome === "YES"
        ? stats.bestAsk
        : stats.bestBid !== null
          ? 100 - stats.bestBid
          : null;
    const nextSell =
      nextOutcome === "YES"
        ? stats.bestBid
        : stats.bestAsk !== null
          ? 100 - stats.bestAsk
          : null;
    const nextPrice = action === "BUY" ? nextBuy : nextSell;

    if (orderType === "LIMIT" && nextPrice !== null) {
      setPrice(String(nextPrice));
    }
  }

  function chooseAction(nextAction: Action) {
    priceTouched.current = true;
    setAction(nextAction);
    setFormError("");
    setSuccessMessage("");

    const nextPrice =
      nextAction === "BUY"
        ? outcome === "YES"
          ? stats.bestAsk
          : stats.bestBid !== null
            ? 100 - stats.bestBid
            : null
        : outcome === "YES"
          ? stats.bestBid
          : stats.bestAsk !== null
            ? 100 - stats.bestAsk
            : null;

    if (orderType === "LIMIT" && nextPrice !== null) {
      setPrice(String(nextPrice));
    }
  }

  function chooseOrderType(nextType: OrderType) {
    priceTouched.current = true;
    setOrderType(nextType);
    setFormError("");
    setSuccessMessage("");

    if (nextType === "LIMIT" && referencePrice !== null) {
      setPrice(String(referencePrice));
    }
  }

  function handleBookSelect(side: "bid" | "ask", displayPrice: number) {
    priceTouched.current = true;
    setOutcome(bookView);
    setAction(side === "ask" ? "BUY" : "SELL");
    setOrderType("LIMIT");
    setPrice(String(displayPrice));
    setFormError("");
    setSuccessMessage("");
  }

  async function handleSubmit() {
    setFormError("");
    setSuccessMessage("");

    if (!validQuantity) {
      setFormError("Enter a positive whole number of shares.");
      return;
    }

    if (!validPrice) {
      setFormError("Enter a limit price between 1 and 99 cents.");
      return;
    }

    if (action === "SELL" && numericQuantity > heldShares) {
      setFormError(
        `You only have ${formatCredits(heldShares)} ${outcome} shares available to sell.`,
      );
      return;
    }

    if (
      action === "BUY" &&
      estimate &&
      wallet &&
      estimate.shares < numericQuantity
    ) {
      setFormError("There is not enough resting liquidity for that size.");
      return;
    }

    if (
      action === "BUY" &&
      wallet &&
      estimate &&
      estimate.notional > wallet.available
    ) {
      setFormError("You do not have enough available credits.");
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch(`/api/markets/${slug}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          action,
          type: orderType,
          ...(orderType === "LIMIT" ? { price: numericPrice } : {}),
          quantity: numericQuantity,
          idempotencyKey: crypto.randomUUID(),
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setFormError(data?.error ?? "Unable to place order.");
        return;
      }

      if (
        data.order?.status === "FILLED" ||
        data.order?.filledQuantity === numericQuantity
      ) {
        setSuccessMessage(
          `${action} ${outcome} filled: ${formatCredits(numericQuantity)} shares.`,
        );
      } else if (data.order?.filledQuantity > 0) {
        setSuccessMessage(
          `${formatCredits(data.order.filledQuantity)} of ${formatCredits(
            numericQuantity,
          )} shares filled; the remainder is ${
            data.order.status === "CANCELLED"
              ? "cancelled"
              : "resting on the book"
          }.`,
        );
      } else if (data.selfCrossed) {
        setSuccessMessage(
          "Order cancelled — it would have crossed one of your own resting orders.",
        );
      } else if (orderType === "MARKET") {
        setSuccessMessage(
          "No resting liquidity at that size — nothing filled.",
        );
      } else {
        setSuccessMessage("Order posted to the book.");
      }

      window.dispatchEvent(new Event("wallet:updated"));
      setQuantity("");
      await Promise.all([
        loadBook(),
        loadAccount(),
        loadCandles(range),
        loadMeta(),
      ]);
    } catch {
      setFormError("Unable to place order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(orderId: string) {
    try {
      const response = await fetch(`/api/orders/${orderId}/cancel`, {
        method: "POST",
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setFormError(data?.error ?? "Unable to cancel order.");
        return;
      }

      window.dispatchEvent(new Event("wallet:updated"));
      await Promise.all([loadBook(), loadAccount()]);
    } catch {
      setFormError("Unable to cancel order.");
    }
  }

  async function handleToggleWatch() {
    if (watchPending || !market) {
      return;
    }

    const nextWatched = !watched;
    setWatched(nextWatched);
    setWatchPending(true);

    try {
      const response = await fetch(`/api/watchlist/${market.slug}`, {
        method: nextWatched ? "POST" : "DELETE",
      });

      if (!response.ok) {
        throw new Error("Unable to update watchlist.");
      }
    } catch {
      setWatched(!nextWatched);
    } finally {
      setWatchPending(false);
    }
  }

  if (loading) {
    return <MarketSkeleton />;
  }

  if (loadError || !market) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
        <div className="border border-no/30 bg-no-soft p-6 text-sm text-no">
          {loadError || "Market not found."}
        </div>
        <Link
          href="/markets"
          className="mt-6 inline-block font-mono text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
        >
          ← Back to the board
        </Link>
      </main>
    );
  }

  const displayYes =
    stats.lastPrice ?? (stats.mid !== null ? Math.round(stats.mid) : null);
  const displayNo = displayYes === null ? null : 100 - displayYes;
  const change = stats.change24h;
  const canSubmit = canTrade && validQuantity && validPrice && !submitting;
  const maxBuyShares =
    action === "BUY" && orderType === "LIMIT" && wallet
      ? Math.floor(
          wallet.available /
            (outcome === "YES" ? numericPrice : 100 - numericPrice),
        )
      : null;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-20 pt-8 sm:px-6">
      <Link
        href="/markets"
        className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
      >
        ← The board
      </Link>

      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <StatusPill status={market.status} />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          {market.category}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          Closes {formatDate(market.closesAt)}
        </span>
        {viewStatus === "authenticated" && (
          <button
            type="button"
            onClick={handleToggleWatch}
            disabled={watchPending}
            aria-pressed={watched}
            className={`ml-auto flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-50 ${
              watched
                ? "border-ink bg-ink text-paper"
                : "border-line text-muted hover:border-ink hover:text-ink"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill={watched ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M6 4h12v17l-6-4-6 4V4z" strokeLinejoin="round" />
            </svg>
            {watched ? "Watching" : "Watch"}
          </button>
        )}
      </div>

      <h1 className="mt-5 max-w-4xl text-balance font-display text-4xl font-semibold leading-[1.02] tracking-[-0.035em] sm:text-5xl">
        {market.question}
      </h1>

      {market.description && (
        <p className="mt-5 max-w-[60ch] text-sm leading-7 text-muted">
          {market.description}
        </p>
      )}

      <div className="mt-10 grid gap-6 lg:grid-cols-[1.35fr_1fr] lg:items-start lg:gap-8">
        <div className="space-y-6">
          <section className="border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 sm:px-7">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                Market price
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                {stats.lastPrice !== null
                  ? `${formatCredits(stats.volume24h)} shares · 24h`
                  : "Awaiting first trade"}
              </span>
            </div>

            <div className="grid grid-cols-2">
              <div className="p-5 sm:p-7">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-yes">
                  Yes
                </p>
                <p className="mt-2 font-display text-5xl font-semibold leading-none tracking-[-0.04em] text-yes">
                  {displayYes === null ? "—" : formatCents(displayYes)}
                </p>
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                  {displayYes === null
                    ? "No price yet"
                    : `${displayYes}% implied`}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted">
                  Bid{" "}
                  {stats.bestBid === null ? "—" : formatCents(stats.bestBid)} ·
                  Ask{" "}
                  {stats.bestAsk === null ? "—" : formatCents(stats.bestAsk)}
                </p>
              </div>

              <div className="border-l border-line p-5 sm:p-7">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-no">
                  No
                </p>
                <p className="mt-2 font-display text-5xl font-semibold leading-none tracking-[-0.04em] text-no">
                  {displayNo === null ? "—" : formatCents(displayNo)}
                </p>
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                  {displayNo === null
                    ? "No price yet"
                    : `${displayNo}% implied`}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted">
                  Bid{" "}
                  {stats.bestAsk === null
                    ? "—"
                    : formatCents(100 - stats.bestAsk)}{" "}
                  · Ask{" "}
                  {stats.bestBid === null
                    ? "—"
                    : formatCents(100 - stats.bestBid)}
                </p>
              </div>
            </div>

            <PriceChart
              candles={candles}
              range={range}
              onRangeChange={(nextRange) => setRange(nextRange)}
              mode={chartMode}
              onModeChange={setChartMode}
              lastPrice={stats.lastPrice}
              loading={chartLoading}
            />

            <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
              <div className="bg-surface p-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  24h range
                </p>
                <p className="mt-1 font-mono text-sm text-ink">
                  {stats.low24h === null || stats.high24h === null
                    ? "—"
                    : stats.low24h === stats.high24h
                      ? formatCents(stats.high24h)
                      : `${formatCents(stats.low24h)} – ${formatCents(stats.high24h)}`}
                </p>
              </div>
              <div className="bg-surface p-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  24h range
                </p>
                <p
                  className={`mt-1 font-mono text-sm ${
                    change === null
                      ? "text-ink"
                      : change >= 0
                        ? "text-yes"
                        : "text-no"
                  }`}
                >
                  {change === null
                    ? "—"
                    : `${change >= 0 ? "+" : ""}${change}¢`}
                </p>
              </div>
              <div className="bg-surface p-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  24h volume
                </p>
                <p className="mt-1 font-mono text-sm text-ink">
                  {formatCredits(stats.volume24h)}
                </p>
              </div>
              <div className="bg-surface p-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  Open interest
                </p>
                <p className="mt-1 font-mono text-sm text-ink">
                  {formatCredits(stats.openInterest)}
                </p>
              </div>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <OrderBook
              book={book}
              view={bookView}
              onViewChange={setBookView}
              onSelect={handleBookSelect}
              lastPrice={stats.lastPrice}
            />
            <TradeTape trades={trades} />
          </div>

          {market.status === "RESOLVED" && market.resolution && (
            <section className="border border-accent/30 bg-accent-soft p-5 sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
                  Resolution
                </p>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent/70">
                  {formatDate(market.resolution.resolvedAt)}
                </p>
              </div>

              <p className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em]">
                Resolved{" "}
                <span
                  className={
                    market.resolution.outcome === "YES" ? "text-yes" : "text-no"
                  }
                >
                  {market.resolution.outcome}
                </span>
                . Winning shares paid 100 credits each.
              </p>

              {market.resolution.notes && (
                <p className="mt-2 max-w-[58ch] text-sm leading-6 text-ink/75">
                  {market.resolution.notes}
                </p>
              )}

              {market.resolution.evidenceUrl && (
                <a
                  href={market.resolution.evidenceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-block font-mono text-[10px] uppercase tracking-[0.14em] text-accent underline underline-offset-4"
                >
                  View evidence ↗
                </a>
              )}
            </section>
          )}

          {market.status === "VOID" && (
            <section className="border border-line-strong bg-surface p-5 sm:p-7">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                Voided
              </p>
              <p className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em]">
                This market was voided.
              </p>
              <p className="mt-2 text-sm leading-6 text-muted">
                Open orders were cancelled and positions were unwound at the
                last traded price. No side was paid out at 100.
              </p>
            </section>
          )}

          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink pb-3">
              <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
                Resolution rules
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                Published before open
              </span>
            </div>

            <p className="mt-5 whitespace-pre-line text-sm leading-7 text-ink/75">
              {market.rules ??
                "No resolution rules were provided for this market."}
            </p>
          </section>

          <dl className="grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-3">
            <div className="bg-surface p-4">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                Category
              </dt>
              <dd className="mt-1.5 text-sm text-ink">{market.category}</dd>
            </div>
            <div className="bg-surface p-4">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                Closes
              </dt>
              <dd className="mt-1.5 text-sm text-ink">
                {formatDate(market.closesAt)}
              </dd>
            </div>
            <div className="bg-surface p-4">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                Settlement
              </dt>
              <dd className="mt-1.5 text-sm text-ink">
                {market.status === "RESOLVED" && market.resolution
                  ? `${market.resolution.outcome} · 100 cr per share`
                  : market.status === "VOID"
                    ? "Unwound at last price"
                    : "100 cr per winning share"}
              </dd>
            </div>
          </dl>

          <div className="mt-12">
            <MarketDiscussion slug={market.slug} />
          </div>
        </div>

        <aside className="border border-ink bg-surface lg:sticky lg:top-24">
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
            <h2 className="font-display text-lg font-semibold tracking-[-0.01em]">
              Trade
            </h2>
            {wallet && (
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                Available {formatCredits(wallet.available)} cr
              </span>
            )}
          </div>

          <div className="p-5">
            {viewStatus === "unauthenticated" ? (
              <div>
                <p className="text-sm leading-6 text-muted">
                  Sign in to post limit orders, take liquidity, and hold YES or
                  NO shares.
                </p>
                <Link
                  href="/login"
                  className="mt-5 flex items-center justify-center bg-ink px-4 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-ink/85"
                >
                  Sign in to trade
                </Link>
              </div>
            ) : !canTrade ? (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                  {market.status === "OPEN" ? "Market closed" : market.status}
                </p>
                <p className="mt-3 text-sm leading-6 text-muted">
                  {market.status === "RESOLVED"
                    ? "This market has resolved. Positions have been settled."
                    : market.status === "VOID"
                      ? "This market was voided and positions were unwound."
                      : "Trading is closed. Orders can no longer be placed."}
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => chooseAction("BUY")}
                    className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                      action === "BUY"
                        ? "border-ink bg-ink text-paper"
                        : "border-line text-muted hover:border-ink hover:text-ink"
                    }`}
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseAction("SELL")}
                    className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                      action === "SELL"
                        ? "border-ink bg-ink text-paper"
                        : "border-line text-muted hover:border-ink hover:text-ink"
                    }`}
                  >
                    Sell
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {(["YES", "NO"] as const).map((entry) => {
                    const entryPrice =
                      action === "BUY"
                        ? entry === "YES"
                          ? stats.bestAsk
                          : stats.bestBid !== null
                            ? 100 - stats.bestBid
                            : null
                        : entry === "YES"
                          ? stats.bestBid
                          : stats.bestAsk !== null
                            ? 100 - stats.bestAsk
                            : null;

                    return (
                      <button
                        key={entry}
                        type="button"
                        onClick={() => chooseOutcome(entry)}
                        className={`border px-3 py-2 transition-colors ${
                          outcome === entry
                            ? entry === "YES"
                              ? "border-yes bg-yes text-white"
                              : "border-no bg-no text-white"
                            : "border-line text-ink hover:border-ink"
                        }`}
                      >
                        <span className="block font-mono text-[10px] uppercase tracking-[0.14em]">
                          {entry === "YES" ? "Yes" : "No"}
                        </span>
                        <span className="mt-0.5 block font-mono text-xs">
                          {entryPrice === null ? "—" : formatCents(entryPrice)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div
                  className="flex items-center gap-1"
                  role="group"
                  aria-label="Order type"
                >
                  {(["LIMIT", "MARKET"] as const).map((entry) => (
                    <button
                      key={entry}
                      type="button"
                      onClick={() => chooseOrderType(entry)}
                      className={`flex-1 border px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
                        orderType === entry
                          ? "border-ink bg-ink text-paper"
                          : "border-line text-muted hover:border-ink hover:text-ink"
                      }`}
                    >
                      {entry === "LIMIT" ? "Limit" : "Market"}
                    </button>
                  ))}
                </div>

                {orderType === "LIMIT" && (
                  <label className="block">
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                      Limit price
                    </span>
                    <div className="mt-1 flex items-stretch border border-line bg-paper">
                      <button
                        type="button"
                        onClick={() => {
                          priceTouched.current = true;
                          setPrice(String(Math.max(1, numericPrice - 1)));
                        }}
                        className="px-3 font-mono text-sm text-muted transition-colors hover:text-ink"
                        aria-label="Decrease price"
                      >
                        −
                      </button>
                      <input
                        value={price}
                        onChange={(event) => {
                          priceTouched.current = true;
                          setPrice(event.target.value);
                        }}
                        inputMode="numeric"
                        className="h-11 w-full border-x border-line bg-transparent text-center font-mono text-sm text-ink outline-none focus:border-ink"
                        aria-label="Limit price in cents"
                      />
                      <span className="flex items-center px-2 font-mono text-[10px] text-muted">
                        ¢
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          priceTouched.current = true;
                          setPrice(String(Math.min(99, numericPrice + 1)));
                        }}
                        className="px-3 font-mono text-sm text-muted transition-colors hover:text-ink"
                        aria-label="Increase price"
                      >
                        +
                      </button>
                    </div>
                  </label>
                )}

                <label className="block">
                  <span className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                    <span>Shares</span>
                    <span>
                      Hold {formatCredits(outcome === "YES" ? heldYes : heldNo)}{" "}
                      {outcome}
                    </span>
                  </span>
                  <input
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    inputMode="numeric"
                    placeholder="0"
                    className="mt-1 h-11 w-full border border-line bg-paper px-3 font-mono text-sm text-ink outline-none focus:border-ink"
                    aria-label="Share quantity"
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {[5, 10, 25, 50].map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => setQuantity(String(size))}
                        className="border border-line px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:border-ink hover:text-ink"
                      >
                        {size}
                      </button>
                    ))}
                    {action === "SELL" && heldShares > 0 && (
                      <button
                        type="button"
                        onClick={() => setQuantity(String(heldShares))}
                        className="border border-line px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:border-ink hover:text-ink"
                      >
                        Max
                      </button>
                    )}
                    {action === "BUY" &&
                      maxBuyShares !== null &&
                      maxBuyShares > 0 && (
                        <button
                          type="button"
                          onClick={() => setQuantity(String(maxBuyShares))}
                          className="border border-line px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:border-ink hover:text-ink"
                        >
                          Max
                        </button>
                      )}
                  </div>
                </label>

                <dl className="space-y-1.5 border-t border-line pt-3 font-mono text-[10px] text-muted">
                  <div className="flex items-center justify-between">
                    <dt>{action === "BUY" ? "Est. cost" : "Est. proceeds"}</dt>
                    <dd className="text-ink">
                      {estimate
                        ? `${formatCredits(Math.round(estimate.notional))} cr`
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt>Avg. price</dt>
                    <dd className="text-ink">
                      {estimate && estimate.shares > 0
                        ? formatCents(
                            Math.round(estimate.averagePrice * 10) / 10,
                          )
                        : "—"}
                    </dd>
                  </div>
                  {action === "BUY" && (
                    <div className="flex items-center justify-between">
                      <dt>Max payout</dt>
                      <dd className="text-yes">
                        {validQuantity
                          ? `${formatCredits(numericQuantity * 100)} cr`
                          : "—"}
                      </dd>
                    </div>
                  )}
                  {estimate && estimate.remainder > 0 && (
                    <div className="flex items-center justify-between text-no">
                      <dt>Unfillable</dt>
                      <dd>{formatCredits(estimate.remainder)} shares</dd>
                    </div>
                  )}
                </dl>

                {formError && (
                  <p
                    role="alert"
                    className="border border-no/30 bg-no-soft px-3 py-2 text-xs leading-5 text-no"
                  >
                    {formError}
                  </p>
                )}
                {successMessage && (
                  <p className="border border-yes/30 bg-yes-soft px-3 py-2 text-xs leading-5 text-yes">
                    {successMessage}
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className={`w-full px-4 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white transition-opacity disabled:opacity-40 ${
                    outcome === "YES" ? "bg-yes" : "bg-no"
                  }`}
                >
                  {submitting
                    ? "Placing…"
                    : `${action} ${validQuantity ? numericQuantity : ""} ${outcome}`.trim()}
                </button>

                <p className="text-center font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                  Winning shares settle at 100 cr · Losers expire at 0
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        {position && (position.yesShares > 0 || position.noShares > 0) && (
          <div className="border border-line bg-surface">
            <div className="border-b border-line px-5 py-3">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                Your position
              </h2>
            </div>
            <div className="divide-y divide-line">
              {position.yesShares > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-yes">
                      Yes · {formatCredits(position.yesShares)} shares
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      Avg {position.avgYesPrice?.toFixed(1)}¢ · Mark{" "}
                      {position.markPrice === null
                        ? "—"
                        : formatCents(position.markPrice)}{" "}
                      ·{" "}
                      {formatCredits(
                        Math.round(
                          position.yesShares * (position.markPrice ?? 0),
                        ),
                      )}{" "}
                      cr
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOutcome("YES");
                      setAction("SELL");
                      setOrderType("LIMIT");
                      if (stats.bestBid !== null) {
                        setPrice(String(stats.bestBid));
                      }
                    }}
                    className="border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-ink hover:text-ink"
                  >
                    Sell YES
                  </button>
                </div>
              )}
              {position.noShares > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-no">
                      No · {formatCredits(position.noShares)} shares
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      Avg {position.avgNoPrice?.toFixed(1)}¢ · Mark{" "}
                      {position.markPrice === null
                        ? "—"
                        : formatCents(100 - position.markPrice)}{" "}
                      ·{" "}
                      {formatCredits(
                        Math.round(
                          position.noShares * (100 - (position.markPrice ?? 0)),
                        ),
                      )}{" "}
                      cr
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOutcome("NO");
                      setAction("SELL");
                      setOrderType("LIMIT");
                      if (stats.bestAsk !== null) {
                        setPrice(String(100 - stats.bestAsk));
                      }
                    }}
                    className="border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-ink hover:text-ink"
                  >
                    Sell NO
                  </button>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 font-mono text-[10px] text-muted">
                <span>
                  Unrealized{" "}
                  <span
                    className={
                      position.unrealized >= 0 ? "text-yes" : "text-no"
                    }
                  >
                    {position.unrealized >= 0 ? "+" : ""}
                    {formatCredits(position.unrealized)} cr
                  </span>
                </span>
                <span>
                  Reserved{" "}
                  {formatCredits(position.yesReserved + position.noReserved)}{" "}
                  shares
                </span>
              </div>
            </div>
          </div>
        )}

        {orders.length > 0 && (
          <div className="border border-line bg-surface">
            <div className="border-b border-line px-5 py-3">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                Open orders
              </h2>
            </div>
            <ul>
              {orders.map((order) => (
                <li
                  key={order.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-5 py-3 last:border-0"
                >
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.1em]">
                      <span
                        className={
                          order.action === "BUY" ? "text-yes" : "text-no"
                        }
                      >
                        {order.action}
                      </span>{" "}
                      <span className="text-ink">{order.outcome}</span>{" "}
                      <span className="text-muted">
                        @ {formatCents(order.price)}
                      </span>
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      {formatCredits(order.filledQuantity)} /{" "}
                      {formatCredits(order.quantity)} filled ·{" "}
                      {order.status.toLowerCase()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCancel(order.id)}
                    className="border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-ink hover:text-ink"
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}
