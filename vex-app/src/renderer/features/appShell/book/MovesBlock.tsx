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
 * status dot · stamp (mono 9px chip: BUY success-tone / SELL paper-tone /
 * SWAP muted; `productType` takes priority — `bridge` → BRIDGE·VENUE,
 * `send`/`transfer` → TRANSFER; a neutral swap with a known venue/protocol
 * falls back to `SWAP·VENUE` — e.g. `SWAP·KYBERSWAP` for an `agent_activity`
 * row, which carries no `tradeSide` at all since the unified Kyber/Uniswap
 * contract dropped the `side` parameter) · `IN → OUT` legs · HH:MM. Leg
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
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { MoveItem } from "@shared/schemas/portfolio-moves.js";
import {
  explorerAccountUrl,
  explorerTxUrl,
} from "@shared/explorer-links.js";
import { isBridgeTrackingStale } from "@shared/bridge-tracking.js";
import { TokenIcon } from "../../../components/common/TokenIcon.js";
import { useMoves } from "../../../lib/api/portfolio.js";
import { formatClock } from "../../../lib/format.js";
import { amountDisplay, tokenDisplay } from "../../../lib/token-leg-display.js";
import { cn } from "../../../lib/utils.js";
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

type SideTone = "buy" | "sell" | "neutral";

interface SideStamp {
  readonly text: string;
  readonly tone: SideTone;
}

/**
 * Chip stamp with `productType` priority: `bridge` → BRIDGE, venue-qualified
 * (`BRIDGE·RELAY`) when the tolerant `venue` is present; `send`/`transfer` →
 * TRANSFER; anything else falls through to the tolerant `tradeSide` —
 * `buy`/`sell` (EVM spot) carry their own tones; `null`/empty falls back to
 * a venue-qualified `SWAP·VENUE` (e.g. `SWAP·KYBERSWAP`) when the tolerant
 * `venue` is present, else bare `SWAP` — covers both a neutral Solana swap
 * and every `agent_activity` row, which carries no `tradeSide` at all (the
 * unified Kyber/Uniswap contract dropped the `side` parameter); any other
 * engine value prints uppercased in the neutral tone. Never throw, never
 * hide data (legacy rows carry `productType: null` and keep the
 * tradeSide-only derivation).
 */
function sideStamp(move: MoveItem): SideStamp {
  const product = move.productType?.toLowerCase() ?? "";
  if (product === "bridge") {
    const venue = move.venue !== null && move.venue.length > 0 ? move.venue.toUpperCase() : null;
    return { text: venue !== null ? `BRIDGE·${venue}` : "BRIDGE", tone: "neutral" };
  }
  if (product === "send" || product === "transfer") {
    return { text: "TRANSFER", tone: "neutral" };
  }
  const side = move.tradeSide?.toLowerCase() ?? "";
  if (side === "buy") return { text: "BUY", tone: "buy" };
  if (side === "sell") return { text: "SELL", tone: "sell" };
  if (side.length === 0) {
    const venue = move.venue !== null && move.venue.length > 0 ? move.venue.toUpperCase() : null;
    return { text: venue !== null ? `SWAP·${venue}` : "SWAP", tone: "neutral" };
  }
  return { text: side.toUpperCase(), tone: "neutral" };
}

/** SIDE chip tones — hairline chips, ink stays on the text (no fills). */
const STAMP_TONE: Record<SideTone, string> = {
  // BUY — the landing's live/pass green as a hairline, not a fill.
  buy: "border-[color-mix(in_oklab,var(--color-success)_40%,transparent)] text-success",
  // SELL — neutral paper-tone hairline.
  sell: "border-[var(--vex-line-strong)] text-[var(--vex-text-2)]",
  // SWAP / unknown side — the muted register.
  neutral: "border-[var(--vex-line)] text-[var(--vex-text-3)]",
};

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

function MoveRow({ move }: { readonly move: MoveItem }): JSX.Element {
  const state = rowState(move);
  const side = sideStamp(move);
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
    move.productType === "bridge" &&
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
      <span
        className={cn(
          "inline-flex h-4 min-w-[42px] shrink-0 items-center justify-center rounded-[3px] border px-1 font-mono text-[9px] uppercase tracking-[0.14em]",
          STAMP_TONE[side.tone],
        )}
      >
        {side.text}
      </span>
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
          <HugeiconsIcon
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
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} aria-hidden />
        </a>
      ) : null}
    </li>
  );
}
