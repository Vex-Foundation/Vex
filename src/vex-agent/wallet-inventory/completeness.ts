/**
 * The TWO independent completeness axes of a wallet balance answer (C3).
 *
 * A wallet whose holdings were all enumerated but whose prices are missing is a
 * DIFFERENT state from an indexer outage, and collapsing them is how both
 * wallet references ship a short list that looks complete: MetaMask swallows a
 * detection failure into an empty result indistinguishable from "this chain has
 * no tokens" (`TokenBalancesController.ts:958-1022`), and Rabby returns early
 * with `isLoading=false`, visually identical to a full read. Uniswap's data
 * layer is the reference that gets it right: it propagates the categories that
 * did NOT report and derives a total only from the slices that did
 * (`getWalletBalances.ts:34-159`).
 *
 * So this module answers two questions separately and never lets one decide the
 * other:
 *
 * - INVENTORY: did we enumerate and read every holding we were supposed to?
 * - VALUATION: does every known held row carry a value?
 *
 * An inventory failure does NOT make the valuation of the rows we DID read
 * false; it only means the total is a `priced_only` figure rather than a
 * `complete` one. This is a pure module: it takes already-projected rows and
 * per-chain read outcomes and returns the envelope. It performs no I/O, knows
 * nothing about Khalani, Solana or local chains, and is the single owner of
 * these fields for every balance surface that reports them.
 */

/** Which enumerator produced (or failed to produce) one chain's holdings. */
export type InventorySourceKind =
  /** Khalani's multi-chain balances endpoint: enumerates every holding it knows. */
  | "khalani_registry_scan"
  /** Direct RPC over the seed ∪ pinned token set of a local chain. Bounded by construction. */
  | "local_chain_seed_and_pins"
  /** Solana RPC token accounts plus the account balance: enumerates every account the wallet owns. */
  | "solana_rpc_accounts";

/** What the source actually did on this call. Never a third "maybe". */
export type InventorySourceResult = "read" | "failed";

/**
 * One chain's enumeration outcome, as the agent sees it.
 *
 * `observedAt` is null on a failure ON PURPOSE (C3.5): a read that failed
 * observed nothing, and stamping it with the current time is how a stale answer
 * gets renamed fresh and the retry is suppressed.
 */
export interface InventorySource {
  readonly chainId: number;
  readonly source: InventorySourceKind;
  readonly result: InventorySourceResult;
  /**
   * Whether this source enumerates EVERY holding on the chain. False for a
   * source that can only read a known token set, so a token outside the set is
   * invisible rather than absent.
   */
  readonly exhaustive: boolean;
  /** ISO-8601 observation time, or null when the read failed. */
  readonly observedAt: string | null;
}

/**
 * Why the inventory axis is false. A summary LABEL, not the evidence: every
 * contributing signal is separately present in the same payload
 * (`failedChainIds`, `chainErrors`, `tokenErrors`, `accountErrors`,
 * `inventorySources[].result` / `.exhaustive`), so a single label hides
 * nothing. Precedence when several apply is {@link INVENTORY_REASON_PRECEDENCE}.
 */
export type InventoryIncompleteReason =
  /** A whole wallet family produced no snapshot. Envelope-level only. */
  | "wallet_read_failed"
  /** At least one chain's scan failed, so its holdings are unknown. */
  | "chain_read_failed"
  /** A token ACCOUNT could not be trusted; the holdings behind it are absent. */
  | "account_read_failed"
  /** A token in the scan set could not be read; that holding is absent. */
  | "token_read_failed"
  /** Every read succeeded, but a source only enumerates a bounded token set. */
  | "source_not_exhaustive";

/**
 * Worst-first. A missing chain outranks a missing account, which outranks a
 * missing token, which outranks a source that never claimed to be exhaustive.
 */
const INVENTORY_REASON_PRECEDENCE: readonly InventoryIncompleteReason[] = [
  "wallet_read_failed",
  "chain_read_failed",
  "account_read_failed",
  "token_read_failed",
  "source_not_exhaustive",
];

/**
 * The two axes as they appear on a wallet snapshot AND on the top-level
 * envelope. Both surfaces carry the identical field set so an agent reads one
 * contract, not two.
 */
export interface CompletenessEnvelope {
  /** True only when every expected holding was enumerated and read. */
  readonly inventoryComplete: boolean;
  /** Per-chain enumeration outcomes, including the failed ones. */
  readonly inventorySources: readonly InventorySource[];
  /** Present only when `inventoryComplete` is false. */
  readonly inventoryIncompleteReason?: InventoryIncompleteReason;
  /** True only when every KNOWN held (or unknown-holding) row carries a value. */
  readonly valuationComplete: boolean;
  /**
   * Every known nonzero row lacking a usable price feed. The FULL count over
   * the whole scan, never the concise trim's `unpricedOmitted` overflow.
   */
  readonly unpricedHeldCount: number;
  /** Exact decimal sum of the rows that DID carry a value. A string, not a float. */
  readonly pricedTotalUsd: string;
  /** `complete` requires BOTH axes true; anything else is `priced_only`. */
  readonly totalUsdBasis: "priced_only" | "complete";
  /** Chain ids whose read failed. Their holdings are unknown, not zero. */
  readonly failedChainIds: number[];
}

/**
 * The only row fields the axes depend on. Structural on purpose: the Khalani
 * concise row and the Solana wallet row both satisfy it without this module
 * importing either lane.
 */
export interface CompletenessRow {
  readonly balanceRaw?: string;
  readonly priceUsd?: string | null;
  readonly valueUsd?: string | null;
}

/**
 * A balance entry the Khalani boundary refused for its `decimals` ALONE
 * (frozen contract C1.2, amendment 2026-08-31). Structural for the same reason
 * as {@link CompletenessRow}.
 */
export interface CompletenessRejectedEntry {
  /** Exact atomic amount, or null when the provider gave none / an inexact one. */
  readonly balanceRaw: string | null;
}

/** Whether the wallet actually holds the row, when that is knowable at all. */
export type HoldingState = "held" | "empty" | "unknown";

/**
 * Classify a raw atomic amount.
 *
 * "unknown" is a real third state and must not be folded into "empty": an
 * absent or inexact `balanceRaw` means we could not size the holding, which is
 * a different claim from holding none of it (C3.3, Uniswap: "`0` is a valid
 * balance, not a missing one").
 */
export function holdingState(balanceRaw: string | null | undefined): HoldingState {
  if (balanceRaw === null || balanceRaw === undefined) return "unknown";
  const trimmed = balanceRaw.trim();
  // `balanceRaw` is contractually an exact DECIMAL integer, never hex (C1), and
  // this guard is what keeps that contract single-valued: `BigInt` alone
  // happily reads "0x10" as 16, which would classify a value this codebase
  // never emits, under a magnitude the row's own projection refuses to convert.
  // Same rule as `projectBalanceRow`, so an amount is "held" here if and only
  // if the row could carry a human balance at all.
  if (!EXACT_INTEGER.test(trimmed)) return "unknown";
  return BigInt(trimmed) === 0n ? "empty" : "held";
}

/** An exact base-10 integer. Mirrors the guard in `protocols/amount-display.ts`. */
const EXACT_INTEGER = /^[+-]?\d+$/;

/**
 * True when the row carries a usable USD price feed. A finite ZERO is a feed
 * (the provider quoted it), so only a missing, malformed, or negative price
 * counts as "no price".
 */
export function hasUsdPrice(row: CompletenessRow): boolean {
  const price = row.priceUsd;
  if (price === undefined || price === null || price.trim() === "") return false;
  const parsed = Number(price);
  return Number.isFinite(parsed) && parsed >= 0;
}

/** True when the row reports a balance the wallet actually holds. */
export function holdsBalance(row: CompletenessRow): boolean {
  return holdingState(row.balanceRaw) === "held";
}

// ── Exact decimal totals ────────────────────────────────────────

/** A signed decimal literal. Exponent notation is deliberately NOT accepted. */
const DECIMAL_LITERAL = /^[+-]?(?:\d+)(?:\.\d+)?$/;

interface ScaledDecimal {
  readonly units: bigint;
  readonly scale: number;
}

function parseDecimal(value: string): ScaledDecimal | null {
  const trimmed = value.trim();
  if (!DECIMAL_LITERAL.test(trimmed)) return null;
  const dot = trimmed.indexOf(".");
  if (dot === -1) return { units: BigInt(trimmed), scale: 0 };
  const sign = trimmed.startsWith("-") ? -1n : 1n;
  const digits = trimmed.replace("-", "").replace("+", "").replace(".", "");
  const scale = trimmed.length - dot - 1;
  return { units: sign * BigInt(digits), scale };
}

function renderDecimal(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * Sum decimal STRINGS exactly.
 *
 * The addends are display-grade USD estimates already derived from provider
 * floats, so this cannot make the total more accurate than its inputs - but it
 * must not make it LESS accurate either, and `Number` addition over a long dust
 * list does exactly that. Every addend is scaled to the widest fraction seen,
 * so no digit any input carried is dropped. A value this parser cannot read is
 * skipped, which is why only rows that produced a value reach it.
 */
export function sumDecimalStrings(values: readonly string[]): string {
  const parsed = values.map(parseDecimal).filter((entry): entry is ScaledDecimal => entry !== null);
  if (parsed.length === 0) return "0";
  const scale = parsed.reduce((max, entry) => Math.max(max, entry.scale), 0);
  const total = parsed.reduce(
    (sum, entry) => sum + entry.units * 10n ** BigInt(scale - entry.scale),
    0n,
  );
  return renderDecimal(total, scale);
}

// ── The axes ────────────────────────────────────────────────────

export interface WalletCompletenessInput {
  /** The FULL pre-trim projected row set. A display trim must never reach here. */
  readonly rows: readonly CompletenessRow[];
  /** Per-chain enumeration outcomes for this wallet. */
  readonly sources: readonly InventorySource[];
  /** Tokens in the scan set whose individual read failed. */
  readonly tokenErrorCount: number;
  /** Token accounts the read could not trust. */
  readonly accountErrorCount: number;
  /** Decimals-only rejections carried out of the Khalani boundary. */
  readonly rejectedEntries: readonly CompletenessRejectedEntry[];
}

/**
 * Compute both axes for ONE wallet snapshot.
 *
 * The decimals-only rejection is the subtle case, and the frozen contract fixes
 * it: the entry's identity and atomic amount are still true facts, so the
 * INVENTORY stays complete - the wallet does show it holds the token - while
 * its VALUE is honestly unknown, so the VALUATION axis goes false whenever the
 * entry is held or its holding is unknown. A rejection whose amount is an exact
 * zero costs neither axis. An entry whose identity or structure was also
 * malformed never arrives here at all: the boundary fails that chain, and the
 * chain error is what this function sees.
 */
export function computeWalletCompleteness(input: WalletCompletenessInput): CompletenessEnvelope {
  const failedChainIds = [
    ...new Set(
      input.sources.filter((source) => source.result === "failed").map((source) => source.chainId),
    ),
  ].sort((a, b) => a - b);

  const reasons = new Set<InventoryIncompleteReason>();
  if (failedChainIds.length > 0) reasons.add("chain_read_failed");
  if (input.accountErrorCount > 0) reasons.add("account_read_failed");
  if (input.tokenErrorCount > 0) reasons.add("token_read_failed");
  if (input.sources.some((source) => source.result === "read" && !source.exhaustive)) {
    reasons.add("source_not_exhaustive");
  }

  let unpricedHeldCount = 0;
  let everyKnownRowValued = true;
  const values: string[] = [];
  for (const row of input.rows) {
    const holding = holdingState(row.balanceRaw);
    if (holding === "held" && !hasUsdPrice(row)) unpricedHeldCount += 1;
    // A row we hold, or whose holding we could not size, must carry a READABLE
    // value for the valuation to be complete. An exactly-zero holding needs
    // none. A value the decimal parser cannot read counts as no value at all,
    // so it can never drop out of the total while the axis still claims
    // completeness.
    const valueUsd = typeof row.valueUsd === "string" ? row.valueUsd : null;
    if (valueUsd !== null && parseDecimal(valueUsd) !== null) values.push(valueUsd);
    else if (holding !== "empty") everyKnownRowValued = false;
  }
  for (const entry of input.rejectedEntries) {
    if (holdingState(entry.balanceRaw) !== "empty") everyKnownRowValued = false;
  }

  return finalizeEnvelope({
    inventoryComplete: reasons.size === 0,
    inventorySources: input.sources,
    reasons,
    valuationComplete: everyKnownRowValued,
    unpricedHeldCount,
    pricedTotalUsd: sumDecimalStrings(values),
    failedChainIds,
  });
}

/**
 * Fold per-wallet envelopes into the top-level one.
 *
 * A wallet family that produced NO snapshot is the envelope's own inventory
 * failure and outranks every per-wallet reason: half an answer must never be
 * reported as a whole one.
 */
export function combineWalletCompleteness(
  parts: readonly CompletenessEnvelope[],
  walletErrorCount: number,
): CompletenessEnvelope {
  const reasons = new Set<InventoryIncompleteReason>();
  if (walletErrorCount > 0) reasons.add("wallet_read_failed");
  for (const part of parts) {
    if (part.inventoryIncompleteReason !== undefined) reasons.add(part.inventoryIncompleteReason);
  }

  return finalizeEnvelope({
    inventoryComplete: reasons.size === 0,
    inventorySources: parts.flatMap((part) => [...part.inventorySources]),
    reasons,
    valuationComplete: parts.every((part) => part.valuationComplete),
    unpricedHeldCount: parts.reduce((sum, part) => sum + part.unpricedHeldCount, 0),
    pricedTotalUsd: sumDecimalStrings(parts.map((part) => part.pricedTotalUsd)),
    failedChainIds: [...new Set(parts.flatMap((part) => part.failedChainIds))].sort((a, b) => a - b),
  });
}

function finalizeEnvelope(input: {
  inventoryComplete: boolean;
  inventorySources: readonly InventorySource[];
  reasons: ReadonlySet<InventoryIncompleteReason>;
  valuationComplete: boolean;
  unpricedHeldCount: number;
  pricedTotalUsd: string;
  failedChainIds: number[];
}): CompletenessEnvelope {
  const reason = INVENTORY_REASON_PRECEDENCE.find((candidate) => input.reasons.has(candidate));
  return {
    inventoryComplete: input.inventoryComplete,
    inventorySources: input.inventorySources,
    ...(reason !== undefined ? { inventoryIncompleteReason: reason } : {}),
    valuationComplete: input.valuationComplete,
    unpricedHeldCount: input.unpricedHeldCount,
    pricedTotalUsd: input.pricedTotalUsd,
    totalUsdBasis: input.inventoryComplete && input.valuationComplete ? "complete" : "priced_only",
    failedChainIds: input.failedChainIds,
  };
}
