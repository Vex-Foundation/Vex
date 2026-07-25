/**
 * Token-history screen — the full-app ShellScreen showing one token's
 * Vex-recorded activity (owner decree 2026-07-21: the eye key on a token row
 * in Balances / All assets opens this). Chronos grammar throughout: ink
 * glass inherited from the ShellScreen chrome, mono for every figure, serif
 * NOWHERE here (the chrome's serif H1 is replaced via the `header` slot).
 *
 * Data: `useTokenHistoryInfinite` → `vex:portfolio:listTokenHistory`, exact
 * `(chainId, tokenAddress)` identity from the route (name/symbol are display
 * metadata only). The DTO is a discriminated `status` union — a page that
 * timed out arrives as `"unavailable"` and renders the calm try-again note,
 * NEVER the empty state (a timeout must not read as "no history").
 *
 * Honesty rules (plan v2/v3):
 *  - quantities render ONLY with proven unit provenance
 *    (`unitProvenance === "human"`); unknown values show the em dash;
 *  - the primary USD figure carries a `usdProvenance` tag (Codex final
 *    review round 2 finding 7 / contract C35): `"recorded"` (legacy
 *    `proj_activity` capture) renders plain; `"estimated"`
 *    (`agent_activity`'s quote-time `usd_in/out_est` — never re-priced from
 *    the settled fill, regardless of the swap's status) renders with an
 *    explicit `~ … est.` marker — it must NEVER read as bare
 *    execution-time USD;
 *  - leg token identity goes through the shared token-leg policy
 *    (`lib/token-leg-display.ts`) — a known mint address is the only thing
 *    that authorizes a brand ticker/logo; hostile symbols degrade safely;
 *  - explorer links are BUILT here from `txRefs[{chainId, ref}]` via
 *    `shared/explorer-links.ts` (hosts already allow-listed in main);
 *    unknown chains / unresolved ids (0) render no link, never a guess;
 *  - the subtitle disclosure scopes the feed honestly: protocol captures +
 *    Vex-executed sends — external transfers/airdrops are not locally known;
 *  - a swap entry sourced from the new-format `agent_activity` table (Agent
 *    Scan plan §4.7) carries `status`/`failureCode` — a pending or failed
 *    attempt renders a small status badge next to the kind/side stamp; a
 *    `null`/`"confirmed"` status renders nothing extra (the quiet default).
 *    Cost basis was retired in the same pass — this screen's Activity feed
 *    is the whole page now.
 */

import { useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  ArrowDataTransferHorizontalIcon,
  ArrowUpRight01Icon,
  BridgeIcon,
  CoinsSwapIcon,
} from "@hugeicons/core-free-icons";
import type {
  AmountField,
  TokenHistoryDto,
  TokenHistoryEntry,
  TokenHistoryTxRef,
  UsdField,
} from "@shared/schemas/token-history.js";
import type { BridgeLeg, BridgeLegRole } from "@shared/schemas/bridge-legs.js";
import { isBridgeTrackingStale } from "@shared/bridge-tracking.js";
import type { Result } from "@shared/ipc/result.js";
import { chainDisplay, SOLANA_CHAIN_ID } from "@shared/chains/display.js";
import { explorerTxUrl } from "@shared/explorer-links.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { TokenIcon, TokenMark } from "../../../components/common/TokenIcon.js";
import { useTokenHistoryInfinite } from "../../../lib/api/portfolio.js";
import {
  formatClock,
  formatTokenPriceUsd,
  formatUsd,
  truncateAddress,
} from "../../../lib/format.js";
import { resolveTokenMark } from "../../../lib/token-marks.js";
import { amountDisplay, tokenDisplay } from "../../../lib/token-leg-display.js";
import { cn } from "../../../lib/utils.js";
import type {
  ShellRouteToken,
  ShellScreenOrigin,
} from "../../../stores/uiStore.js";
import { ShellScreen } from "./ShellScreen.js";

/** One available page of the DTO union (the shape the list renders). */
type TokenHistoryPage = Extract<TokenHistoryDto, { status: "available" }>;

/** Narrow one query page to its available payload, else null. */
function availablePage(
  page: Result<TokenHistoryDto> | undefined,
): TokenHistoryPage | null {
  if (page === undefined || !page.ok) return null;
  return page.data.status === "available" ? page.data : null;
}

/**
 * Quantity honesty (plan v2, the MovesBlock discipline): a figure prints
 * ONLY when the DTO proves human units (`unitProvenance: "human"`).
 * Unknown provenance — raw wei/lamports-scale integers, or an
 * agent_activity leg the main-process mapper could not resolve for its
 * status (C20) — renders the em dash, never a blind format. Once
 * `unitProvenance === "human"` is established, `amountDisplay` is called
 * with `trustedHuman: true` — the DTO's own typed provenance tag is
 * authoritative, so a whole-number result (no decimal point) still renders
 * instead of being blanked by a redundant dot-heuristic (Codex final review
 * finding 10 / contract C27).
 */
function quantityText(field: AmountField): string {
  if (field.unitProvenance !== "human") return "—";
  return amountDisplay(field.value, true) ?? "—";
}

/**
 * USD figure → compact display, honoring its provenance tag (contract C35):
 * an `"estimated"` figure (`agent_activity`'s quote-time `usd_in/out_est`)
 * renders `~$X est.` — it must never read as bare execution-time USD, since
 * it was priced BEFORE dispatch and never re-derived from the settled fill.
 * `"recorded"` (the legacy `proj_activity` capture) renders plain.
 * `value: null`/unparseable → em dash (never $0.00).
 */
function usdText(field: UsdField): string {
  if (field.value === null) return "—";
  const parsed = Number.parseFloat(field.value);
  if (!Number.isFinite(parsed)) return "—";
  const formatted = formatUsd(parsed);
  return field.usdProvenance === "estimated" ? `~${formatted} est.` : formatted;
}

/** Prefer the output leg's USD figure; fall back to the input leg when the output has no value. */
function primaryUsdField(input: UsdField, output: UsdField): UsdField {
  return output.value !== null ? output : input;
}

/** Unit-price decimal string → adaptive display; null/unparseable → null (omitted). */
function unitPriceText(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? formatTokenPriceUsd(parsed) : null;
}

/** "Jun 12 · 14:05" for an entry stamp; null for unparseable timestamps. */
function entryDateText(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const clock = formatClock(iso);
  return clock === null ? day : `${day} · ${clock}`;
}

/**
 * Resolve one `{chainId, ref}` pair to its explorer URL. The DTO never
 * carries URLs; chainId 0 is the DB layer's "could not resolve" sentinel and
 * the synthetic Solana id maps to the `solana` alias — everything else rides
 * the bare-decimal alias in `explorer-links.ts`. Unknown chain → null → no
 * link (never a half-built URL).
 */
function txRefUrl(ref: TokenHistoryTxRef): string | null {
  if (ref.chainId === 0) return null;
  const chain =
    ref.chainId === SOLANA_CHAIN_ID ? "solana" : String(ref.chainId);
  return explorerTxUrl(chain, ref.ref);
}

const KIND_GLYPH: Record<TokenHistoryEntry["kind"], IconSvgElement> = {
  swap: CoinsSwapIcon,
  bridge: BridgeIcon,
  transfer: ArrowDataTransferHorizontalIcon,
};

type SideTone = "buy" | "sell" | "neutral";

/** SIDE/LABEL chip tones — hairline chips, ink on the text (MovesBlock grammar). */
const STAMP_TONE: Record<SideTone, string> = {
  buy: "border-[color-mix(in_oklab,var(--color-success)_40%,transparent)] text-success",
  sell: "border-[var(--vex-line-strong)] text-[var(--vex-text-2)]",
  neutral: "border-[var(--vex-line)] text-[var(--vex-text-3)]",
};

/**
 * `agent_activity`-sourced swap status chip (Agent Scan §4.7) — a pending
 * or failed swap ATTEMPT is now visible in this feed, not just confirmed
 * fills; a `null`/`"confirmed"` status renders nothing extra (the quiet
 * default, matching `captureStatus`'s existing "no badge unless it needs
 * attention" posture).
 */
const SWAP_STATUS_TONE: Record<"pending" | "failed", string> = {
  pending: "border-[var(--vex-line)] text-[var(--vex-accent)]",
  failed: "border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] text-[var(--color-destructive)]",
};

/**
 * Row stamp: the LABEL comes from the raw `productType` when recorded
 * (bounded ≤32 by the schema; uppercased for the chip), falling back to the
 * entry `kind`. The tone derives from the tolerant `tradeSide` (swap rows
 * only) — buy/sell carry their tones, everything else stays neutral.
 */
function entryStamp(entry: TokenHistoryEntry): {
  readonly text: string;
  readonly tone: SideTone;
} {
  const label =
    entry.kind === "swap" && entry.productType !== null && entry.productType.length > 0
      ? entry.productType
      : entry.kind;
  if (entry.kind !== "swap") return { text: label.toUpperCase(), tone: "neutral" };
  const side = entry.tradeSide?.toLowerCase() ?? "";
  const tone: SideTone = side === "buy" ? "buy" : side === "sell" ? "sell" : "neutral";
  const sideText = side === "buy" ? " · BUY" : side === "sell" ? " · SELL" : "";
  return { text: `${label.toUpperCase()}${sideText}`, tone };
}

export function TokenHistoryScreen({
  origin,
  token,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly token: ShellRouteToken;
  readonly onClose: () => void;
}): JSX.Element {
  const query = useTokenHistoryInfinite({
    chainId: token.chainId,
    tokenAddress: token.tokenAddress,
  });

  // Display identity: main-sanitized name, else the sanitized symbol, else
  // the truncated address — never raw provider text.
  const symbol = sanitizeTokenSymbol(token.symbol);
  const displayName =
    token.tokenName ?? symbol ?? truncateAddress(token.tokenAddress);
  const chainName = chainDisplay(token.chainId).name;
  const mark = resolveTokenMark(token.chainId, token.tokenAddress, token.symbol);
  const title = `${displayName} history`;

  const pages = query.data?.pages ?? [];
  const firstPage = pages[0];
  const entries = pages.flatMap((page) => availablePage(page)?.entries ?? []);
  // A LATER page can fail or time out after entries already rendered —
  // pagination stops (getNextPageParam) and a quiet note appears by the
  // footer instead of wiping the list.
  const lastPage = pages.length > 1 ? pages[pages.length - 1] : undefined;
  const laterPageDegraded =
    lastPage !== undefined &&
    (!lastPage.ok || lastPage.data.status !== "available");

  let body: JSX.Element;
  if (query.isLoading) {
    body = (
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
        Loading…
      </p>
    );
  } else if (firstPage !== undefined && !firstPage.ok) {
    body = (
      <p className="text-[12.5px] text-[var(--vex-warn-text)]">
        Couldn&apos;t load this token&apos;s history.
      </p>
    );
  } else if (firstPage !== undefined && firstPage.ok && firstPage.data.status === "unavailable") {
    // Timeout degradation (plan v3): NEVER rendered as empty history.
    body = (
      <p className="text-[12.5px] leading-relaxed text-[var(--vex-text-2)]">
        History is unavailable right now — try again shortly.
      </p>
    );
  } else if (query.isError) {
    body = (
      <p className="text-[12.5px] text-[var(--vex-warn-text)]">
        Couldn&apos;t load this token&apos;s history.
      </p>
    );
  } else if (entries.length === 0) {
    body = (
      <p className="text-[12.5px] leading-relaxed text-[var(--vex-text-3)]">
        No Vex-recorded history for this token yet.
      </p>
    );
  } else {
    body = (
      <>
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
        {laterPageDegraded ? (
          <p className="mt-2 text-[11px] text-[var(--vex-text-3)]">
            Couldn&apos;t load more history right now.
          </p>
        ) : null}
        {query.hasNextPage ? (
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="mt-3 w-full rounded-lg border border-[var(--vex-line)] py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-2)] transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:opacity-60"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <ShellScreen
      title={title}
      origin={origin}
      onClose={onClose}
      header={
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <TokenMark mark={mark} size={20} />
            <span className="min-w-0 truncate text-[17px] font-semibold leading-tight text-foreground">
              {displayName}
            </span>
            <span className="shrink-0 text-[13px] text-[var(--vex-text-3)]">
              ({chainName})
            </span>
          </div>
          {/* Scope disclosure (plan v2): this feed is what Vex itself
           * recorded — protocol captures + Vex-executed sends. It is NOT a
           * chain scan; external activity is honestly out of scope. */}
          <p className="text-[11px] leading-snug text-[var(--vex-text-3)]">
            Vex-recorded activity — protocol captures and Vex-executed sends.
            Transfers made outside Vex (including airdrops) are not locally
            known.
          </p>
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
        <section aria-label="Activity">
          <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
            Activity
          </h2>
          {body}
        </section>
      </div>
    </ShellScreen>
  );
}

/**
 * One leg's inline display: optional safe icon + quantity + policy-gated symbol
 * text. When `estimated` (a Q2 bridge quote), a renderable quantity is prefixed
 * `~` so it never reads as a settled quantity (R14) — paired with a single row
 * "est." marker in `EntryRow`.
 */
function LegText({
  token,
  symbol,
  localSymbol,
  amount,
  estimated = false,
}: {
  readonly token: string | null;
  readonly symbol: string | null;
  readonly localSymbol: string | null;
  readonly amount: AmountField;
  readonly estimated?: boolean;
}): JSX.Element {
  const display = tokenDisplay(token, symbol, localSymbol);
  const quantity = quantityText(amount);
  const shown = estimated && quantity !== "—" ? `~${quantity}` : quantity;
  return (
    <span
      title={display.full ?? undefined}
      className="inline-flex min-w-0 items-center gap-1"
    >
      {display.iconSymbol !== null ? (
        <TokenIcon symbol={display.iconSymbol} size={12} />
      ) : null}
      <span className="truncate">
        {shown} {display.text}
      </span>
    </span>
  );
}

/**
 * Bridge status chip (Agent Scan Phase 2). A `pending` bridge reads "settling"
 * (the durable sweep tracks it — it is NOT a failure); a `bridge_refunded`
 * failure reads "refunded" in a NEUTRAL tone (money returned ≠ a completed
 * bridge, but ≠ a loss either — distinct from a destructive `failed`); any
 * other failure reads "failed" (destructive). `confirmed`/`null` → no chip.
 */
const BRIDGE_STATUS_TONE: Record<"settling" | "refunded" | "failed", string> = {
  settling: "border-[var(--vex-line)] text-[var(--vex-accent)]",
  refunded: "border-[var(--vex-line-strong)] text-[var(--vex-text-2)]",
  failed:
    "border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] text-[var(--color-destructive)]",
};

function bridgeStatusChip(
  entry: Extract<TokenHistoryEntry, { kind: "bridge" }>,
): { readonly text: string; readonly tone: keyof typeof BRIDGE_STATUS_TONE; readonly title: string | undefined } | null {
  if (entry.status === "pending") {
    // R12: a pending bridge is normally "settling — tracked automatically", BUT
    // if the sweep has not successfully checked its order status in a long time
    // (last_checked_at, or createdAt before the first check, is stale) the
    // tracking is DELAYED — say so honestly instead of the reassuring default.
    if (isBridgeTrackingStale(entry.lastCheckedAt, entry.createdAt)) {
      const checked =
        entry.lastCheckedAt !== null
          ? (entryDateText(entry.lastCheckedAt) ?? "an unknown time")
          : null;
      return {
        text: "tracking delayed",
        tone: "settling",
        title:
          checked !== null
            ? `Tracking delayed — last checked ${checked}`
            : "Tracking delayed — not yet checked since the bridge started",
      };
    }
    return { text: "settling", tone: "settling", title: "Still settling — tracked automatically" };
  }
  if (entry.status === "failed") {
    if (entry.failureCode === "bridge_refunded") {
      return {
        text: "refunded",
        tone: "refunded",
        title: "Funds returned to the origin chain — not a completed bridge",
      };
    }
    return { text: "failed", tone: "failed", title: entry.failureCode ?? undefined };
  }
  return null;
}

/** Short leg-role label for the expandable per-leg audit list. */
function legRoleLabel(role: BridgeLegRole): string {
  switch (role) {
    case "allowance_reset":
    case "allowance":
      return "APPROVE";
    case "bridge_deposit":
      return "DEPOSIT";
    case "bridge_fee":
      return "VEX FEE";
    case "bridge_fill_expected":
    case "bridge_fill_observed":
      return "FILL";
    case "bridge_refund":
      return "REFUND";
  }
}

/**
 * Explorer URL for one bridge leg — built through the SAME curated allowlist
 * (`explorerTxUrl`) as every other link, keyed by the leg's `chainFamily`
 * (`solana` → the signature path; else the leg's own bare decimal chain id).
 * `null` (no hash yet / uncurated chain) → the leg renders non-interactive.
 */
function bridgeLegUrl(leg: BridgeLeg): string | null {
  if (leg.txHash === null) return null;
  const chain = leg.chainFamily === "solana" ? "solana" : String(leg.chainId);
  return explorerTxUrl(chain, leg.txHash);
}

/**
 * Expandable per-leg audit list for a bridge (B8) — every leg (approvals,
 * deposit, the canonical fill, extra fills, refunds) with its own chain +
 * explorer link. Collapsed by default; NEVER truncated (OWNER RULE).
 */
function BridgeLegs({ legs }: { readonly legs: readonly BridgeLeg[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (legs.length === 0) return null;
  return (
    <div className="mt-1 pl-[21px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
      >
        {open ? "Hide" : "Show"} {legs.length} leg{legs.length === 1 ? "" : "s"}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-1">
          {legs.map((leg, index) => {
            const url = bridgeLegUrl(leg);
            const legStatus = leg.status === "definitively_failed" ? "failed" : leg.status;
            return (
              <li
                key={`${leg.role}:${index}:${leg.txHash ?? "none"}`}
                className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]"
              >
                <span className="inline-flex h-3.5 min-w-[52px] shrink-0 items-center justify-center rounded-[3px] border border-[var(--vex-line)] px-1 uppercase tracking-[0.14em]">
                  {legRoleLabel(leg.role)}
                </span>
                <span className="shrink-0">{leg.chainFamily === "solana" ? "solana" : leg.chainId}</span>
                {legStatus !== null ? <span className="shrink-0">{legStatus}</span> : null}
                {url !== null ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${legRoleLabel(leg.role)} leg on block explorer`}
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
                  >
                    TX
                    <HugeiconsIcon icon={ArrowUpRight01Icon} size={10} aria-hidden />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function EntryRow({ entry }: { readonly entry: TokenHistoryEntry }): JSX.Element {
  const stamp = entryStamp(entry);
  const date = entryDateText(entry.createdAt);
  const bridgeChip = entry.kind === "bridge" ? bridgeStatusChip(entry) : null;
  const links = entry.txRefs
    .map((ref) => ({ ref, url: txRefUrl(ref) }))
    .filter(
      (candidate): candidate is { ref: TokenHistoryTxRef; url: string } =>
        candidate.url !== null,
    );

  // Meta line parts: venue/chain context per kind, mono and muted.
  const meta: string[] = [];
  if (entry.kind === "swap") {
    if (entry.venue !== null && entry.venue.length > 0) {
      meta.push(entry.venue.toUpperCase());
    }
    if (entry.chain.length > 0) meta.push(entry.chain.toLowerCase());
  } else if (entry.kind === "bridge") {
    if (entry.venue !== null && entry.venue.length > 0) {
      meta.push(entry.venue.toUpperCase());
    }
    meta.push(
      entry.destinationChain !== null && entry.destinationChain.length > 0
        ? `${entry.originChain.toLowerCase()} → ${entry.destinationChain.toLowerCase()}`
        : entry.originChain.toLowerCase(),
    );
  } else {
    if (entry.chain !== null && entry.chain.length > 0) {
      meta.push(entry.chain.toLowerCase());
    }
    if (entry.status.length > 0) meta.push(entry.status.toLowerCase());
  }

  // Primary USD figure (swap/bridge legs; transfers carry no trade
  // economics). Output value leads; input value is the fallback. Carries its
  // own `usdProvenance` tag (C35) — `usdText` renders an `"estimated"` figure
  // with an explicit `~ … est.` marker, never as bare execution-time USD.
  const usdPrimary =
    entry.kind === "transfer"
      ? null
      : primaryUsdField(entry.input.valueUsd, entry.output.valueUsd);
  const unitPrice = entry.kind === "swap" ? unitPriceText(entry.unitPriceUsd) : null;
  // R14: a bridge whose displayed amounts are the QUOTE (not an independently
  // verified fill) marks both legs `~…` + a single trailing "est." tag, so a
  // quoted bridge amount never reads as an executed quantity.
  const bridgeEstimated = entry.kind === "bridge" && entry.amountBasis === "estimated";

  return (
    <li className="border-b border-[var(--vex-line)] py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={KIND_GLYPH[entry.kind]}
          size={13}
          aria-hidden
          className="shrink-0 text-[var(--vex-text-3)]"
        />
        <span
          className={cn(
            "inline-flex h-4 shrink-0 items-center justify-center rounded-[3px] border px-1.5 font-mono text-[9px] uppercase tracking-[0.14em]",
            STAMP_TONE[stamp.tone],
          )}
        >
          {stamp.text}
        </span>
        {entry.kind === "swap" && (entry.status === "pending" || entry.status === "failed") ? (
          <span
            title={entry.status === "failed" ? (entry.failureCode ?? undefined) : undefined}
            className={cn(
              "inline-flex h-4 shrink-0 items-center justify-center rounded-[3px] border px-1.5 font-mono text-[9px] uppercase tracking-[0.14em]",
              SWAP_STATUS_TONE[entry.status],
            )}
          >
            {entry.status}
          </span>
        ) : null}
        {bridgeChip !== null ? (
          <span
            title={bridgeChip.title}
            className={cn(
              "inline-flex h-4 shrink-0 items-center justify-center rounded-[3px] border px-1.5 font-mono text-[9px] uppercase tracking-[0.14em]",
              BRIDGE_STATUS_TONE[bridgeChip.tone],
            )}
          >
            {bridgeChip.text}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px] leading-none text-[var(--vex-text)]">
          {entry.kind === "transfer" ? (
            <>
              <span className="truncate">{quantityText(entry.amount)}</span>
              <span className="shrink-0 text-[var(--vex-text-3)]">→</span>
              <span className="truncate" title={entry.toAddress}>
                {truncateAddress(entry.toAddress)}
              </span>
            </>
          ) : (
            <>
              <LegText
                token={entry.input.token}
                symbol={entry.input.symbol}
                localSymbol={entry.input.localSymbol}
                amount={entry.input.amount}
                estimated={bridgeEstimated}
              />
              <span className="shrink-0 text-[var(--vex-text-3)]">→</span>
              <LegText
                token={entry.output.token}
                symbol={entry.output.symbol}
                localSymbol={entry.output.localSymbol}
                amount={entry.output.amount}
                estimated={bridgeEstimated}
              />
              {bridgeEstimated ? (
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
                  est.
                </span>
              ) : null}
            </>
          )}
        </span>
        {usdPrimary !== null && usdPrimary.value !== null ? (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-[var(--vex-text)]">
            {usdText(usdPrimary)}
            {unitPrice !== null ? (
              <span className="text-[var(--vex-text-3)]"> @ {unitPrice}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-2 pl-[21px] font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
        {meta.length > 0 ? <span className="truncate">{meta.join(" · ")}</span> : null}
        {date !== null ? <span className="shrink-0">{date}</span> : null}
        {links.map(({ ref, url }, index) => (
          <a
            key={`${ref.chainId}:${ref.ref}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open transaction on block explorer${links.length > 1 ? ` (${index + 1} of ${links.length})` : ""}`}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            TX{links.length > 1 ? ` ${index + 1}` : ""}
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} aria-hidden />
          </a>
        ))}
      </div>
      {/* Per-leg audit (bridges) — deposit/approvals/fill/refund, each with its
       * own chain + explorer link, expandable so a multi-leg bridge shows once
       * (B8). agent_activity bridges carry per-leg hashes in `legs` (never
       * truncated); legacy bridges carry none and render nothing here. */}
      {entry.kind === "bridge" ? <BridgeLegs legs={entry.legs} /> : null}
    </li>
  );
}
