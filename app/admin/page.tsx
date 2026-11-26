"use client";

import Link from "next/link";
import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { formatCents, formatCredits, formatDate } from "@/lib/format";
import { apiErrorBody, apiErrorMessage, axios } from "@/lib/http";

type MarketStatus = "DRAFT" | "OPEN" | "CLOSED" | "RESOLVED" | "VOID";
type Outcome = "YES" | "NO";

type AdminMarket = {
  id: string;
  slug: string;
  question: string;
  category: string;
  status: MarketStatus;
  closesAt: string;
  createdAt: string;
  resolution: {
    outcome: Outcome;
    notes: string | null;
    evidenceUrl: string | null;
    resolvedAt: string;
  } | null;
  stats: {
    lastPrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    spread: number | null;
    volume24h: number;
    trades24h: number;
    openInterest: number;
    change24h: number | null;
    spark: number[];
  } | null;
};

type AdminMarketsResponse = {
  markets: AdminMarket[];
  pagination: {
    page: number;
    limit: number;
    totalMarkets: number;
    totalPages: number;
  };
};

type Notice = { tone: "success" | "error"; message: string };

const STATUS_OPTIONS: { value: MarketStatus | "ALL"; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "OPEN", label: "Open" },
  { value: "CLOSED", label: "Closed" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "VOID", label: "Void" },
];

const STATUS_CLASSES: Record<MarketStatus, string> = {
  DRAFT: "border-line text-muted",
  OPEN: "border-yes/40 bg-yes-soft text-yes",
  CLOSED: "border-accent/40 bg-accent-soft text-accent",
  RESOLVED: "border-ink/20 bg-surface text-ink",
  VOID: "border-no/40 bg-no-soft text-no",
};

type MarketForm = {
  slug: string;
  question: string;
  category: string;
  closesAt: string;
  description: string;
  rules: string;
};

const EMPTY_FORM: MarketForm = {
  slug: "",
  question: "",
  category: "",
  closesAt: "",
  description: "",
  rules: "",
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
}

function toLocalInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function firstFieldError(details: unknown): string | null {
  if (!details || typeof details !== "object") {
    return null;
  }

  const fieldErrors = (details as { fieldErrors?: Record<string, string[]> })
    .fieldErrors;

  if (!fieldErrors) {
    return null;
  }

  for (const messages of Object.values(fieldErrors)) {
    if (Array.isArray(messages) && messages.length > 0) {
      return messages[0];
    }
  }

  return null;
}

export default function AdminPage() {
  const [status, setStatus] = useState<MarketStatus | "ALL">("ALL");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminMarketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [form, setForm] = useState<MarketForm>(EMPTY_FORM);
  const [slugTouched, setSlugTouched] = useState(false);

  const loadMarkets = useCallback(
    async (targetStatus: MarketStatus | "ALL", targetPage: number) => {
      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          limit: "50",
        });
        if (targetStatus !== "ALL") {
          params.set("status", targetStatus);
        }

        const { data: payload } = await axios.get<AdminMarketsResponse>(
          `/api/admin/markets?${params}`,
        );

        setForbidden(false);
        setData(payload);
      } catch (loadError) {
        if (
          axios.isAxiosError(loadError) &&
          (loadError.response?.status === 401 ||
            loadError.response?.status === 403)
        ) {
          setForbidden(true);
          setData(null);
          return;
        }

        setError(apiErrorMessage(loadError, "Unable to load markets."));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    loadMarkets(status, page);
  }, [loadMarkets, status, page]);

  function refresh() {
    setExpandedSlug(null);
    setNotes("");
    loadMarkets(status, page);
  }

  async function runAction(
    market: AdminMarket,
    action: "open" | "close" | "resolve" | "void",
    body?: Record<string, unknown>,
  ) {
    const key = `${market.slug}:${action}`;
    if (pendingKey) {
      return;
    }

    setPendingKey(key);
    setNotice(null);

    try {
      const { data: payload } = await axios.post<{
        settlement?: {
          outcome: Outcome;
          winners: number;
          totalPayout: number;
        };
        refund?: {
          totalRefund: number;
          holders: number;
          price: number;
        };
      }>(`/api/admin/markets/${market.slug}/${action}`, body);

      if (action === "resolve" && payload.settlement) {
        const { outcome, winners, totalPayout } = payload.settlement;
        setNotice({
          tone: "success",
          message: `Resolved ${outcome}: ${formatCredits(totalPayout)} cr paid to ${winners} ${winners === 1 ? "winner" : "winners"}.`,
        });
      } else if (action === "void" && payload.refund) {
        const { totalRefund, holders, price } = payload.refund;
        setNotice({
          tone: "success",
          message: `Voided: ${formatCredits(totalRefund)} cr returned across ${holders} ${holders === 1 ? "holder" : "holders"} at ${formatCents(price)}.`,
        });
      } else {
        setNotice({
          tone: "success",
          message:
            action === "open"
              ? `“${market.question}” is now open for trading.`
              : `“${market.question}” is now closed.`,
        });
      }

      refresh();
    } catch (actionError) {
      setNotice({
        tone: "error",
        message: apiErrorMessage(actionError, "Action failed."),
      });
    } finally {
      setPendingKey(null);
    }
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setSlugTouched(false);
    setCreateError("");
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!form.closesAt) {
      setCreateError("Choose a closing date and time.");
      return;
    }

    setCreating(true);
    setCreateError("");
    setNotice(null);

    try {
      const { data: payload } = await axios.post<{
        market: { question: string };
      }>("/api/markets", {
        slug: form.slug,
        question: form.question,
        description: form.description,
        rules: form.rules,
        category: form.category,
        closesAt: new Date(form.closesAt).toISOString(),
      });

      setNotice({
        tone: "success",
        message: `Draft created: “${payload.market.question}”.`,
      });
      resetForm();
      setShowCreate(false);

      if (status === "DRAFT" && page === 1) {
        refresh();
      } else {
        setStatus("DRAFT");
        setPage(1);
      }
    } catch (createFailure) {
      const body = apiErrorBody<{
        details?: unknown;
        error?: string;
      }>(createFailure);

      setCreateError(
        firstFieldError(body?.details) ??
          body?.error ??
          "Unable to create market.",
      );
    } finally {
      setCreating(false);
    }
  }

  const markets = data?.markets ?? [];
  const pagination = data?.pagination;
  const pageVolume = markets.reduce(
    (sum, market) => sum + (market.stats?.volume24h ?? 0),
    0,
  );
  const needsSettlement = markets.filter(
    (market) => market.status === "CLOSED",
  ).length;

  return (
    <main>
      <section className="border-b border-line">
        <div className="mx-auto w-full max-w-7xl px-4 pb-10 pt-12 sm:px-6 sm:pb-12 sm:pt-16">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
            Operations
          </p>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
            <h1 className="font-display text-5xl font-semibold tracking-[-0.04em] sm:text-6xl">
              Admin console
            </h1>

            <dl className="flex gap-8 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              <div>
                <dt>Markets</dt>
                <dd className="mt-1 text-sm normal-case tracking-normal text-ink">
                  {pagination ? formatCredits(pagination.totalMarkets) : "—"}
                </dd>
              </div>
              <div>
                <dt>24h volume on page</dt>
                <dd className="mt-1 text-sm normal-case tracking-normal text-ink">
                  {data ? `${formatCredits(pageVolume)} shares` : "—"}
                </dd>
              </div>
              <div>
                <dt>To settle</dt>
                <dd className="mt-1 text-sm normal-case tracking-normal text-ink">
                  {data ? needsSettlement : "—"}
                </dd>
              </div>
            </dl>
          </div>

          <p className="mt-4 max-w-[58ch] text-sm leading-6 text-muted">
            Open, close, resolve, and void markets. Settlement pays 100 credits
            per winning share and is final — every action writes to the audit
            log.
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4">
          <div className="flex flex-wrap gap-1">
            {STATUS_OPTIONS.map((option) => {
              const isActive = status === option.value;

              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setStatus(option.value);
                    setPage(1);
                    setExpandedSlug(null);
                  }}
                  className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                    isActive
                      ? "bg-ink text-paper"
                      : "text-muted hover:bg-surface hover:text-ink"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              aria-expanded={showCreate}
              aria-controls="create-market"
              onClick={() => {
                setShowCreate((current) => !current);
                setCreateError("");
              }}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                showCreate
                  ? "border border-ink bg-ink text-paper"
                  : "border border-ink text-ink hover:bg-ink hover:text-paper"
              }`}
            >
              {showCreate ? "Cancel" : "+ New market"}
            </button>
            <button
              type="button"
              onClick={refresh}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:text-ink"
            >
              Refresh
            </button>
          </div>
        </div>

        {showCreate && (
          <form
            id="create-market"
            onSubmit={handleCreate}
            className="border-b border-line bg-surface px-4 py-6 sm:px-6"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">
                  New listing
                </p>
                <h2 className="mt-1 font-display text-xl font-semibold tracking-[-0.02em]">
                  Draft a market
                </h2>
              </div>
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                Created as draft — open it when ready
              </p>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  Question
                </span>
                <input
                  required
                  minLength={5}
                  maxLength={100}
                  value={form.question}
                  onChange={(event) => {
                    const question = event.target.value;
                    setForm((current) => ({
                      ...current,
                      question,
                      slug: slugTouched ? current.slug : slugify(question),
                    }));
                  }}
                  placeholder="Will the flagship model ship before July?"
                  className="mt-1.5 h-10 w-full border border-line bg-paper px-3 text-sm text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-ink"
                />
              </label>

              <label className="block">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  Category
                </span>
                <input
                  required
                  minLength={2}
                  maxLength={20}
                  value={form.category}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      category: event.target.value,
                    }))
                  }
                  placeholder="AI models"
                  className="mt-1.5 h-10 w-full border border-line bg-paper px-3 text-sm text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-ink"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  Slug
                </span>
                <input
                  required
                  minLength={3}
                  maxLength={100}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  title="Lowercase kebab-case, e.g. flagship-model-2027"
                  value={form.slug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setForm((current) => ({
                      ...current,
                      slug: event.target.value,
                    }));
                  }}
                  placeholder="flagship-model-2027"
                  className="mt-1.5 h-10 w-full border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-ink"
                />
              </label>

              <label className="block">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  Closes at
                </span>
                <input
                  type="datetime-local"
                  required
                  min={toLocalInputValue(new Date())}
                  value={form.closesAt}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      closesAt: event.target.value,
                    }))
                  }
                  className="mt-1.5 h-10 w-full border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none transition-colors focus:border-ink"
                />
              </label>

              <label className="block sm:col-span-3">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  Description
                </span>
                <textarea
                  required
                  minLength={10}
                  maxLength={200}
                  rows={2}
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  placeholder="What this market measures, in one or two sentences."
                  className="mt-1.5 w-full border border-line bg-paper px-3 py-2 text-sm leading-6 text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-ink"
                />
              </label>

              <label className="block sm:col-span-3">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  Resolution rules
                </span>
                <textarea
                  required
                  minLength={5}
                  maxLength={100}
                  rows={2}
                  value={form.rules}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      rules: event.target.value,
                    }))
                  }
                  placeholder="The exact source and condition used to settle it."
                  className="mt-1.5 w-full border border-line bg-paper px-3 py-2 text-sm leading-6 text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-ink"
                />
              </label>
            </div>

            {createError && (
              <p
                role="alert"
                className="mt-4 border-l-2 border-no bg-no-soft px-3 py-2 text-sm text-no"
              >
                {createError}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={creating}
                className="bg-ink px-4 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
              >
                {creating ? "Creating…" : "Create draft"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  resetForm();
                }}
                className="border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                Discard
              </button>
            </div>
          </form>
        )}

        {notice && (
          <div
            role="status"
            className={`border-b px-4 py-3 text-sm ${
              notice.tone === "success"
                ? "border-yes/30 bg-yes-soft text-yes"
                : "border-no/30 bg-no-soft text-no"
            }`}
          >
            {notice.message}
          </div>
        )}

        {forbidden ? (
          <div className="border-b border-line py-16">
            <p className="font-display text-2xl font-medium tracking-[-0.02em]">
              Admin access required.
            </p>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted">
              Sign in with an administrator account to manage markets.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-flex border border-ink bg-ink px-4 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-paper transition-colors hover:bg-ink/85"
            >
              Sign in
            </Link>
          </div>
        ) : loading ? (
          <div aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="flex items-center justify-between gap-4 border-b border-line py-5"
              >
                <div className="min-w-0 flex-1">
                  <div className="h-4 w-64 animate-pulse bg-line" />
                  <div className="mt-2 h-3 w-32 animate-pulse bg-line" />
                </div>
                <div className="h-6 w-20 animate-pulse bg-line" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div
            role="alert"
            className="border-b border-no/30 bg-no-soft px-4 py-4 text-sm text-no"
          >
            {error}
          </div>
        ) : markets.length === 0 ? (
          <div className="border-b border-line py-16">
            <p className="font-display text-2xl font-medium tracking-[-0.02em]">
              No markets in this view.
            </p>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted">
              Switch the status filter or seed the board to get started.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <caption className="sr-only">
                Market administration table with settlement actions
              </caption>
              <thead>
                <tr className="border-b border-line font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  <th scope="col" className="py-3 pr-2 text-left font-normal">
                    Market
                  </th>
                  <th scope="col" className="w-24 py-3 pr-2 text-left font-normal">
                    Status
                  </th>
                  <th scope="col" className="w-40 py-3 pr-2 text-left font-normal">
                    Price
                  </th>
                  <th scope="col" className="w-28 py-3 text-left font-normal">
                    Closes
                  </th>
                  <th scope="col" className="w-44 py-3 text-right font-normal">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {markets.map((market) => {
                  const isExpanded = expandedSlug === market.slug;
                  const stats = market.stats;

                  return (
                    <Fragment key={market.id}>
                      <tr className="border-b border-line align-middle">
                        <td className="py-4 pr-3">
                          <Link
                            href={`/markets/${market.slug}`}
                            className="block max-w-md truncate text-sm text-ink transition-colors hover:text-accent"
                          >
                            {market.question}
                          </Link>
                          <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                            {market.category} · {market.slug}
                          </span>
                        </td>
                        <td className="py-4 pr-2">
                          <span
                            className={`inline-flex border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${STATUS_CLASSES[market.status]}`}
                          >
                            {market.status}
                          </span>
                        </td>
                        <td className="py-4 pr-2">
                          <span className="block font-mono text-sm text-ink">
                            {stats?.lastPrice === null || !stats
                              ? "—"
                              : formatCents(stats.lastPrice)}
                          </span>
                          <span className="mt-0.5 block font-mono text-[10px] text-muted">
                            Bid{" "}
                            {stats?.bestBid === null || !stats
                              ? "—"
                              : formatCents(stats.bestBid)}{" "}
                            · Ask{" "}
                            {stats?.bestAsk === null || !stats
                              ? "—"
                              : formatCents(stats.bestAsk)}
                          </span>
                          <span className="mt-0.5 block font-mono text-[10px] text-muted">
                            {formatCredits(stats?.volume24h ?? 0)} shares · 24h
                          </span>
                        </td>
                        <td className="py-4 font-mono text-[10px] text-muted">
                          {formatDate(market.closesAt)}
                        </td>
                        <td className="py-4 text-right">
                          {market.status === "DRAFT" && (
                            <button
                              type="button"
                              onClick={() => runAction(market, "open")}
                              disabled={pendingKey !== null}
                              className="border border-ink bg-ink px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
                            >
                              {pendingKey === `${market.slug}:open`
                                ? "Opening…"
                                : "Open"}
                            </button>
                          )}

                          {market.status === "OPEN" && (
                            <button
                              type="button"
                              onClick={() => runAction(market, "close")}
                              disabled={pendingKey !== null}
                              className="border border-line px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink transition-colors hover:border-line-strong hover:bg-surface disabled:opacity-40"
                            >
                              {pendingKey === `${market.slug}:close`
                                ? "Closing…"
                                : "Close"}
                            </button>
                          )}

                          {market.status === "CLOSED" && (
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              aria-controls={`settle-${market.slug}`}
                              onClick={() => {
                                setExpandedSlug(isExpanded ? null : market.slug);
                                setNotes("");
                              }}
                              className={`px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors ${
                                isExpanded
                                  ? "border border-ink bg-ink text-paper"
                                  : "border border-ink text-ink hover:bg-ink hover:text-paper"
                              }`}
                            >
                              {isExpanded ? "Cancel" : "Settle"}
                            </button>
                          )}

                          {market.resolution && (
                            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                              {market.resolution.outcome}
                            </span>
                          )}
                        </td>
                      </tr>

                      {isExpanded && market.status === "CLOSED" && (
                        <tr id={`settle-${market.slug}`} className="border-b border-line">
                          <td colSpan={5} className="bg-surface px-4 py-5">
                            <div className="flex flex-wrap items-end justify-between gap-4">
                              <div className="min-w-0">
                                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">
                                  Settlement · final
                                </p>
                                <p className="mt-1 max-w-lg text-sm leading-5 text-muted">
                                  {!stats || stats.openInterest === 0
                                    ? "No shares are outstanding. Resolving records the outcome; voiding returns nothing."
                                    : `Winning shares pay 100 credits each; losing shares expire at 0. Open interest is ${formatCredits(stats.openInterest)} shares.`}
                                </p>
                                <p className="mt-1 font-mono text-[10px] text-muted">
                                  Voiding unwinds positions at the last traded
                                  price ({stats?.lastPrice === null || !stats
                                    ? "50¢"
                                    : formatCents(stats.lastPrice)}) and
                                  cancels every resting order.
                                </p>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  type="text"
                                  value={notes}
                                  onChange={(event) =>
                                    setNotes(event.target.value)
                                  }
                                  placeholder="Resolution note (optional)"
                                  maxLength={2000}
                                  className="h-9 w-56 border border-line bg-paper px-3 font-mono text-[11px] text-ink outline-none placeholder:text-muted focus:border-ink"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    runAction(market, "resolve", {
                                      outcome: "YES",
                                      notes,
                                    })
                                  }
                                  disabled={pendingKey !== null}
                                  className="h-9 bg-yes px-3 font-mono text-[9px] uppercase tracking-[0.12em] text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
                                >
                                  {pendingKey === `${market.slug}:resolve`
                                    ? "Settling…"
                                    : "Resolve YES"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    runAction(market, "resolve", {
                                      outcome: "NO",
                                      notes,
                                    })
                                  }
                                  disabled={pendingKey !== null}
                                  className="h-9 bg-no px-3 font-mono text-[9px] uppercase tracking-[0.12em] text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
                                >
                                  {pendingKey === `${market.slug}:resolve`
                                    ? "Settling…"
                                    : "Resolve NO"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    runAction(market, "void", { notes })
                                  }
                                  disabled={pendingKey !== null}
                                  className="h-9 border border-line px-3 font-mono text-[9px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-no hover:text-no disabled:opacity-40"
                                >
                                  {pendingKey === `${market.slug}:void`
                                    ? "Voiding…"
                                    : "Void & unwind"}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between gap-3 border-b border-line py-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              Page {pagination.page} of {pagination.totalPages}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={pagination.page <= 1 || loading}
                className="border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink transition-colors hover:border-line-strong disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((current) =>
                    Math.min(pagination.totalPages, current + 1),
                  )
                }
                disabled={pagination.page >= pagination.totalPages || loading}
                className="border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink transition-colors hover:border-line-strong disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6">
        <p className="border-t border-line pt-6 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          Resolving credits 100 cr per winning share; voiding unwinds positions
          at the last traded price and cancels resting orders. Actions cannot be
          undone.
        </p>
      </div>
    </main>
  );
}
