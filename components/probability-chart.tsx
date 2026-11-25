"use client";

import { useMemo, useRef, useState } from "react";
import { formatCredits, formatCents } from "@/lib/format";

export type CandleInput = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export const CHART_RANGES = ["1H", "1D", "1W", "1M", "ALL"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export type ChartMode = "line" | "candles";

const WIDTH = 760;
const HEIGHT = 300;
const LEFT = 8;
const RIGHT = 58;
const TOP = 16;
const BOTTOM = 30;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

const GRADIENT_ID = "price-area-wash";

function niceStep(rawStep: number) {
  const candidates = [1, 2, 5, 10, 20, 25];
  return candidates.find((candidate) => candidate >= rawStep) ?? 25;
}

function formatAxisLabel(
  value: number,
  range: ChartRange,
  showTime: boolean,
) {
  const date = new Date(value);

  if (showTime) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(date);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatFullTime(value: number) {
  return `${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

type Point = { x: number; y: number };

/**
 * Monotone cubic interpolation (Fritsch–Carlson). It produces the soft line
 * used by stock charts without overshooting the data, so a probability never
 * appears to visit a value that never printed.
 */
function smoothPath(points: Point[]) {
  if (points.length === 0) {
    return "";
  }

  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const count = points.length;
  const dx: number[] = [];
  const secant: number[] = [];

  for (let index = 0; index < count - 1; index += 1) {
    dx[index] = Math.max(0.001, points[index + 1].x - points[index].x);
    secant[index] =
      (points[index + 1].y - points[index].y) / dx[index];
  }

  const tangent: number[] = new Array(count);
  tangent[0] = secant[0];
  tangent[count - 1] = secant[count - 2];

  for (let index = 1; index < count - 1; index += 1) {
    if (secant[index - 1] * secant[index] <= 0) {
      tangent[index] = 0;
      continue;
    }

    const weightA = 2 * dx[index] + dx[index - 1];
    const weightB = dx[index] + 2 * dx[index - 1];
    tangent[index] =
      (weightA + weightB) /
      (weightA / secant[index - 1] + weightB / secant[index]);
  }

  for (let index = 0; index < count - 1; index += 1) {
    if (secant[index] === 0) {
      tangent[index] = 0;
      tangent[index + 1] = 0;
      continue;
    }

    const alpha = tangent[index] / secant[index];
    const beta = tangent[index + 1] / secant[index];
    const magnitude = alpha * alpha + beta * beta;

    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangent[index] = scale * alpha * secant[index];
      tangent[index + 1] = scale * beta * secant[index];
    }
  }

  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;

  for (let index = 0; index < count - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const third = dx[index] / 3;
    const controlA = {
      x: start.x + third,
      y: start.y + tangent[index] * third,
    };
    const controlB = {
      x: end.x - third,
      y: end.y - tangent[index + 1] * third,
    };

    path += ` C ${controlA.x.toFixed(1)} ${controlA.y.toFixed(1)}, ${controlB.x.toFixed(1)} ${controlB.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  }

  return path;
}

export function ProbabilitySparkline({
  points,
  className = "",
}: {
  points: number[];
  className?: string;
}) {
  if (points.length < 2) {
    return null;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const center = (min + max) / 2;
  const spread = Math.max(max - min, 12);
  const lo = Math.max(0, center - spread / 2 - 1);
  const hi = Math.min(100, center + spread / 2 + 1);
  const denominator = hi - lo || 1;

  const xFor = (index: number) =>
    3 + (index / (points.length - 1)) * (168 - 6);
  const yFor = (value: number) => 29 - ((value - lo) / denominator) * 26;

  const line = points
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}`,
    )
    .join(" ");

  return (
    <svg
      viewBox="0 0 168 32"
      className={className}
      role="img"
      aria-label={`Yes price trend, ${Math.round(first)} to ${Math.round(last)} cents`}
    >
      <path
        d={line}
        fill="none"
        stroke={last >= first ? "var(--color-yes)" : "var(--color-no)"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={xFor(points.length - 1)}
        cy={yFor(last)}
        r="2.5"
        fill={last >= first ? "var(--color-yes)" : "var(--color-no)"}
        stroke="var(--color-paper)"
        strokeWidth="2"
      />
    </svg>
  );
}

export function PriceChart({
  candles,
  range,
  onRangeChange,
  mode,
  onModeChange,
  lastPrice,
  loading = false,
}: {
  candles: CandleInput[];
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  mode: ChartMode;
  onModeChange: (mode: ChartMode) => void;
  lastPrice: number | null;
  loading?: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const geometry = useMemo(() => {
    if (candles.length === 0) {
      return null;
    }

    const times = candles.map((candle) => new Date(candle.t).getTime());
    const start = times[0];
    const end = times[times.length - 1];
    const timeSpan = Math.max(0, end - start);

    const lows = candles.map((candle) => candle.l);
    const highs = candles.map((candle) => candle.h);
    const rawMin = Math.min(...lows);
    const rawMax = Math.max(...highs);
    const padding = Math.max(3, (rawMax - rawMin) * 0.2);
    const yMin = Math.max(0, Math.floor((rawMin - padding) / 5) * 5);
    const yMax = Math.min(100, Math.ceil((rawMax + padding) / 5) * 5);
    const ySpan = Math.max(10, yMax - yMin);

    const xFor = (time: number) =>
      timeSpan <= 0
        ? LEFT + PLOT_WIDTH / 2
        : LEFT + ((time - start) / timeSpan) * PLOT_WIDTH;
    const yFor = (value: number) =>
      TOP + (1 - (value - yMin) / ySpan) * PLOT_HEIGHT;

    const coordinates = candles.map((candle, index) => ({
      x: xFor(times[index]),
      y: yFor(candle.c),
      value: candle.c,
      time: times[index],
      index,
    }));

    const line =
      coordinates.length === 1
        ? `M ${LEFT} ${coordinates[0].y.toFixed(1)} L ${WIDTH - RIGHT} ${coordinates[0].y.toFixed(1)}`
        : smoothPath(coordinates);
    const areaLeft =
      coordinates.length === 1 ? LEFT : coordinates[0].x;
    const areaRight =
      coordinates.length === 1
        ? WIDTH - RIGHT
        : coordinates[coordinates.length - 1].x;
    const area = `${line} L ${areaRight.toFixed(1)} ${TOP + PLOT_HEIGHT} L ${areaLeft.toFixed(1)} ${TOP + PLOT_HEIGHT} Z`;

    let minGap = Number.POSITIVE_INFINITY;
    for (let index = 1; index < times.length; index += 1) {
      const gap = times[index] - times[index - 1];
      if (gap > 0) {
        minGap = Math.min(minGap, gap);
      }
    }

    const candleWidth =
      timeSpan > 0 && Number.isFinite(minGap)
        ? Math.max(
            2,
            Math.min(14, (minGap / timeSpan) * PLOT_WIDTH * 0.62),
          )
        : 6;

    const step = niceStep(ySpan / 3);
    const ticks: number[] = [];
    for (
      let value = Math.ceil(yMin / step) * step;
      value <= yMax;
      value += step
    ) {
      ticks.push(value);
    }

    const firstValue = candles[0].c;
    const last = candles[candles.length - 1];
    const change = last.c - firstValue;
    const percent =
      firstValue > 0 ? (change / firstValue) * 100 : null;
    const color =
      change >= 0 ? "var(--color-yes)" : "var(--color-no)";
    const lastX = xFor(times[times.length - 1]);
    const lastY = yFor(last.c);

    const labelTimes =
      timeSpan <= 0
        ? [start]
        : [start, start + timeSpan / 2, end];
    const showTime =
      range === "1H" || range === "1D" || timeSpan <= 48 * 60 * 60 * 1000;
    const xLabels = labelTimes.map((time, index) => ({
      x: timeSpan <= 0 ? LEFT + PLOT_WIDTH / 2 : xFor(time),
      text: formatAxisLabel(time, range, showTime),
      anchor:
        index === 0
          ? ("start" as const)
          : index === labelTimes.length - 1
            ? ("end" as const)
            : ("middle" as const),
    }));

    return {
      coordinates,
      line,
      area,
      yMin,
      yMax,
      ticks,
      yFor,
      candleWidth,
      color,
      change,
      percent,
      firstValue,
      lastX,
      lastY,
      lastValue: last.c,
      xLabels,
    };
  }, [candles, range]);

  const active =
    activeIndex !== null && candles[activeIndex]
      ? { candle: candles[activeIndex], coordinate: geometry?.coordinates[activeIndex] }
      : null;

  function handlePointerMove(event: React.PointerEvent<SVGRectElement>) {
    if (!geometry || !svgRef.current) {
      return;
    }

    const bounds = svgRef.current.getBoundingClientRect();
    const pointerX = ((event.clientX - bounds.left) / bounds.width) * WIDTH;

    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;

    geometry.coordinates.forEach((coordinate, index) => {
      const delta = Math.abs(coordinate.x - pointerX);
      if (delta < distance) {
        distance = delta;
        nearest = index;
      }
    });

    setActiveIndex(nearest);
  }

  function handleKeyDown(event: React.KeyboardEvent<SVGSVGElement>) {
    if (!geometry) {
      return;
    }

    const lastIndex = geometry.coordinates.length - 1;
    const current = activeIndex ?? lastIndex;

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setActiveIndex(Math.min(lastIndex, current + 1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveIndex(Math.max(0, current - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(lastIndex);
    }
  }

  const tableRows = useMemo(() => {
    const stride = Math.max(1, Math.ceil(candles.length / 40));
    return candles.filter((_, index) => index % stride === 0);
  }, [candles]);

  const deltaClass =
    !geometry || geometry.change === 0
      ? "text-muted"
      : geometry.change > 0
        ? "text-yes"
        : "text-no";

  const tagY = active?.coordinate?.y ?? geometry?.lastY ?? null;
  const lastTagValue = active?.candle.c ?? geometry?.lastValue ?? lastPrice;

  return (
    <div className="border-t border-line px-5 py-5 sm:px-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            Price history
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted">
            <span>Yes · {range}</span>
            {geometry && (
              <span className={deltaClass}>
                {geometry.change > 0 ? "+" : ""}
                {geometry.change}¢
                {geometry.percent !== null
                  ? ` (${geometry.change > 0 ? "+" : ""}${geometry.percent.toFixed(1)}%)`
                  : ""}
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Chart type"
          >
            {(["line", "candles"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={mode === entry}
                onClick={() => onModeChange(entry)}
                className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
                  mode === entry
                    ? "border-ink bg-ink text-paper"
                    : "border-line text-muted hover:border-ink hover:text-ink"
                }`}
              >
                {entry === "line" ? "Line" : "Candles"}
              </button>
            ))}
          </div>

          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Time range"
          >
            {CHART_RANGES.map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={range === entry}
                onClick={() => {
                  onRangeChange(entry);
                  setActiveIndex(null);
                }}
                className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
                  range === entry
                    ? "border-ink bg-ink text-paper"
                    : "border-line text-muted hover:border-ink hover:text-ink"
                }`}
              >
                {entry === "ALL" ? "All" : entry}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && candles.length === 0 ? (
        <div className="flex h-64 items-center justify-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Loading chart
          </p>
        </div>
      ) : !geometry ? (
        <div className="flex h-64 items-center justify-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            No trades in this range
          </p>
        </div>
      ) : (
        <div
          className={`relative mt-4 transition-opacity ${
            loading ? "opacity-60" : "opacity-100"
          }`}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full touch-none"
            role="img"
            aria-label={`Yes price history over ${range}, from ${formatCents(geometry.firstValue)} to ${formatCents(geometry.lastValue)}. Use arrow keys to inspect points.`}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onFocus={() =>
              setActiveIndex((current) => current ?? geometry.coordinates.length - 1)
            }
            onBlur={() => setActiveIndex(null)}
          >
            <defs>
              <linearGradient
                id={GRADIENT_ID}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={geometry.color}
                  stopOpacity="0.16"
                />
                <stop
                  offset="100%"
                  stopColor={geometry.color}
                  stopOpacity="0.01"
                />
              </linearGradient>
            </defs>

            {geometry.ticks.map((value) => {
              const y = geometry.yFor(value);
              const showLabel =
                tagY === null || Math.abs(y - tagY) > 11;

              return (
                <g key={value}>
                  <line
                    x1={LEFT}
                    x2={WIDTH - RIGHT}
                    y1={y}
                    y2={y}
                    stroke="var(--color-line)"
                    strokeWidth="1"
                  />
                  {showLabel && (
                    <text
                      x={WIDTH - RIGHT + 8}
                      y={y}
                      textAnchor="start"
                      dominantBaseline="middle"
                      fill="var(--color-muted)"
                      fontFamily="var(--font-plex-mono), monospace"
                      fontSize="9"
                    >
                      {value}¢
                    </text>
                  )}
                </g>
              );
            })}

            {mode === "line" ? (
              <>
                <path d={geometry.area} fill={`url(#${GRADIENT_ID})`} />
                <path
                  d={geometry.line}
                  fill="none"
                  stroke={geometry.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </>
            ) : (
              candles.map((candle, index) => {
                const coordinate = geometry.coordinates[index];
                const up = candle.c >= candle.o;
                const color = up
                  ? "var(--color-yes)"
                  : "var(--color-no)";
                const bodyTop = geometry.yFor(
                  Math.max(candle.o, candle.c),
                );
                const bodyBottom = geometry.yFor(
                  Math.min(candle.o, candle.c),
                );
                const bodyHeight = Math.max(1.5, bodyBottom - bodyTop);

                return (
                  <g key={candle.t}>
                    <line
                      x1={coordinate.x}
                      x2={coordinate.x}
                      y1={geometry.yFor(candle.h)}
                      y2={geometry.yFor(candle.l)}
                      stroke={color}
                      strokeWidth="1"
                    />
                    <rect
                      x={coordinate.x - geometry.candleWidth / 2}
                      y={bodyTop}
                      width={geometry.candleWidth}
                      height={bodyHeight}
                      fill={color}
                    />
                  </g>
                );
              })
            )}

            <line
              x1={LEFT}
              x2={WIDTH - RIGHT}
              y1={geometry.lastY}
              y2={geometry.lastY}
              stroke="var(--color-muted)"
              strokeDasharray="3 4"
              strokeWidth="1"
              opacity="0.55"
            />
            <circle
              cx={geometry.lastX}
              cy={geometry.lastY}
              r="4"
              fill={geometry.color}
              stroke="var(--color-surface)"
              strokeWidth="2"
              pointerEvents="none"
            />

            {geometry.xLabels.map((label) => (
              <text
                key={`${label.x}-${label.text}`}
                x={label.x}
                y={HEIGHT - 8}
                textAnchor={label.anchor}
                fill="var(--color-muted)"
                fontFamily="var(--font-plex-mono), monospace"
                fontSize="9"
              >
                {label.text}
              </text>
            ))}

            <rect
              x={LEFT}
              y={TOP}
              width={PLOT_WIDTH}
              height={PLOT_HEIGHT}
              fill="transparent"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setActiveIndex(null)}
            />

            {active?.coordinate && (
              <g pointerEvents="none">
                <line
                  x1={active.coordinate.x}
                  x2={active.coordinate.x}
                  y1={TOP}
                  y2={TOP + PLOT_HEIGHT}
                  stroke="var(--color-line-strong)"
                  strokeWidth="1"
                />
                <line
                  x1={LEFT}
                  x2={WIDTH - RIGHT}
                  y1={active.coordinate.y}
                  y2={active.coordinate.y}
                  stroke="var(--color-line-strong)"
                  strokeWidth="1"
                  opacity="0.6"
                />
                <circle
                  cx={active.coordinate.x}
                  cy={active.coordinate.y}
                  r="4"
                  fill={geometry.color}
                  stroke="var(--color-surface)"
                  strokeWidth="2"
                />
              </g>
            )}

            {tagY !== null && lastTagValue !== null && (
              <g pointerEvents="none">
                <rect
                  x={WIDTH - RIGHT + 8}
                  y={tagY - 8}
                  width={RIGHT - 16}
                  height={16}
                  fill="var(--color-ink)"
                />
                <text
                  x={WIDTH - RIGHT + 12}
                  y={tagY + 3}
                  fill="var(--color-paper)"
                  fontFamily="var(--font-plex-mono), monospace"
                  fontSize="9"
                >
                  {formatCents(lastTagValue)}
                </text>
              </g>
            )}
          </svg>

          {active?.coordinate && (
            <div
              className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 border border-line bg-surface px-2.5 py-2 whitespace-nowrap"
              style={{
                left: `${Math.min(86, Math.max(14, (active.coordinate.x / WIDTH) * 100))}%`,
              }}
            >
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
                {formatFullTime(active.candle.t ? new Date(active.candle.t).getTime() : 0)}
              </p>
              <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-ink">
                <span
                  className="inline-block h-0.5 w-3"
                  style={{ backgroundColor: geometry.color }}
                  aria-hidden="true"
                />
                YES {formatCents(active.candle.c)}
              </p>
              {mode === "candles" && (
                <p className="mt-0.5 font-mono text-[10px] text-muted">
                  O {formatCents(active.candle.o)} · H {formatCents(active.candle.h)} · L{" "}
                  {formatCents(active.candle.l)} · V {formatCredits(active.candle.v)}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {geometry && (
        <details className="mt-3 border-t border-line pt-2">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:text-ink">
            View data
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] font-mono text-[10px] text-ink">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-1.5 pr-4 font-normal uppercase tracking-[0.1em]">
                    Time (UTC)
                  </th>
                  <th className="py-1.5 pr-4 text-right font-normal uppercase tracking-[0.1em]">
                    Open
                  </th>
                  <th className="py-1.5 pr-4 text-right font-normal uppercase tracking-[0.1em]">
                    High
                  </th>
                  <th className="py-1.5 pr-4 text-right font-normal uppercase tracking-[0.1em]">
                    Low
                  </th>
                  <th className="py-1.5 pr-4 text-right font-normal uppercase tracking-[0.1em]">
                    Close
                  </th>
                  <th className="py-1.5 text-right font-normal uppercase tracking-[0.1em]">
                    Volume
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((candle) => (
                  <tr
                    key={candle.t}
                    className="border-b border-line/60 last:border-0"
                  >
                    <td className="py-1.5 pr-4">
                      {formatFullTime(new Date(candle.t).getTime())}
                    </td>
                    <td className="py-1.5 pr-4 text-right">
                      {formatCents(candle.o)}
                    </td>
                    <td className="py-1.5 pr-4 text-right">
                      {formatCents(candle.h)}
                    </td>
                    <td className="py-1.5 pr-4 text-right">
                      {formatCents(candle.l)}
                    </td>
                    <td className="py-1.5 pr-4 text-right">
                      {formatCents(candle.c)}
                    </td>
                    <td className="py-1.5 text-right">
                      {formatCredits(candle.v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
