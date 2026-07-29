/**
 * MOVES — the per-session feed of what the agent DID on-chain: executed trades
 * (swaps / fills) from the `proj_activity` projection UNIONed with the
 * new-format `agent_activity` swap-attempt table (Agent Scan plan §4.7), newest
 * first.
 *
 * Reads the agent's REAL executed activity via `useMoves` (→ `portfolio.listMoves`),
 * NOT the approval history. Approval rows only exist for `restricted`-permission
 * sessions, so a `full`-permission mission that executed swaps has zero approval
 * rows but real activity rows — this block surfaces those.
 *
 * Rows are activity rows / fills (NOT executions): a batch capture legitimately
 * produces multiple fills per execution, so they are shown individually. An
 * `agent_activity`-sourced row (`source: "agent_activity"`) is one swap
 * ATTEMPT instead — `status: "pending" | "confirmed" | "failed"` — so a
 * still-broadcasting or a failed swap is ALSO visible here, not just settled
 * fills.
 *
 * LEDGER GRAMMAR (landing .ws-stat): one hairline-separated row per fill —
 * status dot · protocol mark · ActivityBadge · `IN → OUT` legs · HH:MM.
 *
 * The badge speaks the CANONICAL engine vocabulary (`activityKind` /
 * `eventRole` — see `@shared/agent-activity-vocabulary.ts`) through the one
 * shared `ActivityBadge` grammar. It replaced a local `sideStamp` that read
 * `productType`/`tradeSide`, a SQL-minted SPOT taxonomy which could render a
 * `wrap` row as a spot trade; those two fields now have ZERO renderer
 * consumers. The venue left the stamp text (`BRIDGE·RELAY`) and became the
 * round protocol mark beside it: the badge says WHAT happened, the mark says
 * WHO executed it. Leg
 * token identity and amounts render through the shared token-leg policy
 * (`lib/token-leg-display.ts` — extracted from this file, behavior pinned
 * by MovesBlock.test.tsx): a known mint address is the ONLY thing that
 * authorizes a brand ticker + logo; captured and local symbols are
 * UNTRUSTED, brand claims dropped; address-like fallbacks truncate to
 * `So1111…1112`; a leg carries its amount when the recorded amount is a
 * dotted decimal (legacy `source: "success"` rows — raw base-unit integers,
 * wei/lamports, render nothing) OR, for an `agent_activity` row, whenever
 * the main-process mapper resolved ANY amount at all — including a
 * whole-number result with no decimal point (Codex final review finding 10 /
 * contract C27: `viem`'s `formatUnits` omits the "." when the fractional
 * part is zero, so requiring one would blank out an honest amount).
 *
 * The ledger shows the 10 newest fills (`MOVES_DISPLAY_CAP`); the header badge
 * still counts the FULL fetched result (server-capped at `MOVES_MAX`). A row
 * whose `chain`+`txRef` resolve through `explorerTxUrl` renders as an external
 * link (target=_blank → main's `shell.openExternal` allowlist) with a
 * hover-revealed ↗ affordance. A row with NO `txRef` whose `chain`+
 * `walletAddress` resolve through `explorerAccountUrl` (e.g. HyperCore) keeps a
 * non-linked row but appends a distinct, labelled `View account ↗` link — the
 * row itself is NOT an anchor. Rows that resolve to neither stay
 * non-interactive.
 *
 * Dot colour: an `agent_activity` row's own closed `status` field takes
 * priority (`pending` → pending tone, `confirmed` → done, `failed` →
 * destructive); everything else (legacy `source: "success"` rows, where
 * `status` is always `null`) falls back to the PURE client-side derivation
 * over the tolerant `captureStatus` string (executed/filled/closed/claimed →
 * done; open/pending → pending; cancelled/rejected → muted; failed →
 * destructive; null/unknown → neutral). Unknown statuses fall back
 * gracefully — the derivation never throws. The dot is always still (owner
 * decree: no pulsing dots anywhere) — color is the only state signal. A
 * failed `agent_activity` row's `failureCode` (when present) rides the row's
 * `title` tooltip alongside `instrumentKey`.
 */

import type { JSX } from "react";
import {
  ArrowUpRight01Icon,
  VexIcon,
} from "../../../components/icons/index.js";
import type { MoveItem, MoveSecondaryLeg } from "@shared/schemas/portfolio-moves.js";
import {
  explorerAccountUrl,
  explorerTxUrl,
} from "@shared/explorer-links.js";
import { isBridgeTrackingStale } from "@shared/bridge-tracking.js";
import { ProtocolMark } from "../../../components/common/ProtocolMark.js";
import { TokenIcon } from "../../../components/common/TokenIcon.js";
import { useMoves } from "../../../lib/api/portfolio.js";
import { formatClock } from "../../../lib/format.js";
import { resolveProtocolMark } from "../../../lib/protocol-marks.js";
import { amountDisplay, tokenDisplay } from "../../../lib/token-leg-display.js";
import { cn } from "../../../lib/utils.js";
import { ActivityBadge } from "../ActivityBadge.js";
import { BookBlock } from "./BookBlock.js";

/** Rendered window: the 10 newest fills. The badge counts the fetched total. */
const MOVES_DISPLAY_CAP = 10;

type MoveState = "pending" | "done" | "failed" | "cancelled" | "neutral";

/**
 * Pure derivation over the tolerant `captureStatus`. The engine emits values
 * like `executed`, `open`, `closed`, `cancelled`, `claimed`, `pending`,
 * `filled`. Unrecognised or `null` statuses fall back to `neutral` — never
 * throw.
 */
function moveState(captureStatus: string | null): MoveState {
  switch (captureStatus?.toLowerCase()) {
    case "executed":
    case "filled":
    case "closed":
    case "claimed":
      return "done";
    case "open":
    case "pending":
      return "pending";
    case "cancelled":
    case "canceled":
    case "rejected":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "neutral";
  }
}

const DOT: Record<MoveState, string> = {
  pending: "bg-[var(--vex-accent)]",
  done: "bg-[var(--color-success)]",
  failed: "bg-[var(--color-destructive)]",
  cancelled: "bg-[var(--vex-text-3)]",
  neutral: "bg-[var(--vex-text-2)]",
};

/**
 * A row's dot state: `agent_activity`'s own closed `status` field wins when
 * present (it IS the row's lifecycle — never guessed); a legacy `source:
 * "success"` row (`status: null`) falls back to the tolerant
 * `captureStatus`-based derivation.
 */
function rowState(move: MoveItem): MoveState {
  if (move.status === "pending") return "pending";
  if (move.status === "confirmed") return "done";
  if (move.status === "failed") return "failed";
  return moveState(move.captureStatus);
}

/**
 * Is this row a bridge? Reads the CANONICAL `activityKind` (server-derived for
 * a legacy row) — `productType` has no renderer consumers any more.
 */
function isBridgeMove(move: MoveItem): boolean {
  return (move.activityKind ?? null) === "bridge";
}

export function MovesBlock({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const query = useMoves(sessionId);
  const result = query.data;
  const allMoves = result?.ok ? result.data : [];
  const moves = allMoves.slice(0, MOVES_DISPLAY_CAP);

  let body: JSX.Element;
  if (query.isLoading) {
    body = (
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
        Loading…
      </p>
    );
  } else if (result !== undefined && !result.ok) {
    body = (
      <p className="text-[11px] text-[var(--vex-warn-text)]">
        Couldn&apos;t load moves.
      </p>
    );
  } else if (moves.length === 0) {
    body = (
      <p className="text-[11px] text-[var(--vex-text-3)]">
        No moves yet — the agent&apos;s trades appear here.
      </p>
    );
  } else {
    body = (
      // Landing .ws-stat grammar: hairline-separated ledger rows, mono figures.
      <ul className="flex flex-col">
        {moves.map((m) => <MoveRow key={m.id} move={m} />)}
      </ul>
    );
  }

  return (
    <BookBlock
      title="Moves"
      trailing={
        allMoves.length > 0 ? (
          // Landing .ws-badge: accent fill, accent-contrast mono figure
          // (contrast ink on the accent fill), rounded-[5px].
          // Counts the FETCHED total (server-capped at MOVES_MAX), not the
          // 10-row display window below it.
          <span className="inline-flex min-w-[18px] items-center justify-center rounded-[5px] bg-[var(--vex-accent)] px-1.5 py-px font-mono text-[9px] font-medium tabular-nums text-[var(--vex-accent-contrast)]">
            {allMoves.length}
          </span>
        ) : undefined
      }
    >
      {body}
    </BookBlock>
  );
}

/**
 * A SECOND token leg of the SAME transaction (yield rows only): both outputs
 * of a `py.mint`, both inputs of a pre-expiry `py.redeem`, the second leg of a
 * dual LP action. Rendered beside its primary ON THE SAME SIDE of the arrow —
 * without it a two-instrument action reads as a misleading 1→1 move. Follows
 * the primary legs' exact identity/amount policy (`tokenDisplay`,
 * `amountDisplay`); secondary legs only exist on `agent_activity` rows, whose
 * amounts arrive already proven human by the main-process mapper.
 */
function SecondaryLegSpan({
  leg,
  trustedHuman,
  estimated,
}: {
  readonly leg: MoveSecondaryLeg;
  readonly trustedHuman: boolean;
  readonly estimated: boolean;
}): JSX.Element {
  const display = tokenDisplay(leg.token, leg.tokenSymbol, null);
  const amount = amountDisplay(leg.amount, trustedHuman);
  return (
    <>
      <span className="shrink-0 text-[var(--vex-text-3)]">+</span>
      <span
        title={display.full ?? undefined}
        className="inline-flex min-w-0 items-center gap-1"
      >
        {display.iconSymbol !== null ? (
          <TokenIcon symbol={display.iconSymbol} size={12} />
        ) : null}
        <span className="truncate">
          {amount !== null
            ? `${estimated ? "~" : ""}${amount} ${display.text}`
            : display.text}
        </span>
      </span>
    </>
  );
}

function MoveRow({ move }: { readonly move: MoveItem }): JSX.Element {
  const state = rowState(move);
  const protocolMark = resolveProtocolMark(move.venue);
  const input = tokenDisplay(
    move.inputToken,
    move.inputTokenSymbol,
    move.inputTokenLocalSymbol,
  );
  const output = tokenDisplay(
    move.outputToken,
    move.outputTokenSymbol,
    move.outputTokenLocalSymbol,
  );
  // Agent Scan §4.7/C27: an agent_activity-sourced amount is ALREADY proven
  // human by the main-process mapper (`resolveAgentActivityAmount`) — trust
  // it verbatim, including a whole-number result with no decimal point.
  const trustedHuman = move.source === "agent_activity";
  const inputAmount = amountDisplay(move.inputAmount, trustedHuman);
  const outputAmount = amountDisplay(move.outputAmount, trustedHuman);
  const secondaryInput = move.secondaryInputLeg ?? null;
  const secondaryOutput = move.secondaryOutputLeg ?? null;
  // R14: a bridge whose shown amounts are the QUOTE (not an independently
  // verified fill) marks both legs `~…` + a single trailing "est." tag, so a
  // quoted bridge amount never reads as an executed quantity.
  const estimated = move.amountBasis === "estimated";
  const time = formatClock(move.createdAt);
  const explorerUrl = explorerTxUrl(move.chain, move.txRef);
  // No tx ref (e.g. a HyperCore fill) → offer a distinct account link instead
  // of a whole-row link. Only consulted when there is no tx URL to prefer.
  const accountUrl =
    explorerUrl === null
      ? explorerAccountUrl(move.chain, move.walletAddress)
      : null;
  // R12: a pending bridge whose sweep check has fallen far behind
  // (last_checked_at — or createdAt before the first check — is stale) surfaces
  // a "tracking delayed" tooltip in the compact ledger (the fuller
  // TokenHistoryScreen shows a chip). Priority: failureCode wins, then the
  // tracking-delay note, then the legacy instrumentKey.
  const bridgeDelayTitle =
    isBridgeMove(move) &&
    move.status === "pending" &&
    isBridgeTrackingStale(move.lastCheckedAt, move.createdAt)
      ? move.lastCheckedAt !== null
        ? `Tracking delayed — last checked ${formatClock(move.lastCheckedAt) ?? "recently"}`
        : "Tracking delayed — not yet checked since the bridge started"
      : null;
  const rowTitle = move.failureCode ?? bridgeDelayTitle ?? move.instrumentKey ?? undefined;

  // Shared row cells. The `group` sits on the hoverable wrapper (anchor for
  // linked rows, <li> for plain rows) so legs lighten on row hover in both.
  const cells = (
    <>
      {/* Status dot — a still color mark (owner decree: no pulsing dots
       * anywhere); DOT[state] alone carries pending vs. terminal. */}
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[state])}
      />
      {/* The venue moved out of the stamp text (`BRIDGE·RELAY`) and became a
       * mark: the badge now says WHAT happened, the mark says WHO executed it.
       * Fixed-width slot keeps rows aligned when a venue does not resolve. */}
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <ProtocolMark mark={protocolMark} size={14} />
      </span>
      <ActivityBadge
        kind={move.activityKind ?? null}
        eventRole={move.eventRole ?? null}
        // The row's lifecycle is already carried by the status dot; a second
        // status chip on every pending row would double-state it.
        status={null}
      />
      <span className="flex h-4 min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11px] leading-none text-[var(--vex-text-2)] transition-colors group-hover:text-[var(--vex-text)]">
        <span
          title={input.full ?? undefined}
          className="inline-flex min-w-0 items-center gap-1"
        >
          {input.iconSymbol !== null ? (
            <TokenIcon symbol={input.iconSymbol} size={12} />
          ) : null}
          <span className="truncate">
            {inputAmount !== null
              ? `${estimated ? "~" : ""}${inputAmount} ${input.text}`
              : input.text}
          </span>
        </span>
        {secondaryInput !== null ? (
          <SecondaryLegSpan
            leg={secondaryInput}
            trustedHuman={trustedHuman}
            estimated={estimated}
          />
        ) : null}
        <span className="shrink-0 text-[var(--vex-text-3)]">→</span>
        <span
          title={output.full ?? undefined}
          className="inline-flex min-w-0 items-center gap-1"
        >
          {output.iconSymbol !== null ? (
            <TokenIcon symbol={output.iconSymbol} size={12} />
          ) : null}
          <span className="truncate">
            {outputAmount !== null
              ? `${estimated ? "~" : ""}${outputAmount} ${output.text}`
              : output.text}
          </span>
        </span>
        {secondaryOutput !== null ? (
          <SecondaryLegSpan
            leg={secondaryOutput}
            trustedHuman={trustedHuman}
            estimated={estimated}
          />
        ) : null}
        {estimated ? (
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
            est.
          </span>
        ) : null}
      </span>
      {time !== null ? (
        <span className="shrink-0 text-right font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
          {time}
        </span>
      ) : null}
    </>
  );

  if (explorerUrl !== null) {
    return (
      <li
        title={rowTitle}
        className="border-b border-[var(--vex-line)] last:border-b-0"
      >
        {/* target=_blank never opens a child window: main's
         * setWindowOpenHandler denies + routes allowlisted hosts through
         * shell.openExternal. The ↗ affordance rests hidden and reveals on
         * hover/keyboard focus. */}
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open transaction on block explorer"
          className="group flex items-center gap-2 rounded-[3px] py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {cells}
          <VexIcon
            icon={ArrowUpRight01Icon}
            size={11}
            aria-hidden
            className="shrink-0 text-[var(--vex-text-3)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        </a>
      </li>
    );
  }

  return (
    <li
      title={rowTitle}
      className="group flex items-center gap-2 border-b border-[var(--vex-line)] py-1.5 last:border-b-0"
    >
      {cells}
      {accountUrl !== null ? (
        // No tx hash on this row (HyperCore) — link to the account page, NOT
        // the whole row. target=_blank routes through main's
        // setWindowOpenHandler → shell.openExternal allowlist.
        <a
          href={accountUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open account on block explorer"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          View account
          <VexIcon icon={ArrowUpRight01Icon} size={11} aria-hidden />
        </a>
      ) : null}
    </li>
  );
}
