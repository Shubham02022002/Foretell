"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { SideChip, StatusPill } from "@/components/market-ui";
import { formatCents, formatCredits, formatDate } from "@/lib/format";
import { apiErrorMessage, axios } from "@/lib/http";

type Wallet = {
  balance: number;
  reserved: number;
  available: number;
  updatedAt: string;
};

type PositionMarket = {
  slug: string;
  question: string;
  category: string;
  status: string;
  closesAt: string;
};

type Position = {
  id: string;
  market: PositionMarket;
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
  realized: number;
};

type OpenOrder = {
  id: string;
  market: PositionMarket;
  outcome: "YES" | "NO";
  action: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  price: number;
  quantity: number;
  filledQuantity: number;
  remaining: number;
  status: string;
  createdAt: string;
};

type Summary = {
  realizedNet: number;
  marketValue: number;
  costBasis: number;
  unrealized: number;
  openPositions: number;
  openOrders: number;
};

type LedgerEntry = {
  id: string;
  amount: number;
  type: string;
  createdAt: string;
  marketId: string | null;
  orderId: string | null;
  tradeId: string | null;
  market: { slug: string; question: string } | null;
};

const LEDGER_LABELS: Record<string, string> = {
  INITIAL_CREDIT: "Welcome credits",
  TRADE_BUY: "Bought shares",
  TRADE_SELL: "Sold shares",
  SETTLEMENT_PAYOUT: "Settlement payout",
  REFUND: "Refund",
  ADMIN_ADJUSTMENT: "Adjustment",
  BET_STAKE: "Legacy stake",
  BET_PAYOUT: "Legacy payout",
  POSITION_SALE: "Legacy sale",
};

function signedCredits(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatCredits(Math.abs(value))}`;
}

export default function PortfolioPage() {
  const { data: session, status: sessionStatus } = useSession();

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadPortfolio = useCallback(async () => {
    setError("");

    try {
      const [walletResponse, portfolioResponse, ledgerResponse] =
        await Promise.all([
          axios.get<{ wallet: Wallet }>("/api/wallet"),
          axios.get<{
            positions?: Position[];
            orders?: OpenOrder[];
            summary?: Summary | null;
          }>("/api/positions/me"),
          axios.get<{ entries?: LedgerEntry[] }>(
            "/api/wallet/ledger?limit=20",
          ),
        ]);

      const portfolioData = portfolioResponse.data;
      const ledgerData = ledgerResponse.data;

      setWallet(walletResponse.data.wallet);
      setPositions(
        Array.isArray(portfolioData.positions) ? portfolioData.positions : [],
      );
      setOrders(
        Array.isArray(portfolioData.orders) ? portfolioData.orders : [],
      );
      setSummary(portfolioData.summary ?? null);
      setEntries(Array.isArray(ledgerData.entries) ? ledgerData.entries : []);
    } catch (loadError) {
      setError(
        apiErrorMessage(loadError, "Unable to load your portfolio."),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionStatus === "loading") {
      return;
    }

    if (sessionStatus === "unauthenticated") {
      setLoading(false);
      return;
    }

    void loadPortfolio();
  }, [sessionStatus, loadPortfolio]);

  async function handleCancel(orderId: string) {
    if (cancellingId) {
      return;
    }

    setCancellingId(orderId);
    setError("");

    try {
      await axios.post(`/api/orders/${orderId}/cancel`);

      window.dispatchEvent(new Event("wallet:updated"));
      await loadPortfolio();
    } catch (cancelError) {
      setError(
        apiErrorMessage(cancelError, "Unable to cancel this order."),
      );
    } finally {
      setCancellingId(null);
    }
  }

  const viewStatus = mounted ? sessionStatus : "loading";

  if (viewStatus === "unauthenticated") {
    return (
      <main>
        <section className="border-b border-line">
          <div className="mx-auto w-full max-w-7xl px-4 pb-12 pt-12 sm:px-6 sm:pt-16">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
              Account
            </p>
            <h1 className="mt-4 font-display text-5xl font-semibold tracking-[-0.04em] sm:text-6xl">
              Portfolio
            </h1>
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
          <div className="max-w-xl border border-line bg-surface p-8">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
              Sign in required
            </p>
            <h2 className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em]">
              See your balance, positions, and ledger.
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              Your account keeps every order, fill, and credit movement in one
              place, so you always know where you stand.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="bg-ink px-5 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-ink/85"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors hover:border-ink"
              >
                Create an account
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="border-b border-line">
        <div className="mx-auto w-full max-w-7xl px-4 pb-10 pt-12 sm:px-6 sm:pb-12 sm:pt-16">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
            Account
          </p>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
            <div>
              <h1 className="font-display text-5xl font-semibold tracking-[-0.04em] sm:text-6xl">
                Portfolio
              </h1>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                {session?.user?.email ?? "Signed in"}
              </p>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {session?.user?.id && (
                <Link
                  href={`/traders/${session.user.id}`}
                  className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
                >
                  Public profile <span aria-hidden="true">→</span>
                </Link>
              )}
              <Link
                href="/markets"
                className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
              >
                Browse markets <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        {error && (
          <div
            role="alert"
            className="mt-6 border border-no/30 bg-no-soft px-4 py-4 text-sm text-no"
          >
            {error}
          </div>
        )}

        <dl className="mt-8 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-surface p-5 sm:p-6">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              Available credits
            </dt>
            <dd className="mt-2 font-display text-4xl font-semibold leading-none tracking-[-0.03em]">
              {wallet ? formatCredits(wallet.available) : "—"}
            </dd>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              {wallet
                ? `${formatCredits(wallet.reserved)} cr in orders`
                : "Ready to trade"}
            </p>
          </div>

          <div className="bg-surface p-5 sm:p-6">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              Position value
            </dt>
            <dd className="mt-2 font-display text-4xl font-semibold leading-none tracking-[-0.03em]">
              {loading || !summary
                ? "—"
                : formatCredits(summary.marketValue)}
            </dd>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              Marked at the last trade
            </p>
          </div>

          <div className="bg-surface p-5 sm:p-6">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              Unrealized P&amp;L
            </dt>
            <dd
              className={`mt-2 font-display text-4xl font-semibold leading-none tracking-[-0.03em] ${
                !summary || summary.unrealized === 0
                  ? "text-ink"
                  : summary.unrealized > 0
                    ? "text-yes"
                    : "text-no"
              }`}
            >
              {loading || !summary ? "—" : signedCredits(summary.unrealized)}
            </dd>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              {summary?.openPositions ?? 0}{" "}
              {summary?.openPositions === 1 ? "open position" : "open positions"}
            </p>
          </div>

          <div className="bg-surface p-5 sm:p-6">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              Realized P&amp;L
            </dt>
            <dd
              className={`mt-2 font-display text-4xl font-semibold leading-none tracking-[-0.03em] ${
                !summary || summary.realizedNet === 0
                  ? "text-ink"
                  : summary.realizedNet > 0
                    ? "text-yes"
                    : "text-no"
              }`}
            >
              {loading || !summary ? "—" : signedCredits(summary.realizedNet)}
            </dd>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              Closed trades and settlements
            </p>
          </div>
        </dl>

        <section className="mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink pb-3">
            <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
              Positions
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {loading ? "Loading" : `${positions.length} open`}
            </span>
          </div>

          {loading ? (
            <div aria-hidden="true">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="border-b border-line py-5">
                  <div className="h-3 w-32 animate-pulse bg-line" />
                  <div className="mt-3 h-5 w-2/3 animate-pulse bg-line" />
                </div>
              ))}
            </div>
          ) : positions.length === 0 ? (
            <div className="border-b border-line py-12">
              <p className="font-display text-xl font-medium">
                No open positions.
              </p>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted">
                Find a question you have a view on and buy YES or NO shares. Open
                positions will show up here.
              </p>
              <Link
                href="/markets"
                className="mt-5 inline-block border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors hover:border-ink"
              >
                Browse markets
              </Link>
            </div>
          ) : (
            <div>
              {positions.map((position) => (
                <div
                  key={position.id}
                  className="grid gap-4 border-b border-line py-5 sm:grid-cols-[minmax(0,1fr)_200px_170px_120px] sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={position.market.status} />
                      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                        Closes {formatDate(position.market.closesAt)}
                      </span>
                    </div>
                    <Link
                      href={`/markets/${position.market.slug}`}
                      className="mt-2 block max-w-[56ch] font-display text-[17px] font-medium leading-snug tracking-[-0.01em] text-ink transition-colors hover:text-accent"
                    >
                      {position.market.question}
                    </Link>
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {position.yesShares > 0 && (
                      <div>
                        <div className="flex items-center gap-2">
                          <SideChip side="YES" />
                          <span className="font-mono text-sm text-ink">
                            {formatCredits(position.yesShares)}
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-muted">
                          Avg{" "}
                          {position.avgYesPrice === null
                            ? "—"
                            : `${position.avgYesPrice}¢`}{" "}
                          · Mark{" "}
                          {position.markPrice === null
                            ? "—"
                            : formatCents(position.markPrice)}
                        </p>
                      </div>
                    )}
                    {position.noShares > 0 && (
                      <div>
                        <div className="flex items-center gap-2">
                          <SideChip side="NO" />
                          <span className="font-mono text-sm text-ink">
                            {formatCredits(position.noShares)}
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-muted">
                          Avg{" "}
                          {position.avgNoPrice === null
                            ? "—"
                            : `${position.avgNoPrice}¢`}{" "}
                          · Mark{" "}
                          {position.markPrice === null
                            ? "—"
                            : formatCents(100 - position.markPrice)}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="sm:text-right">
                    <p className="font-mono text-sm text-ink">
                      {formatCredits(Math.round(position.marketValue))} cr
                    </p>
                    <p
                      className={`mt-0.5 font-mono text-[10px] ${
                        position.unrealized >= 0 ? "text-yes" : "text-no"
                      }`}
                    >
                      {signedCredits(Math.round(position.unrealized))} unrealized
                    </p>
                  </div>

                  <Link
                    href={`/markets/${position.market.slug}`}
                    className="justify-self-start border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors hover:border-ink hover:bg-ink hover:text-paper sm:justify-self-end"
                  >
                    Trade
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink pb-3">
            <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
              Open orders
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {loading ? "Loading" : `${orders.length} resting`}
            </span>
          </div>

          {loading ? (
            <div aria-hidden="true">
              {Array.from({ length: 2 }).map((_, index) => (
                <div key={index} className="border-b border-line py-4">
                  <div className="h-4 w-1/2 animate-pulse bg-line" />
                </div>
              ))}
            </div>
          ) : orders.length === 0 ? (
            <div className="border-b border-line py-10">
              <p className="text-sm text-muted">
                No resting orders. Limit orders that do not fill immediately
                appear here.
              </p>
            </div>
          ) : (
            <div>
              {orders.map((order) => (
                <div
                  key={order.id}
                  className="grid gap-2 border-b border-line py-4 sm:grid-cols-[minmax(0,1fr)_180px_110px_110px_100px] sm:items-center sm:gap-4"
                >
                  <Link
                    href={`/markets/${order.market.slug}`}
                    className="min-w-0 truncate text-sm text-ink transition-colors hover:text-accent"
                  >
                    {order.market.question}
                  </Link>

                  <p className="font-mono text-[11px]">
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

                  <p className="font-mono text-[10px] text-muted">
                    {formatCredits(order.filledQuantity)} /{" "}
                    {formatCredits(order.quantity)}
                  </p>

                  <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                    {order.status.toLowerCase()}
                  </p>

                  <button
                    type="button"
                    onClick={() => handleCancel(order.id)}
                    disabled={cancellingId !== null}
                    className="justify-self-start border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors hover:border-ink hover:bg-ink hover:text-paper disabled:cursor-not-allowed disabled:opacity-50 sm:justify-self-end"
                  >
                    {cancellingId === order.id ? "Cancelling…" : "Cancel"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-12 pb-16">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink pb-3">
            <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
              Credit history
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              Latest {Math.min(entries.length, 20)} entries
            </span>
          </div>

          {loading ? (
            <div aria-hidden="true">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="border-b border-line py-4">
                  <div className="h-4 w-1/2 animate-pulse bg-line" />
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="border-b border-line py-12">
              <p className="font-display text-xl font-medium">
                No credit movements yet.
              </p>
              <p className="mt-2 text-sm text-muted">
                Fills, payouts, and refunds will appear here.
              </p>
            </div>
          ) : (
            <div>
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="grid gap-2 border-b border-line py-4 sm:grid-cols-[140px_minmax(0,1fr)_130px_120px] sm:items-center sm:gap-4"
                >
                  <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink">
                    {LEDGER_LABELS[entry.type] ?? entry.type}
                  </p>

                  <div className="min-w-0">
                    {entry.market ? (
                      <Link
                        href={`/markets/${entry.market.slug}`}
                        className="block truncate text-sm text-muted transition-colors hover:text-ink"
                      >
                        {entry.market.question}
                      </Link>
                    ) : (
                      <span className="text-sm text-muted">Account</span>
                    )}
                  </div>

                  <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted sm:text-right">
                    {formatDate(entry.createdAt)}
                  </p>

                  <p
                    className={`font-mono text-sm sm:text-right ${
                      entry.amount >= 0 ? "text-yes" : "text-ink"
                    }`}
                  >
                    {entry.amount >= 0 ? "+" : ""}
                    {formatCredits(entry.amount)} cr
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
