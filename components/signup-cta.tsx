"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";

export default function SignupCta() {
  const { status } = useSession();

  if (status === "authenticated") {
    return null;
  }

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 lg:py-24">
      <div className="grid gap-8 border border-ink bg-surface p-8 sm:p-12 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
            Start forecasting
          </p>
          <h2 className="mt-3 max-w-[17ch] text-balance font-display text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
            Your first 1,000 credits are on us.
          </h2>
          <p className="mt-4 max-w-[46ch] text-sm leading-6 text-muted">
            Open an account, take a side, and find out how good your read on
            the future really is.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          <Link
            href="/register"
            className="inline-flex items-center justify-center gap-3 bg-accent px-5 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white transition-opacity hover:opacity-90"
          >
            Open an account <span aria-hidden="true">→</span>
          </Link>
          <Link
            href="/markets"
            className="inline-flex items-center justify-center border border-line-strong px-5 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink transition-colors hover:border-ink"
          >
            Browse markets
          </Link>
        </div>
      </div>
    </section>
  );
}
