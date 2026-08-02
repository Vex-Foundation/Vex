/**
 * MY LAUNCHES — the editorial column at the foot of the launch dialog.
 *
 * Its job is context, not decoration: before authorizing a spend it is worth
 * seeing what the last one did. It is a hairline-separated column (the section
 * grammar used across the shell), NOT a tile — a second card inside a dialog
 * would compete with the preview card, which is the surface that matters here.
 *
 * ── THE STATES LADDER IS THE HONESTY CONTRACT ─────────────────────────────
 * loading → error → **unavailable** → empty → content, and `unavailable` is a
 * SEPARATE rung from `empty` on purpose (the TokenHistory precedent). "We
 * couldn't read your launches" and "you have never launched a token" are
 * different claims, and only one of them is ours to make when a read degrades.
 * Rendering the empty invitation on a failed read would tell the user, in the
 * app that holds their money, that history they actually have does not exist.
 *
 * A LATER page failing never wipes the rows already on screen — pagination
 * stops and a quiet note appears by the footer instead.
 */

import type { JSX } from "react";
import type { MyLaunchRow, MyLaunchesResult } from "../../../lib/api/token-launch.js";
import type { Result } from "@shared/ipc/result.js";
import { useMyLaunches } from "../../../lib/api/token-launch.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";
import { formatClock } from "../../../lib/format.js";

/** A page that both succeeded AND was not degraded. */
function availablePage(page: Result<MyLaunchesResult>): MyLaunchesResult | null {
  return page.ok && page.data.status === "available" ? page.data : null;
}

export function MyLaunchesBlock(): JSX.Element {
  const query = useMyLaunches();
  const pages = query.data?.pages ?? [];
  const firstPage = pages[0];
  const rows = pages.flatMap((page) => availablePage(page)?.launches ?? []);

  const lastPage = pages.length > 1 ? pages[pages.length - 1] : undefined;
  const laterPageDegraded =
    lastPage !== undefined && availablePage(lastPage) === null;

  return (
    <section className="flex flex-col gap-2 border-t border-[var(--vex-line)] pt-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="vex-eyebrow">My launches</h3>
        {rows.length > 0 ? (
          <span className="font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
            {rows.length}
          </span>
        ) : null}
      </header>

      <Body
        loading={query.isLoading}
        errored={query.isError || (firstPage !== undefined && !firstPage.ok)}
        unavailable={
          firstPage !== undefined &&
          firstPage.ok &&
          firstPage.data.status !== "available"
        }
        rows={rows}
      />

      {laterPageDegraded ? (
        <p className="mt-1 text-[11px] text-[var(--vex-text-3)]">
          Couldn&apos;t load more launches right now.
        </p>
      ) : null}

      {query.hasNextPage ? (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="mt-2 w-full rounded-lg border border-[var(--vex-line)] py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-2)] transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:opacity-60"
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}

function Body({
  loading,
  errored,
  unavailable,
  rows,
}: {
  readonly loading: boolean;
  readonly errored: boolean;
  readonly unavailable: boolean;
  readonly rows: readonly MyLaunchRow[];
}): JSX.Element {
  if (loading) {
    return (
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
        Loading…
      </p>
    );
  }
  if (errored) {
    return (
      <p className="text-[12.5px] text-[var(--vex-warn-text)]">
        Couldn&apos;t load your launches.
      </p>
    );
  }
  // NOT the empty state — see the file header.
  if (unavailable) {
    return (
      <p className="text-[12.5px] leading-relaxed text-[var(--vex-text-2)]">
        Your launches are unavailable right now — try again shortly.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-[12.5px] leading-relaxed text-[var(--vex-text-3)]">
        You haven&apos;t launched a token yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <LaunchRow key={row.intentId} row={row} />
      ))}
    </ul>
  );
}

function LaunchRow({ row }: { readonly row: MyLaunchRow }): JSX.Element {
  const clock = formatClock(row.createdAt);
  return (
    <li className="flex items-center justify-between gap-3 border-b border-[var(--vex-line)] py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-[var(--vex-text)]">
            {row.name}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-3)]">
            {row.symbol}
          </span>
        </div>
        {/* An un-decoded address is an em-dash, never a guess: a launch whose
         * receipt we could not read is pending, not addressless. */}
        {row.tokenAddress !== null ? (
          <AddressDisplay address={row.tokenAddress} />
        ) : (
          <span className="text-[11px] text-[var(--vex-text-3)]">—</span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-2)]">
          {row.status}
        </span>
        {clock !== null ? (
          <span className="font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
            {clock}
          </span>
        ) : null}
      </div>
    </li>
  );
}
