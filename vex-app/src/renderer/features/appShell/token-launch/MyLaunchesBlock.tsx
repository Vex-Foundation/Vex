/**
 * MY LAUNCHES — the editorial column at the foot of the launch dialog.
 *
 * Its job is context, not decoration: before authorizing a spend it is worth
 * seeing what the last one did. It is a hairline-separated column (the section
 * grammar used across the shell), NOT a tile — a second card inside a dialog
 * would compete with the preview card, which is the surface that matters here.
 *
 * ── THE STATES LADDER IS THE HONESTY CONTRACT ─────────────────────────────
 * unavailable → loading → error → empty → content, and `unavailable` is a
 * SEPARATE rung from `empty` on purpose (the TokenHistory precedent). "We
 * couldn't read your launches" and "you have never launched a token" are
 * different claims, and only one of them is ours to make when a read degrades.
 * Rendering the empty invitation on a failed read would tell the user, in the
 * app that holds their money, that history they actually have does not exist.
 *
 * ONE page, no "Load more": the IPC contract returns a bounded list and no
 * cursor, and an affordance main cannot honour is not an affordance.
 */

import type { JSX } from "react";
import type { LaunchedTokenDto } from "../../../lib/api/token-launch.js";
import { isTokenLaunchAvailable, useMyLaunches } from "../../../lib/api/token-launch.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";
import { formatClock } from "../../../lib/format.js";

export function MyLaunchesBlock(): JSX.Element {
  const query = useMyLaunches();
  const result = query.data;
  const rows = result !== undefined && result.ok ? result.data.launches : [];

  return (
    <section className="flex flex-col gap-2 border-t border-line-2 pt-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="vex-eyebrow">My launches</h3>
        {rows.length > 0 ? (
          <span className="font-mono text-[10px] tabular-nums text-ink-tertiary">
            {rows.length}
          </span>
        ) : null}
      </header>

      <Body
        unavailable={!isTokenLaunchAvailable()}
        loading={query.isLoading}
        errored={query.isError || (result !== undefined && !result.ok)}
        rows={rows}
      />
    </section>
  );
}

function Body({
  unavailable,
  loading,
  errored,
  rows,
}: {
  readonly unavailable: boolean;
  readonly loading: boolean;
  readonly errored: boolean;
  readonly rows: readonly LaunchedTokenDto[];
}): JSX.Element {
  // NOT the empty state, and NOT phrased as a failure of theirs — see header.
  if (unavailable) {
    return (
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">
        Your launches are unavailable right now - try again shortly.
      </p>
    );
  }
  if (loading) {
    return (
      <p className="vex-micro-label uppercase text-ink-secondary">
        Loading…
      </p>
    );
  }
  if (errored) {
    return (
      <p className="text-[12.5px] text-warning">
        Couldn&apos;t load your launches.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-[12.5px] leading-relaxed text-ink-tertiary">
        You haven&apos;t launched a token yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <LaunchRow key={row.createTxHash} row={row} />
      ))}
    </ul>
  );
}

function LaunchRow({ row }: { readonly row: LaunchedTokenDto }): JSX.Element {
  const clock = formatClock(row.createdAt);
  return (
    <li className="flex items-center justify-between gap-3 border-b border-line-2 py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-ink-primary">
            {row.name}
          </span>
          <span className="shrink-0 vex-micro-label uppercase text-ink-secondary">
            {row.symbol}
          </span>
        </div>
        {/*
          A launch whose token identity is NOT proven yet (OD-3) renders as what
          it is - a broadcast still in flight - and NEVER as a token: there is no
          address to show, and an empty one would read as a token with a missing
          name rather than a launch that has not landed.

          The test is on `row.tokenAddress` ITSELF rather than a derived boolean,
          because only that narrows the property: `AddressDisplay` requires a
          non-null address, and this branch is what proves it has one.
        */}
        {row.tokenAddress === null ? (
          row.lifecycle === "superseded_unproven" ? (
            /*
              TERMINAL, BUT NOT A FAILURE. Vex has STOPPED checking this hash, so
              saying "in flight" here would promise a check that is no longer
              running. It also may not say the launch failed, nor name a cause:
              the intent records only that tracking stopped with the outcome
              unproven. The token may exist.
            */
            <span
              className="vex-micro-label uppercase text-ink-secondary"
              title="No longer tracked - Vex stopped checking this transaction and what actually happened was never established. The token may or may not exist; do not launch again without checking."
            >
              no longer tracked - outcome unproven
            </span>
          ) : (
            <span
              className="vex-micro-label uppercase text-ink-secondary"
              title="Broadcast - Vex is still checking whether this launch was included on-chain. No token address is proven yet."
            >
              in flight - no token address yet
            </span>
          )
        ) : (
          <AddressDisplay address={row.tokenAddress} />
        )}
      </div>
      {clock !== null ? (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-tertiary">
          {clock}
        </span>
      ) : null}
    </li>
  );
}
