import type { JSX } from "react";

import type { HyperliquidPositionDto } from "@shared/schemas/hyperliquid.js";
import { useHyperliquidPositions } from "../../../lib/api/hyperliquid.js";
import { useSubmitChat } from "../../../lib/api/chat.js";
import { cn } from "../../../lib/utils.js";
import { BookBlock } from "./BookBlock.js";
import type { CoverageLabel } from "./HyperliquidCoverageBadge.js";

const STALE_AFTER_MS = 180_000;

function coverage(position: HyperliquidPositionDto, now = Date.now()): CoverageLabel {
  if (now - Date.parse(position.confirmedAt) > STALE_AFTER_MS) return "stale";
  if (position.protectionState === "PROTECTED") return "protected";
  if (position.protectionState === "CONSOLIDATING") return "consolidating";
  return "UNPROTECTED";
}

/** Sign of a canonical decimal string, for direction coloring only. */
function pnlTone(value: string): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric < 0) return "text-[var(--vex-short)]";
  return "text-[var(--vex-long)]";
}

/** The SL gap is an ACTION, not a blank — honesty over an empty cell. Routes an
 * agent-mediated request to the composer (Vex still proposes and the user still
 * signs; this button never sets protection directly). */
function SetProtectionAction({
  sessionId,
  position,
}: {
  readonly sessionId: string;
  readonly position: HyperliquidPositionDto;
}): JSX.Element {
  const submit = useSubmitChat();
  return (
    <button
      type="button"
      disabled={submit.isPending}
      onClick={() =>
        submit.mutate({
          sessionId,
          message: `Propose a stop loss to protect my ${position.side} ${position.coin} position. Show the setup before anything moves.`,
        })
      }
      className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-cover-none)] underline-offset-2 hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
    >
      {submit.isPending ? "Asking…" : "Set protection"}
    </button>
  );
}

function PositionRow({ sessionId, position }: { readonly sessionId: string; readonly position: HyperliquidPositionDto }): JSX.Element {
  const isLong = position.side === "long";
  return (
    <li className="border-t border-[var(--vex-line)] py-2 first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]",
              isLong
                ? "bg-[var(--vex-long-fill)] text-[var(--vex-long)]"
                : "bg-[var(--vex-short-fill)] text-[var(--vex-short)]",
            )}
          >
            {position.side}
          </span>
          <span className="truncate font-mono text-[12px] tabular-nums text-[var(--vex-text-2)]">
            {position.size} {position.coin}
          </span>
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
        <span>mark {position.markPx}</span>
        <span>
          uPnL{" "}
          <span className={pnlTone(position.unrealizedPnl)}>
            {position.unrealizedPnl}
          </span>
        </span>
        <span>entry {position.entryPx}</span>
        <span>
          liq{" "}
          <span className="text-[var(--vex-chart-liq)]">
            {position.liquidationPx ?? "—"}
          </span>
        </span>
        <span className="flex items-center gap-1">
          SL{" "}
          {position.slPrice !== null ? (
            <span className="text-[var(--vex-text-2)]">{position.slPrice}</span>
          ) : (
            <SetProtectionAction sessionId={sessionId} position={position} />
          )}
        </span>
        <span>funding {position.fundingAccrued}</span>
        <span>
          lev{" "}
          <span className="text-[var(--vex-text-2)]">
            {position.leverage ?? "—"}
            {position.leverage !== null ? "x" : ""}
            {position.marginMode !== "unknown" ? ` ${position.marginMode}` : ""}
          </span>
        </span>
      </div>
    </li>
  );
}

/** Functional projection register; chart polish is intentionally deferred. */
export function HyperliquidPositionsBlock({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element {
  const query = useHyperliquidPositions(sessionId);
  const result = query.data;
  if (query.isLoading) {
    return <BookBlock title="Hyperliquid"><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">Loading positions…</p></BookBlock>;
  }
  if (query.isError || (result !== undefined && !result.ok)) {
    return <BookBlock title="Hyperliquid"><p className="text-[11px] text-[var(--vex-warn-text)]">Couldn&apos;t load Hyperliquid positions.</p></BookBlock>;
  }
  const positions = result?.ok ? result.data.positions : [];
  if (positions.length === 0) {
    return <BookBlock title="Hyperliquid"><p className="text-[11px] text-[var(--vex-text-3)]">No open Hyperliquid perpetual positions.</p></BookBlock>;
  }
  return (
    <BookBlock title="Hyperliquid" trailing={`${positions.length} open`}>
      <ul>
        {positions.map((position) => <PositionRow key={`${position.coin}:${position.side}`} sessionId={sessionId} position={position} />)}
      </ul>
    </BookBlock>
  );
}

export { coverage as deriveHyperliquidCoverage };
