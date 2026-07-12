/**
 * MOVES — the per-session feed of what the agent DID on-chain: executed trades
 * (swaps / fills) from the `proj_activity` projection, newest first.
 *
 * Reads the agent's REAL executed activity via `useMoves` (→ `portfolio.listMoves`),
 * NOT the approval history. Approval rows only exist for `restricted`-permission
 * sessions, so a `full`-permission mission that executed swaps has zero approval
 * rows but real `proj_activity` rows — this block surfaces those.
 *
 * Rows are activity rows / fills (NOT executions): a batch capture legitimately
 * produces multiple fills per execution, so they are shown individually.
 *
 * LEDGER GRAMMAR (landing .ws-stat): one hairline-separated row per fill —
 * status dot · stamp (mono 9px chip: BUY success-tone / SELL paper-tone /
 * SWAP muted; `productType` takes priority — `bridge` → BRIDGE·VENUE,
 * `send`/`transfer` → TRANSFER, both muted) · `IN → OUT` legs · HH:MM. Raw
 * mint addresses never print in full: a bounded symbol from the activity's
 * exact capture item takes priority, with the full mint retained on the
 * tooltip; address-like fallbacks truncate to `So1111…1112`. A deliberately
 * tiny well-known-mint map resolves unmissable legacy tickers, and short token
 * strings render as uppercase symbols. Resolved symbols reuse the app's
 * offline token mark (brand icon when bundled, otherwise a monogram). A leg
 * carries its amount (`0.0017 ETH`) ONLY
 * when the recorded amount is a dotted decimal — raw base-unit integers from
 * legacy captures (wei/lamports) and nulls render nothing.
 *
 * The ledger shows the 10 newest fills (`MOVES_DISPLAY_CAP`); the header badge
 * still counts the FULL fetched result (server-capped at `MOVES_MAX`). A row
 * whose `chain`+`txRef` resolve through `moveExplorerUrl` renders as an
 * external link (target=_blank → main's `shell.openExternal` allowlist) with a
 * hover-revealed ↗ affordance; unresolvable rows stay non-interactive.
 *
 * Dot colour is a PURE client-side derivation over the tolerant `captureStatus`
 * string (executed/filled/closed/claimed → done; open/pending → pending;
 * cancelled/rejected → muted; failed → destructive; null/unknown → neutral).
 * Unknown statuses fall back gracefully — the derivation never throws.
 */

import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { MoveItem } from "@shared/schemas/portfolio-moves.js";
import { TokenIcon } from "../../../components/common/TokenIcon.js";
import { useMoves } from "../../../lib/api/portfolio.js";
import { moveExplorerUrl } from "../../../lib/explorer-links.js";
import { formatClock, truncateAddress } from "../../../lib/format.js";
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
 * Well-known mint → ticker. Deliberately tiny (the Solana constants a trader
 * recognises on sight); everything else goes through the address heuristic.
 * Do NOT grow this into a token registry — that belongs server-side.
 */
const KNOWN_MINTS: ReadonlyMap<string, string> = new Map([
  ["So11111111111111111111111111111111111111112", "SOL"],
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
]);

/** Reads as a raw mint/address: one long unbroken alnum (base58/hex) run. */
const ADDRESS_LIKE = /^[0-9a-zA-Z]{13,}$/;

interface TokenDisplay {
  /** What the ledger prints. */
  readonly text: string;
  /** Full value for the tooltip when `text` is lossy, else `null`. */
  readonly full: string | null;
  /** Safe symbol used by the app's offline token mark; null for raw addresses. */
  readonly iconSymbol: string | null;
}

/**
 * Display rule for one swap leg: captured symbol → uppercase label with the
 * address retained on the tooltip; known mint → ticker; address-like → the
 * canonical `truncateAddress` shortening (`So1111…1112`); short strings →
 * uppercase symbols. Legs are nullable in the tolerant DTO → `?`. Symbols are
 * uppercased in JS (not CSS) so base58 case in truncations stays intact.
 */
function tokenDisplay(token: string | null, symbol: string | null): TokenDisplay {
  if (symbol !== null && symbol.length > 0) {
    return {
      text: symbol.toUpperCase(),
      full: token !== null && token !== symbol ? token : null,
      iconSymbol: symbol,
    };
  }
  if (token === null || token.length === 0) {
    return { text: "?", full: null, iconSymbol: null };
  }
  const ticker = KNOWN_MINTS.get(token);
  if (ticker !== undefined) {
    return { text: ticker, full: token, iconSymbol: ticker };
  }
  if (ADDRESS_LIKE.test(token)) {
    return { text: truncateAddress(token), full: token, iconSymbol: null };
  }
  return { text: token.toUpperCase(), full: null, iconSymbol: token };
}

/** ≤6 significant digits, no grouping — mono-ledger compact figures. */
const AMOUNT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
  useGrouping: false,
});

/**
 * Compact leg amount. The engine records HUMAN-readable amounts only for
 * newer captures (relay bridge, uniswap spot); older captures store raw
 * base-unit integers (wei/lamports) that are meaningless to print. Tolerant
 * guard: render ONLY dotted-decimal strings that parse to a finite positive
 * number (a raw base-unit integer never carries a `.`); everything else —
 * null, integers, non-numeric — renders nothing, so legacy rows keep today's
 * amount-less legs.
 */
function amountDisplay(amount: string | null): string | null {
  if (amount === null || !amount.includes(".")) return null;
  const parsed = Number.parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return AMOUNT_FORMAT.format(parsed);
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
 * `buy`/`sell` (EVM spot) carry their own tones; `null`/empty is a neutral
 * Solana swap → SWAP; any other engine value prints uppercased in the neutral
 * tone. Never throw, never hide data (legacy rows carry `productType: null`
 * and keep the tradeSide-only derivation).
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
  if (side.length === 0) return { text: "SWAP", tone: "neutral" };
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
          // (white on cobalt, ink on the Robinhood lime fill), rounded-[5px].
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
  const state = moveState(move.captureStatus);
  const side = sideStamp(move);
  const input = tokenDisplay(move.inputToken, move.inputTokenSymbol);
  const output = tokenDisplay(move.outputToken, move.outputTokenSymbol);
  const inputAmount = amountDisplay(move.inputAmount);
  const outputAmount = amountDisplay(move.outputAmount);
  const time = formatClock(move.createdAt);
  const explorerUrl = moveExplorerUrl(move.chain, move.txRef);

  // Shared row cells. The `group` sits on the hoverable wrapper (anchor for
  // linked rows, <li> for plain rows) so legs lighten on row hover in both.
  const cells = (
    <>
      {/* Pending = verifiably in-flight → the pulse ring loops; every
       * terminal state (done/failed/cancelled) rests still. */}
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          DOT[state],
          state === "pending" && "vex-pulse-dot",
        )}
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
            {inputAmount !== null ? `${inputAmount} ${input.text}` : input.text}
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
            {outputAmount !== null ? `${outputAmount} ${output.text}` : output.text}
          </span>
        </span>
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
        title={move.instrumentKey ?? undefined}
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
      title={move.instrumentKey ?? undefined}
      className="group flex items-center gap-2 border-b border-[var(--vex-line)] py-1.5 last:border-b-0"
    >
      {cells}
    </li>
  );
}
