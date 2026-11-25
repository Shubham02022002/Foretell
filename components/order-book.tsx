"use client";

import { formatCents, formatCredits } from "@/lib/format";

export type BookLevel = { price: number; size: number };

export type BookData = {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
};

export type BookView = "YES" | "NO";

export type TradeTapeItem = {
  id: string;
  yesPrice: number;
  quantity: number;
  createdAt: string;
  takerAction: "BUY" | "SELL";
  takerOutcome: "YES" | "NO";
};

type DisplayLevel = BookLevel & { cumulative: number };

function withCumulative(levels: BookLevel[]): DisplayLevel[] {
  let running = 0;

  return levels.map((level) => {
    running += level.size;
    return { ...level, cumulative: running };
  });
}

function formatTapeTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function OrderBook({
  book,
  view,
  onViewChange,
  onSelect,
  lastPrice,
}: {
  book: BookData;
  view: BookView;
  onViewChange: (view: BookView) => void;
  onSelect: (side: "bid" | "ask", price: number) => void;
  lastPrice: number | null;
}) {
  const bids =
    view === "YES"
      ? book.bids
      : book.asks.map((level) => ({
          price: 100 - level.price,
          size: level.size,
        }));
  const asks =
    view === "YES"
      ? book.asks
      : book.bids.map((level) => ({
          price: 100 - level.price,
          size: level.size,
        }));

  const bidsDesc = withCumulative(bids);
  const asksAsc = withCumulative(asks);
  const asksDesc = [...asksAsc].reverse();
  const maxCumulative = Math.max(
    bidsDesc[bidsDesc.length - 1]?.cumulative ?? 0,
    asksAsc[asksAsc.length - 1]?.cumulative ?? 0,
    1,
  );
  const displayLast =
    lastPrice === null ? null : view === "YES" ? lastPrice : 100 - lastPrice;

  return (
    <section className="border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          Order book
        </h3>

        <div className="flex items-center gap-1" role="group" aria-label="Book side">
          {(["YES", "NO"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={view === entry}
              onClick={() => onViewChange(entry)}
              className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
                view === entry
                  ? "border-ink bg-ink text-paper"
                  : "border-line text-muted hover:border-ink hover:text-ink"
              }`}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] border-b border-line px-5 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
        <span>Price ({view})</span>
        <span>Size</span>
      </div>

      <div className="px-2 py-1">
        {asksDesc.length === 0 ? (
          <p className="px-3 py-3 text-center font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
            No asks
          </p>
        ) : (
          asksDesc.map((level) => (
            <button
              key={`ask-${level.price}`}
              type="button"
              onClick={() => onSelect("ask", level.price)}
              className="relative grid w-full grid-cols-[1fr_auto] items-center overflow-hidden px-3 py-1 text-left transition-colors hover:bg-no-soft/60"
              aria-label={`Buy ${view} at ${formatCents(level.price)}, ${formatCredits(level.size)} shares available`}
            >
              <span
                className="pointer-events-none absolute inset-y-0 right-0 bg-no/10"
                style={{
                  width: `${(level.cumulative / maxCumulative) * 100}%`,
                }}
                aria-hidden="true"
              />
              <span className="relative font-mono text-[11px] text-no">
                {formatCents(level.price)}
              </span>
              <span className="relative font-mono text-[11px] text-ink/80">
                {formatCredits(level.size)}
              </span>
            </button>
          ))
        )}

        <div className="flex items-center justify-between border-y border-line px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
          <span>
            Spread{" "}
            <span className="text-ink">
              {book.spread === null ? "—" : formatCents(book.spread)}
            </span>
          </span>
          <span>
            Last{" "}
            <span className="text-ink">
              {displayLast === null ? "—" : formatCents(displayLast)}
            </span>
          </span>
        </div>

        {bidsDesc.length === 0 ? (
          <p className="px-3 py-3 text-center font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
            No bids
          </p>
        ) : (
          bidsDesc.map((level) => (
            <button
              key={`bid-${level.price}`}
              type="button"
              onClick={() => onSelect("bid", level.price)}
              className="relative grid w-full grid-cols-[1fr_auto] items-center overflow-hidden px-3 py-1 text-left transition-colors hover:bg-yes-soft/60"
              aria-label={`Sell ${view} at ${formatCents(level.price)}, ${formatCredits(level.size)} shares bid`}
            >
              <span
                className="pointer-events-none absolute inset-y-0 right-0 bg-yes/10"
                style={{
                  width: `${(level.cumulative / maxCumulative) * 100}%`,
                }}
                aria-hidden="true"
              />
              <span className="relative font-mono text-[11px] text-yes">
                {formatCents(level.price)}
              </span>
              <span className="relative font-mono text-[11px] text-ink/80">
                {formatCredits(level.size)}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

export function TradeTape({ trades }: { trades: TradeTapeItem[] }) {
  return (
    <section className="border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          Recent trades
        </h3>
      </div>

      {trades.length === 0 ? (
        <p className="px-5 py-8 text-center font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
          No trades yet
        </p>
      ) : (
        <ul>
          {trades.slice(0, 16).map((trade) => {
            const ownPrice =
              trade.takerOutcome === "YES"
                ? trade.yesPrice
                : 100 - trade.yesPrice;
            const isBuy = trade.takerAction === "BUY";

            return (
              <li
                key={trade.id}
                className="grid grid-cols-[52px_1fr_auto_auto] items-center gap-3 border-b border-line/60 px-5 py-1.5 last:border-0"
              >
                <span className="font-mono text-[9px] text-muted">
                  {formatTapeTime(trade.createdAt)}
                </span>
                <span
                  className={`font-mono text-[9px] uppercase tracking-[0.08em] ${
                    isBuy ? "text-yes" : "text-no"
                  }`}
                >
                  {trade.takerAction} {trade.takerOutcome}
                </span>
                <span className="font-mono text-[10px] text-ink">
                  {formatCents(ownPrice)}
                </span>
                <span className="font-mono text-[10px] text-muted">
                  ×{formatCredits(trade.quantity)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
