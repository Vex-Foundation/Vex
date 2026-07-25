/**
 * Verdict computation + extraction (untrusted result.data → trusted prequote
 * fields). The quote result payload (`ToolResult.data`) is UNTRUSTED here: it is
 * re-validated with Zod at this boundary. We deliberately do NOT import the
 * handler-local `QuoteSafetyLeg` type from kyberswap/handlers/swap.ts (it is not
 * exported); we structurally re-validate instead.
 *
 * NEVER persist or log raw provider/HTTP/DB/error text — only bounded structural
 * labels.
 */

import { z } from "zod";

import { NATIVE_TOKEN_ADDRESS, KYBERSWAP_DEFAULT_SLIPPAGE_BPS } from "@tools/kyberswap/constants.js";
import { buildApprovedPriceFloor, toRouteRef } from "@tools/kyberswap/swap-price-floor.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { jupiterFeePreviewSchema } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

// ── Verdict computation ───────────────────────────────────────────────────

type LegVerdict = "pass" | "fail" | "unknown";

/** Worst-leg aggregation: any fail → fail; else any unknown → unknown; else pass. */
function aggregateVerdict(legs: readonly LegVerdict[]): SafetyVerdict {
  if (legs.includes("fail")) return "fail";
  if (legs.includes("unknown")) return "unknown";
  return "pass";
}

// EVM safety legs — structural re-validation of the kyberswap quote safety
// block (we do NOT import the handler-local QuoteSafetyLeg type).
const EvmNativeLegSchema = z.object({ native: z.literal(true) });
const EvmAuditLegSchema = z.object({
  isHoneypot: z.boolean(),
  isFOT: z.boolean(),
  tax: z.number(),
});
const EvmCheckFailedLegSchema = z.object({
  checkFailed: z.literal(true),
  reason: z.string(),
});
const EvmLegSchema = z.union([
  EvmNativeLegSchema,
  EvmAuditLegSchema,
  EvmCheckFailedLegSchema,
]);
const EvmSafetySchema = z.object({
  tokenIn: EvmLegSchema,
  tokenOut: EvmLegSchema,
});
type EvmLeg = z.infer<typeof EvmLegSchema>;

/** Bounded reason class — only the four literals the handler emits survive. */
const EVM_CHECK_FAILED_REASONS = new Set([
  "timeout",
  "rate_limited",
  "kyber_error",
  "unavailable",
]);

interface LegVerdictDetail {
  readonly verdict: LegVerdict;
  readonly detail: Record<string, unknown>;
}

/**
 * Per-leg EVM verdict + bounded detail. Mirrors the ONE hard-abort in
 * `executeKyberSwap`: a CONFIRMED honeypot (`isHoneypot === true`) → fail. Per
 * owner doctrine that is the ONLY hard safety block for a swap — fee-on-transfer
 * / high tax is NOT a fail (the model decides on fee-bearing tokens, even in
 * full-autonomous + full-agent modes). The bounded detail STILL discloses
 * `{ isHoneypot, isFOT, tax }` so the model/human can see the fee-on-transfer in
 * the quote output (the verdict softens, the disclosure does not). A checkFailed
 * or malformed leg is fail-closed → unknown. Native does not worsen the verdict
 * (treated as pass at the leg level; aggregation ignores it anyway).
 */
function evmLegVerdict(leg: EvmLeg): LegVerdictDetail {
  if ("native" in leg) {
    return { verdict: "pass", detail: { native: true } };
  }
  if ("checkFailed" in leg) {
    // Defense-in-depth: only surface a bounded reason class, never raw text.
    const reason = EVM_CHECK_FAILED_REASONS.has(leg.reason) ? leg.reason : "unavailable";
    return { verdict: "unknown", detail: { checkFailed: true, reason } };
  }
  return {
    verdict: leg.isHoneypot ? "fail" : "pass",
    detail: { isHoneypot: leg.isHoneypot, isFOT: leg.isFOT, tax: leg.tax },
  };
}

// Solana token metadata + safety block — structural re-validation of the
// Jupiter quote summary fields we need.
const SolanaTokenMetadataSchema = z.object({
  address: z.string(),
  symbol: z.string().optional(),
  decimals: z.number().optional(),
});
const SolanaTokenSafetySchema = z.object({
  isSus: z.boolean().nullish(),
  mintAuthorityDisabled: z.boolean().nullish(),
  freezeAuthorityDisabled: z.boolean().nullish(),
  topHoldersPercentage: z.number().nullish(),
});
const SolanaQuoteSchema = z.object({
  inputToken: SolanaTokenMetadataSchema,
  outputToken: SolanaTokenMetadataSchema,
  safety: z
    .object({
      inputToken: SolanaTokenSafetySchema.optional(),
      outputToken: SolanaTokenSafetySchema.optional(),
    })
    .optional(),
  slippageBps: z.number().nullish(),
  // W5 (design §6 R4): `solana.swap.quote`'s fee-bearing disclosure, when
  // present. Optional so any pre-existing quote-result fixture without it
  // still validates — the new `solana.swap.quote` handler always includes it
  // in real traffic.
  feePreview: jupiterFeePreviewSchema.optional(),
});
type SolanaTokenSafety = z.infer<typeof SolanaTokenSafetySchema>;

function isNativeSolanaMint(mint: string): boolean {
  // Jupiter audits wSOL and returns isSus:false; treat the native sentinel as
  // a no-audit-needed leg regardless of whether a safety entry is present.
  return mint === SOL_MINT;
}

/**
 * Per-leg Solana verdict + bounded detail. A present entry with `isSus === true`
 * → fail; `isSus === false` → pass. A native (SOL/wSOL) leg never worsens the
 * verdict. An ABSENT entry for a non-native mint is fail-closed → unknown (no
 * audit data). `isSus` null/undefined on a present non-native entry is also
 * treated as "no verdict signal" → unknown (fail-closed).
 */
function solanaLegVerdict(
  mint: string,
  safety: SolanaTokenSafety | undefined,
): LegVerdictDetail {
  if (isNativeSolanaMint(mint)) {
    return { verdict: "pass", detail: { native: true } };
  }
  if (!safety || safety.isSus == null) {
    return { verdict: "unknown", detail: { auditPresent: false } };
  }
  const detail: Record<string, unknown> = { isSus: safety.isSus };
  if (safety.mintAuthorityDisabled != null) detail.mintAuthorityDisabled = safety.mintAuthorityDisabled;
  if (safety.freezeAuthorityDisabled != null) detail.freezeAuthorityDisabled = safety.freezeAuthorityDisabled;
  if (safety.topHoldersPercentage != null) detail.topHoldersPercentage = safety.topHoldersPercentage;
  return { verdict: safety.isSus ? "fail" : "pass", detail };
}

// ── Extraction (untrusted result.data → trusted prequote fields) ───────────

export interface ExtractedQuote {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly chainId: number | null;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
  /**
   * Structural-only route facts for the `route_ref` column, or null. Today
   * only `kyberswap.swap.quote` populates it, with the Vex-computed price
   * floor the execute is held to (`@tools/kyberswap/swap-price-floor`).
   */
  readonly routeRef?: Record<string, unknown> | null;
}

// EVM quote result (kyberswap.swap.quote) — token addresses + chainId + safety.
const EvmQuoteResultSchema = z.object({
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  safety: EvmSafetySchema,
});

/**
 * KyberSwap's RAW atomic-unit quoted output, already net of the Vex integrator
 * fee (it is charged on the input side) — the exact quantity the approved price
 * floor is computed from.
 *
 * Read DEFENSIVELY rather than through the schema above: a quote result whose
 * `routeSummary` is missing or shaped unexpectedly must still record a prequote
 * (with no floor, which `kyberswap.swap.execute` then refuses), never fail
 * extraction outright and leave the trade with no prequote at all. Any value
 * that is not a raw integer string is passed through as `undefined` and
 * `buildApprovedPriceFloor` declines it.
 */
function readQuotedNetOutRaw(data: Record<string, unknown>): unknown {
  const routeSummary = data.routeSummary;
  return typeof routeSummary === "object" && routeSummary !== null
    ? (routeSummary as Record<string, unknown>).amountOut
    : undefined;
}

function extractEvm(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  const parsed = EvmQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippage = typeof params.slippageBps === "number" ? params.slippageBps : null;

  const inLeg = evmLegVerdict(parsed.data.safety.tokenIn);
  const outLeg = evmLegVerdict(parsed.data.safety.tokenOut);

  // Vex's OWN price floor, computed from the output the user was just shown
  // and persisted so `kyberswap.swap.execute` can hold the opaque build
  // calldata to it. The slippage MUST be resolved exactly as the execute
  // resolves it — an omitted value takes the same venue default — or an
  // omitted-slippage quote would persist a floor the execute is not measured
  // against. A non-integer/out-of-range value never reaches here (both
  // handlers reject it first); `buildApprovedPriceFloor` returns null rather
  // than throwing if it somehow does, and the execute then refuses.
  const floor = buildApprovedPriceFloor(
    readQuotedNetOutRaw(data),
    slippage ?? KYBERSWAP_DEFAULT_SLIPPAGE_BPS,
  );

  return {
    tokenIn: parsed.data.tokenIn.address,
    tokenOut: parsed.data.tokenOut.address,
    chainId: parsed.data.chainId,
    amount: amountRaw,
    slippageBps: slippage,
    verdict: aggregateVerdict([inLeg.verdict, outLeg.verdict]),
    safetyDetail: { tokenIn: inLeg.detail, tokenOut: outLeg.detail },
    routeRef: floor ? toRouteRef(floor) : null,
  };
}

function extractSolana(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  const parsed = SolanaQuoteSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amount;
  // Solana params.amount is a human number; accept number or numeric string.
  const amount =
    typeof amountRaw === "number" && Number.isFinite(amountRaw)
      ? String(amountRaw)
      : typeof amountRaw === "string" && amountRaw.trim() !== ""
        ? amountRaw
        : null;
  if (amount === null) return null;

  // Slippage: prefer the quote's echoed value, else the request param.
  const slippage =
    typeof parsed.data.slippageBps === "number"
      ? parsed.data.slippageBps
      : typeof params.slippageBps === "number"
        ? params.slippageBps
        : null;

  const inMint = parsed.data.inputToken.address;
  const outMint = parsed.data.outputToken.address;
  const inLeg = solanaLegVerdict(inMint, parsed.data.safety?.inputToken);
  const outLeg = solanaLegVerdict(outMint, parsed.data.safety?.outputToken);
  return {
    tokenIn: inMint,
    tokenOut: outMint,
    chainId: null,
    amount,
    slippageBps: slippage,
    verdict: aggregateVerdict([inLeg.verdict, outLeg.verdict]),
    safetyDetail: {
      inputToken: inLeg.detail,
      outputToken: outLeg.detail,
      // W5 (design §6 R4): the bounded fee-bearing disclosure rides the same
      // JSONB channel as every other Solana quote detail — the gate later
      // extracts it back out for the approval preview.
      ...(parsed.data.feePreview !== undefined ? { feePreview: parsed.data.feePreview } : {}),
    },
  };
}

// ── Uniswap quote result (uniswap.swap.quote) — factory/liquidity/FoT signals ──
//
// Uniswap has no honeypot oracle, so on chains without one Vex derives its own
// conservative signals at quote time (see @tools/uniswap/safety). Verdict map
// (LOCKED #5 — doctrine unchanged; unknown = allowed-with-approval-warning):
//   - factory check failed        → unknown (never pass without confirmation),
//   - factory not allowlisted      → fail (integrity: a spoofed pool),
//   - factory ok + liquidity ≥ min + not FoT → pass,
//   - otherwise                    → unknown.
const UniswapFactorySchema = z.union([
  z.object({ checked: z.literal(true), allowlisted: z.boolean() }),
  z.object({ checkFailed: z.literal(true) }),
]);
const UniswapLiquiditySchema = z.union([
  z.object({ checked: z.literal(true), usd: z.number().nullable(), aboveThreshold: z.boolean() }),
  z.object({ checkFailed: z.literal(true), reason: z.string() }),
]);
const UniswapSafetySchema = z.object({
  factory: UniswapFactorySchema,
  liquidity: UniswapLiquiditySchema,
  fot: z.object({ suspected: z.boolean() }),
});
const UniswapQuoteResultSchema = z.object({
  chainId: z.number(),
  tokenIn: z.object({ address: z.string(), isNative: z.boolean().optional() }),
  tokenOut: z.object({ address: z.string(), isNative: z.boolean().optional() }),
  safety: UniswapSafetySchema,
});

/**
 * Identity leg for a uniswap quote token: a native leg records the SAME
 * sentinel the gate canonicalizes execute-time "native"/ETH input to
 * (`evmLegIdentity` in gate.ts) — the uniswap quote echoes its routing WETH
 * address for a native leg, which would otherwise never hash-match the
 * execute. A verbatim WETH-address quote still records verbatim: an ERC-20
 * WETH swap is a genuinely different trade from a native-ETH swap.
 */
function uniswapLegIdentity(leg: { address: string; isNative?: boolean }): string {
  return leg.isNative === true ? NATIVE_TOKEN_ADDRESS : leg.address;
}

function extractUniswap(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  const parsed = UniswapQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippage = typeof params.slippageBps === "number" ? params.slippageBps : null;

  const { factory, liquidity, fot } = parsed.data.safety;
  let verdict: SafetyVerdict;
  if ("checkFailed" in factory) {
    verdict = "unknown";
  } else if (!factory.allowlisted) {
    verdict = "fail";
  } else {
    const liquidityOk = "checked" in liquidity && liquidity.aboveThreshold;
    verdict = liquidityOk && !fot.suspected ? "pass" : "unknown";
  }

  return {
    tokenIn: uniswapLegIdentity(parsed.data.tokenIn),
    tokenOut: uniswapLegIdentity(parsed.data.tokenOut),
    chainId: parsed.data.chainId,
    amount: amountRaw,
    slippageBps: slippage,
    verdict,
    safetyDetail: { factory, liquidity, fot },
  };
}

// ── Pendle quote result (pendle.pt.quote) — fixed-yield PT (Wave 5) ─────────────
//
// A Pendle quote is NEITHER a token-honeypot check nor a bridge: its verdict
// derives from three market-quality signals, and `fail` is reserved for the ONE
// integrity failure (buying INTO an expired market). Everything else that is
// merely risky/unverified degrades to `unknown` (allowed-with-approval-warning) —
// missing data NEVER silently passes.
//   - price impact MAGNITUDE (sign is unreliable upstream): |impact| ≤ 1% → ok;
//     missing or > 1% → unknown (a > 5% impact is flagged "high" in the detail),
//   - market liquidity floor: ≥ $250k → ok; < $250k or missing → unknown,
//   - expiry sanity: a BUY requires expiry > now (else fail); sell/redeem: n/a.
// A buy also emits `termLock { maturityIso }` in the detail — the typed,
// unspoofable approval-preview warning that funds are locked until maturity.

const PENDLE_LIQUIDITY_FLOOR_USD = 250_000;
const PENDLE_IMPACT_WARN = 0.01;
const PENDLE_IMPACT_HIGH = 0.05;

const PendleQuoteResultSchema = z.object({
  action: z.enum(["swap", "redeem"]),
  direction: z.enum(["buy", "sell", "redeem"]),
  // PT (default when absent) vs YT. A YT buy still fails on an expired market but
  // emits NO term-lock — a YT is not locked, it decays to zero — so the approval
  // preview never renders a misleading "funds locked until maturity" for it.
  instrument: z.enum(["pt", "yt"]).optional(),
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  pt: z.string(),
  yt: z.string().nullable(),
  market: z.string().nullable(),
  receiver: z.string().nullable(),
  expiry: z.string().nullable(),
  liquidityUsd: z.number().nullable(),
  priceImpact: z.number().nullable(),
});

export interface ExtractedPendleQuote {
  readonly action: "swap" | "redeem";
  readonly direction: "buy" | "sell" | "redeem";
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly ptAddress: string;
  readonly ytAddress: string | null;
  readonly marketAddress: string | null;
  readonly receiver: string | null;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Pendle quote (`pendle.pt.quote`). Returns null when the
 * result payload does not structurally validate. The verdict + bounded
 * `safetyDetail` (incl. the buy `termLock`) are computed here so the recorder
 * persists a structural-only preview. Exported for focused unit tests.
 */
export function extractPendleQuote(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedPendleQuote | null {
  const parsed = PendleQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippageBps = typeof params.slippageBps === "number" ? params.slippageBps : null;
  const d = parsed.data;

  const legs: LegVerdict[] = [];
  const safetyDetail: Record<string, unknown> = {};

  // Liquidity floor.
  if (d.liquidityUsd === null) {
    legs.push("unknown");
    safetyDetail.liquidity = { checked: false };
  } else {
    const ok = d.liquidityUsd >= PENDLE_LIQUIDITY_FLOOR_USD;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.liquidity = { checked: true, usd: d.liquidityUsd, aboveFloor: ok };
  }

  // Price-impact magnitude (sign unreliable).
  if (d.priceImpact === null) {
    legs.push("unknown");
    safetyDetail.priceImpact = { checked: false };
  } else {
    const mag = Math.abs(d.priceImpact);
    const ok = mag <= PENDLE_IMPACT_WARN;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.priceImpact = { checked: true, magnitude: mag, high: mag > PENDLE_IMPACT_HIGH };
  }

  // Expiry sanity + term-lock (buy only).
  const expiryMs = d.expiry ? Date.parse(d.expiry) : NaN;
  if (d.direction === "buy") {
    if (!Number.isFinite(expiryMs)) {
      legs.push("unknown");
      safetyDetail.expiry = { checked: false };
    } else if (expiryMs <= Date.now()) {
      legs.push("fail");
      safetyDetail.expiry = { checked: true, expired: true };
    } else {
      legs.push("pass");
      safetyDetail.expiry = { checked: true, expired: false };
      // Typed, unspoofable term-lock — the approval preview renders the fixed
      // message from `maturityIso` (never from model args). ONLY for a PT (a
      // committed term): a YT decays to zero rather than locking, so it carries
      // no term-lock and the preview shows no "locked until maturity" message.
      if (d.instrument !== "yt") {
        safetyDetail.termLock = { maturityIso: new Date(expiryMs).toISOString() };
      }
    }
  }

  return {
    action: d.action,
    direction: d.direction,
    chainId: d.chainId,
    tokenIn: d.tokenIn.address,
    tokenOut: d.tokenOut.address,
    ptAddress: d.pt,
    ytAddress: d.yt,
    marketAddress: d.market,
    receiver: d.receiver,
    amount: amountRaw,
    slippageBps,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}

// ── Pendle PY quote result (pendle.py.quote) — mint / pre-expiry redeem (P4) ─────
//
// A PY quote previews a mint (token → PT+YT) or a pre-expiry redeem (PT+YT →
// token). The verdict reuses the PT market-quality signals: liquidity floor +
// price-impact magnitude. A MINT also enforces expiry sanity (you cannot mint
// into an expired market) and emits `termLock { maturityIso }` — the minted PT is
// a committed term. A pre-expiry redeem is an EXIT, so it carries no term-lock and
// no expiry gate.

const PendlePyQuoteResultSchema = z.object({
  direction: z.enum(["mint", "redeem"]),
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  pt: z.string(),
  yt: z.string().nullable(),
  market: z.string().nullable(),
  expiry: z.string().nullable(),
  liquidityUsd: z.number().nullable(),
  priceImpact: z.number().nullable(),
});

export interface ExtractedPendlePyQuote {
  readonly direction: "mint" | "redeem";
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly ptAddress: string;
  readonly ytAddress: string | null;
  readonly marketAddress: string | null;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Pendle PY quote (`pendle.py.quote`). Returns null when the
 * result payload does not structurally validate. Exported for focused unit tests.
 */
export function extractPendlePyQuote(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedPendlePyQuote | null {
  const parsed = PendlePyQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippageBps = typeof params.slippageBps === "number" ? params.slippageBps : null;
  const d = parsed.data;

  const legs: LegVerdict[] = [];
  const safetyDetail: Record<string, unknown> = {};

  // Liquidity floor.
  if (d.liquidityUsd === null) {
    legs.push("unknown");
    safetyDetail.liquidity = { checked: false };
  } else {
    const ok = d.liquidityUsd >= PENDLE_LIQUIDITY_FLOOR_USD;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.liquidity = { checked: true, usd: d.liquidityUsd, aboveFloor: ok };
  }

  // Price-impact magnitude (sign unreliable).
  if (d.priceImpact === null) {
    legs.push("unknown");
    safetyDetail.priceImpact = { checked: false };
  } else {
    const mag = Math.abs(d.priceImpact);
    const ok = mag <= PENDLE_IMPACT_WARN;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.priceImpact = { checked: true, magnitude: mag, high: mag > PENDLE_IMPACT_HIGH };
  }

  // Expiry sanity + term-lock — MINT only (a redeem is an exit).
  if (d.direction === "mint") {
    const expiryMs = d.expiry ? Date.parse(d.expiry) : NaN;
    if (!Number.isFinite(expiryMs)) {
      legs.push("unknown");
      safetyDetail.expiry = { checked: false };
    } else if (expiryMs <= Date.now()) {
      legs.push("fail");
      safetyDetail.expiry = { checked: true, expired: true };
    } else {
      legs.push("pass");
      safetyDetail.expiry = { checked: true, expired: false };
      // The minted PT commits funds until maturity — surface the typed,
      // unspoofable term-lock to the approval preview.
      safetyDetail.termLock = { maturityIso: new Date(expiryMs).toISOString() };
    }
  }

  return {
    direction: d.direction,
    chainId: d.chainId,
    tokenIn: d.tokenIn.address,
    tokenOut: d.tokenOut.address,
    ptAddress: d.pt,
    ytAddress: d.yt,
    marketAddress: d.market,
    amount: amountRaw,
    slippageBps,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}

// ── Pendle LP quote result (pendle.lp.quote) — single-token add / remove (P5) ────
//
// An LP quote previews adding single-token liquidity (token → LP) or removing it
// (LP → token). The verdict reuses the PT market-quality signals: liquidity floor
// + price-impact magnitude. LP is NOT a fixed-rate term commitment, so there is NO
// term-lock on either direction. The market EXPIRES, though: after expiry LP still
// removes (principal side) but stops earning swap fees/rewards — so the bounded
// `safetyDetail` DISCLOSES expiry/matured state (informational; never a hard fail).

const PendleLpQuoteResultSchema = z.object({
  direction: z.enum(["add", "remove"]),
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  market: z.string(),
  expiry: z.string().nullable(),
  liquidityUsd: z.number().nullable(),
  priceImpact: z.number().nullable(),
});

export interface ExtractedPendleLpQuote {
  readonly direction: "add" | "remove";
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly market: string;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Pendle LP quote (`pendle.lp.quote`). Returns null when the
 * result payload does not structurally validate. Exported for focused unit tests.
 */
export function extractPendleLpQuote(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedPendleLpQuote | null {
  const parsed = PendleLpQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippageBps = typeof params.slippageBps === "number" ? params.slippageBps : null;
  const d = parsed.data;

  const legs: LegVerdict[] = [];
  const safetyDetail: Record<string, unknown> = {};

  // Liquidity floor.
  if (d.liquidityUsd === null) {
    legs.push("unknown");
    safetyDetail.liquidity = { checked: false };
  } else {
    const ok = d.liquidityUsd >= PENDLE_LIQUIDITY_FLOOR_USD;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.liquidity = { checked: true, usd: d.liquidityUsd, aboveFloor: ok };
  }

  // Price-impact magnitude (sign unreliable).
  if (d.priceImpact === null) {
    legs.push("unknown");
    safetyDetail.priceImpact = { checked: false };
  } else {
    const mag = Math.abs(d.priceImpact);
    const ok = mag <= PENDLE_IMPACT_WARN;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.priceImpact = { checked: true, magnitude: mag, high: mag > PENDLE_IMPACT_HIGH };
  }

  // Expiry disclosure — informational (NOT a term-lock, NOT a hard fail). A
  // matured market can still be removed but no longer earns fees/rewards.
  const expiryMs = d.expiry ? Date.parse(d.expiry) : NaN;
  if (Number.isFinite(expiryMs)) {
    safetyDetail.expiry = {
      checked: true,
      maturityIso: new Date(expiryMs).toISOString(),
      matured: expiryMs <= Date.now(),
    };
  } else {
    safetyDetail.expiry = { checked: false };
  }

  return {
    direction: d.direction,
    chainId: d.chainId,
    tokenIn: d.tokenIn.address,
    tokenOut: d.tokenOut.address,
    market: d.market,
    amount: amountRaw,
    slippageBps,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}

/**
 * Validate + extract the prequote fields for a quote tool. Returns `null` when
 * the result payload does not structurally validate (recording is then
 * skipped). Exported for focused unit tests.
 */
export function extractQuote(
  toolId: string,
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  if (toolId === "kyberswap.swap.quote") return extractEvm(params, data);
  if (toolId === "uniswap.swap.quote") return extractUniswap(params, data);
  if (toolId === "solana.swap.quote") return extractSolana(params, data);
  return null;
}
