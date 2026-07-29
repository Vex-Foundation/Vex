/**
 * `agent-scan-db.ts` row → `AgentScanEntry` mapping.
 *
 * Four decisions live here, and each one has a specific failure it exists to
 * prevent.
 *
 * 1. AMOUNT HONESTY (contract C20). The row carries BOTH the quote-time
 *    requested legs and the receipt-derived executed legs; exactly one of them
 *    may honestly be shown, and which one depends on the lifecycle status. That
 *    rule is NOT re-implemented here — it is delegated to the shared
 *    `./agent-activity-amount.js`, the same module `token-history-db` uses. A plain SWAP uses `resolveAgentActivityAmount`
 *    (blank rather than mislabelled; its confirmed-without-decode case is
 *    unreachable — migration 044's `agent_activity_confirmed_swap_has_executed_legs`
 *    CHECK enforces it). Every other kind uses
 *    `resolveAmountWithEstimateBasis`, because that CHECK is scoped
 *    `event_role <> 'swap'`: a bridge fill is solver-signed, and a
 *    lend/prediction/wrap row can confirm without decoder-proven amounts, so
 *    those fall back to the quote EXPLICITLY labelled `amountBasis:
 *    "estimated"` instead of going blank.
 *
 * 2. SYMBOL vs DISPLAY SYMBOL. The stored symbol goes through
 *    `sanitizeTokenSymbol` (untrusted provider metadata) and lands in `symbol`.
 *    The native-asset annotation is derived SEPARATELY into `displaySymbol`,
 *    never through the sanitizer — the sanitizer's allowlist rejects spaces and
 *    parentheses by design, so `NATIVE (ETH)` would sanitize to `null` and the
 *    leg would lose its label entirely. `native-currency.ts` documents this
 *    exact trap. Annotation is EVM-only and degrades to the bare `NATIVE`
 *    sentinel on an unresolvable chain; a Solana leg's `SOL` is a real ticker,
 *    not the sentinel, so it passes through untouched.
 *
 * 3. EXPLORER URLS ARE BUILT HERE, IN MAIN. Only through the curated
 *    `shared/explorer-links.ts` map — the same allowlist main's external-link
 *    gate is spread from — so every URL this feed emits is allowlisted by
 *    construction and no provider-supplied URL can reach the renderer. An
 *    uncurated chain resolves to `null` (a non-interactive row), never a
 *    guessed host. A LEG resolves by its own `chainFamily` first: the
 *    provider-native Solana chain id differs between providers (Khalani
 *    20011000000 vs Relay 792703809), so it is deliberately not used as a key.
 *
 * 4. NOTHING IS DROPPED. Unlike `coerceBridgeLegs`, which silently discards a
 *    leg whose role its closed enum does not know, every leg the DB returns is
 *    mapped. A role added by a future migration surfaces as an
 *    unlabelled-but-present leg. Silently vanishing evidence is not an option
 *    on an audit surface (OWNER RULE 2026-07-23).
 */

import { annotateNativeSymbol } from "@tools/evm-chains/native-currency.js";
import { explorerTxUrl } from "@shared/explorer-links.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import {
  AGENT_SCAN_TEXT_BOUNDS,
  type AgentScanBridgeLeg,
  type AgentScanChainRef,
  type AgentScanEntry,
  type AgentScanTokenLeg,
  type AgentScanVexFee,
} from "@shared/schemas/agent-scan-feed.js";
import {
  ACTIVITY_KIND_MAX_LENGTH,
  ACTIVITY_STATUS_MAX_LENGTH,
  DB_DEFINITIVELY_FAILED_STATUS,
  EVENT_ROLE_MAX_LENGTH,
} from "@shared/agent-activity-vocabulary.js";
import {
  resolveAgentActivityAmount,
  resolveAmountWithEstimateBasis,
  type AgentActivitySwapStatus,
} from "./agent-activity-amount.js";
import type { AgentScanRow } from "./agent-scan-db-types.js";

// ── Scalar coercion ───────────────────────────────────────────────────────

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * `BIGINT` arrives from node-postgres as a STRING. Returns `null` rather than a
 * lossy or `NaN` number — an unreadable chain id must degrade to "no link",
 * never to a wrong one.
 */
function toChainId(value: number | string | null): number | null {
  if (value === null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/**
 * Token decimals, rejected unless they are a plausible denomination. An
 * out-of-range value is not "decimals we happen not to like" — it is data we
 * cannot interpret, and passing it through would fail the DTO's own bound and
 * take the entire page down over one bad row.
 */
function toDecimals(value: number | null): number | null {
  if (value === null) return null;
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}

/** `NUMERIC` arrives as a string; keep it a string — a USD figure is never a float here. */
function toUsdStringOrNull(value: number | string | null): string | null {
  if (value === null) return null;
  return String(value);
}

/**
 * Bound a tolerant display string. Every source column is already DB-CHECK
 * constrained or SQL-clamped, so this is a guard, not a routine truncation: it
 * guarantees a drifted over-long value degrades to a clipped label instead of
 * failing output validation and blanking the whole page.
 */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// ── Status ────────────────────────────────────────────────────────────────

const KNOWN_AMOUNT_STATUSES = ["pending", "confirmed", "failed"] as const;

/**
 * Narrow the SQL-collapsed status to the closed vocabulary the amount
 * resolvers accept. An unrecognized value yields `null`, which makes both
 * resolvers show NOTHING — the honest answer when we cannot tell what state the
 * row is in.
 */
function toAmountStatus(value: string | null): AgentActivitySwapStatus | null {
  if (value === DB_DEFINITIVELY_FAILED_STATUS) return "failed";
  return value !== null && (KNOWN_AMOUNT_STATUSES as readonly string[]).includes(value)
    ? (value as AgentActivitySwapStatus)
    : null;
}

/** DTO status: tolerant, bounded, and never absent (`agent_activity.status` is NOT NULL). */
function toDtoStatus(value: string | null): string {
  if (value === DB_DEFINITIVELY_FAILED_STATUS) return "failed";
  return boundedText(value, ACTIVITY_STATUS_MAX_LENGTH) ?? "unknown";
}

// ── Chain identity ────────────────────────────────────────────────────────

/**
 * The tolerant chain key `explorerTxUrl` expects: the curated slug when the row
 * has one, else the bare decimal chain id (both shapes are keys in
 * `EXPLORER_TX_BASE`). `null` when neither is available — no link.
 */
function chainKey(slug: string | null, chainId: number | null): string | null {
  if (slug !== null && slug.trim().length > 0) return slug;
  return chainId !== null ? String(chainId) : null;
}

function resolveExplorerUrl(
  slug: string | null,
  chainId: number | null,
  txHash: string | null,
): string | null {
  if (txHash === null) return null;
  const key = chainKey(slug, chainId);
  return key === null ? null : explorerTxUrl(key, txHash);
}

function chainRef(chainId: number | null, slug: string | null): AgentScanChainRef | null {
  if (chainId === null && slug === null) return null;
  return { chainId, slug };
}

// ── Token legs ────────────────────────────────────────────────────────────

interface LegSource {
  readonly address: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly amountHuman: string | null;
  readonly amountRaw: string | null;
  readonly executedAmountHuman: string | null;
  readonly executedAmountRaw: string | null;
  readonly usdEst: number | string | null;
  /** The chain this leg executes on — a bridge's two legs are on different chains. */
  readonly chainId: number | null;
  /** The one honest amount for this leg's status, already resolved (C20). */
  readonly displayAmount: string | null;
}

function mapTokenLeg(source: LegSource): AgentScanTokenLeg {
  const symbol = sanitizeTokenSymbol(source.symbol);
  return {
    address: boundedText(source.address, AGENT_SCAN_TEXT_BOUNDS.tokenAddress),
    symbol,
    // Derived from the SANITIZED symbol, and kept in its own field — see the
    // module header for why this can never be folded back into `symbol`.
    displaySymbol: symbol === null ? null : annotateNativeSymbol(symbol, source.chainId),
    decimals: source.decimals,
    amountHuman: source.amountHuman,
    amountRaw: source.amountRaw,
    executedAmountHuman: source.executedAmountHuman,
    executedAmountRaw: source.executedAmountRaw,
    displayAmount: source.displayAmount,
    usdEst: toUsdStringOrNull(source.usdEst),
  };
}

// ── Execution legs ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapExecutionLeg(raw: unknown): AgentScanBridgeLeg {
  const leg = isRecord(raw) ? raw : {};
  const chainId = toChainId(
    typeof leg["chainId"] === "number" || typeof leg["chainId"] === "string"
      ? leg["chainId"]
      : null,
  );
  const chainFamily = boundedText(leg["chainFamily"], AGENT_SCAN_TEXT_BOUNDS.chainFamily);
  const chainSlug = boundedText(leg["chainSlug"], AGENT_SCAN_TEXT_BOUNDS.chainSlug);
  const txHash = boundedText(leg["txHash"], AGENT_SCAN_TEXT_BOUNDS.txRef);
  // A `solana`-family leg resolves through the `solana` explorer path, NOT its
  // provider-native chain id (which differs between Khalani and Relay).
  const explorerKey = chainFamily === "solana" ? "solana" : chainKey(chainSlug, chainId);
  return {
    role: boundedText(leg["role"], EVENT_ROLE_MAX_LENGTH),
    chainId,
    chainFamily,
    chainSlug,
    txHash,
    status: boundedText(leg["status"], ACTIVITY_STATUS_MAX_LENGTH),
    failureCode: boundedText(leg["failureCode"], AGENT_SCAN_TEXT_BOUNDS.failureCode),
    explorerUrl:
      txHash === null || explorerKey === null ? null : explorerTxUrl(explorerKey, txHash),
  };
}

/** Maps EVERY leg the DB returned — none is dropped (module header, point 4). */
function mapExecutionLegs(raw: unknown): AgentScanBridgeLeg[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapExecutionLeg);
}

// ── Vex fee ───────────────────────────────────────────────────────────────

function mapVexFee(row: AgentScanRow): AgentScanVexFee | null {
  const tokenSymbol = sanitizeTokenSymbol(row.vex_fee_token_symbol);
  const amountHuman = row.vex_fee_amount_human;
  if (tokenSymbol === null && amountHuman === null) return null;
  return { tokenSymbol, amountHuman };
}

// ── Entry ─────────────────────────────────────────────────────────────────

export function mapAgentScanRow(row: AgentScanRow): AgentScanEntry {
  const activityKind = boundedText(row.activity_kind, ACTIVITY_KIND_MAX_LENGTH) ?? "activity";
  const amountStatus = toAmountStatus(row.status);
  // Guard the decimals ONCE, here, before anything consumes them. They feed the
  // base-unit shift as well as the DTO, and `formatUnits` will faithfully
  // render 1024 decimal places for a nonsense value — producing an "amount"
  // that is both meaningless and long enough to fail output validation and
  // blank the whole page. No interpretable scale means no amount.
  const inDecimals = toDecimals(row.token_in_decimals);
  const outDecimals = toDecimals(row.token_out_decimals);
  const chainId = toChainId(row.chain_id);
  const fromChainId = toChainId(row.from_chain_id);
  const toChainId_ = toChainId(row.to_chain_id);
  const isBridge = activityKind === "bridge";

  // A plain swap's honesty rule blanks rather than mislabels and needs no
  // basis tag; every other kind may legitimately show a labelled estimate.
  // See the module header, point 1.
  let inputDisplayAmount: string | null;
  let outputDisplayAmount: string | null;
  let amountBasis: AgentScanEntry["amountBasis"] = null;
  if (activityKind === "swap") {
    inputDisplayAmount = resolveAgentActivityAmount(
      amountStatus,
      row.amount_in_human,
      row.executed_amount_in_raw,
      inDecimals,
    );
    outputDisplayAmount = resolveAgentActivityAmount(
      amountStatus,
      row.amount_out_human,
      row.executed_amount_out_raw,
      outDecimals,
    );
  } else {
    const inRes = resolveAmountWithEstimateBasis(
      amountStatus,
      row.amount_in_human,
      row.executed_amount_in_raw,
      inDecimals,
    );
    const outRes = resolveAmountWithEstimateBasis(
      amountStatus,
      row.amount_out_human,
      row.executed_amount_out_raw,
      outDecimals,
    );
    inputDisplayAmount = inRes.value;
    outputDisplayAmount = outRes.value;
    // The executed columns are populated together (B4), so the two bases agree
    // in practice; prefer the output (receive) side, as the sibling feeds do.
    amountBasis = outRes.basis ?? inRes.basis;
  }

  const chainSlug = boundedText(row.chain_slug, AGENT_SCAN_TEXT_BOUNDS.chainSlug);
  const txHash = boundedText(row.tx_hash, AGENT_SCAN_TEXT_BOUNDS.txRef);

  return {
    id: row.source_id,
    createdAt: toIso(row.created_at),
    activityKind,
    eventRole: boundedText(row.event_role, EVENT_ROLE_MAX_LENGTH) ?? "unknown",
    status: toDtoStatus(row.status),
    protocol: boundedText(row.protocol, AGENT_SCAN_TEXT_BOUNDS.protocol),
    chainId,
    chainFamily: boundedText(row.chain_family, AGENT_SCAN_TEXT_BOUNDS.chainFamily),
    chainSlug,
    // Route endpoints are a BRIDGE concept; a same-chain activity has none.
    fromChain: isBridge
      ? chainRef(fromChainId, boundedText(row.from_chain_slug, AGENT_SCAN_TEXT_BOUNDS.chainSlug))
      : null,
    toChain: isBridge
      ? chainRef(toChainId_, boundedText(row.to_chain_slug, AGENT_SCAN_TEXT_BOUNDS.chainSlug))
      : null,
    input: mapTokenLeg({
      address: row.token_in_address,
      symbol: row.token_in_symbol,
      decimals: inDecimals,
      amountHuman: row.amount_in_human,
      amountRaw: row.amount_in_raw,
      executedAmountHuman: row.executed_amount_in_human,
      executedAmountRaw: row.executed_amount_in_raw,
      usdEst: row.usd_in_est,
      // A bridge's IN leg lives on the ORIGIN chain, not the row's own chain
      // (which, for a fill row, is the destination).
      chainId: isBridge ? fromChainId : chainId,
      displayAmount: inputDisplayAmount,
    }),
    output: mapTokenLeg({
      address: row.token_out_address,
      symbol: row.token_out_symbol,
      decimals: outDecimals,
      amountHuman: row.amount_out_human,
      amountRaw: row.amount_out_raw,
      executedAmountHuman: row.executed_amount_out_human,
      executedAmountRaw: row.executed_amount_out_raw,
      usdEst: row.usd_out_est,
      chainId: isBridge ? toChainId_ : chainId,
      displayAmount: outputDisplayAmount,
    }),
    amountBasis,
    vexFee: mapVexFee(row),
    usdFeeEst: toUsdStringOrNull(row.usd_fee_est),
    failureCode: boundedText(row.failure_code, AGENT_SCAN_TEXT_BOUNDS.failureCode),
    failureReason: boundedText(row.failure_reason, AGENT_SCAN_TEXT_BOUNDS.failureReason),
    txHash,
    explorerUrl: resolveExplorerUrl(chainSlug, chainId, txHash),
    providerOrderId: boundedText(
      row.provider_order_id,
      AGENT_SCAN_TEXT_BOUNDS.providerOrderId,
    ),
    legs: mapExecutionLegs(row.legs),
    lastCheckedAt: row.last_checked_at != null ? toIso(row.last_checked_at) : null,
  };
}
