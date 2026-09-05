/**
 * Cross-chain bridge identity family (Stage 8c + the Wave-2 venue/slippage tail).
 */

import type { PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Canonical bridge trade direction. `EXACT_INPUT`/`EXACT_OUTPUT` mirror
 * `parseTradeType` in khalani/request; `EXPECTED_OUTPUT` is a DISTINCT Relay
 * value (Wave-2 W2, R10) - Relay's recommended plain-bridge mode. Bound verbatim
 * into `bridgeHashMaterial`, so an `EXPECTED_OUTPUT` quote↔execute produces a
 * digest distinct from `EXACT_INPUT` (no longer collapsed). Widening this union
 * is additive: Khalani's `parseBridgeTradeType` still returns only the first two.
 */
export type BridgeTradeType = "EXACT_INPUT" | "EXACT_OUTPUT" | "EXPECTED_OUTPUT";

/**
 * Cross-chain bridge trade identity (Stage 8c). Computed IDENTICALLY at bridge
 * QUOTE record-time (`khalani.quote.get`) and bridge EXECUTE gate-time
 * (`khalani.bridge`) - both go through the SAME shared builder
 * (`buildBridgeIdentity`) so the digests collide. Chain IDs are normalized to
 * numeric Khalani chain IDs; addresses/tokens are canonicalized per the SOURCE
 * (from*) or DEST (to*) family; `recipient`/`tradeType` carry the bridge
 * handler's defaults.
 *
 * The money/fee leg (`refundTo`/`referrer`/`referrerFeeBps`/`filler`) is bound
 * too (8c security fix): each flows into the Khalani quote request in BOTH the
 * quote (`prepareQuoteRequest`) and the execute (`khalani.bridge`), so leaving
 * any of them out of the identity would let a quote authorize an execute that
 * changes where funds refund / who collects the fee. They carry the SAME
 * defaults `prepareQuoteRequest` applies (see `buildBridgeIdentity`); an omitted
 * field canonicalizes to a STABLE empty token so quote↔execute still collide
 * when both omit it.
 */
export interface BridgeMatchInput {
  readonly kind: "bridge";
  readonly sessionId: string;
  /**
   * VENUE binding (LOCKED Wave-2 correction #4). The bridge provider (e.g.
   * "khalani" | "relay") is bound into the hash so a Khalani quote can never
   * authorize a Relay execute for the same route (and vice-versa). Relay gets
   * its OWN bridge identity path - it does NOT reuse Khalani's.
   */
  readonly provider: string;
  /** Family of the SOURCE chain (where the deposit signs). Canonicalizes from*. */
  readonly sourceFamily: PrequoteFamily;
  /** Family of the DEST chain (where funds land). Canonicalizes the dest leg. */
  readonly destFamily: PrequoteFamily;
  readonly fromChainId: number;
  readonly toChainId: number;
  /** Selected source-family wallet address (the signer). */
  readonly sourceWallet: string;
  /** Destination recipient (defaulted to the dest-family selected wallet). */
  readonly recipient: string;
  readonly fromToken: string;
  readonly toToken: string;
  /** Amount in smallest units (wei/lamports) - bridge amounts are integers. */
  readonly amount: string;
  readonly tradeType: BridgeTradeType;
  /**
   * Refund address - a SOURCE-chain address (canonicalized under the source
   * family). Defaults to `sourceWallet` (mirrors `prepareQuoteRequest`, where an
   * omitted `refundTo` falls back to the resolved `fromAddress`).
   */
  readonly refundTo: string;
  /** EVM referrer address for fee sharing; "" when omitted. */
  readonly referrer: string;
  /** Referrer fee in basis points (canonical integer string 0-9999); "" when omitted. */
  readonly referrerFeeBps: string;
  /** Opaque Khalani filler-provider name (case-preserved, NOT an address); "" when omitted. */
  readonly filler: string;
  /**
   * Bridge slippage tolerance (canonical integer bps string); "" when the
   * provider has no slippage surface or the caller omitted it.
   *
   * Bound for the SAME reason every other identity binds it, and it was the one
   * place the doctrine had not been applied: `relay.bridge` forwards
   * `slippageBps` to Relay as `slippageTolerance`, so without this a 50 bps
   * `relay.quote.get` and a 5000 bps `relay.bridge` produced the SAME digest and
   * the gate allowed the pair. Khalani has no slippage param and passes the
   * stable "" on both sides, so its quote↔execute pairs still collide.
   */
  readonly slippageBps: string;
}

export function bridgeHashMaterial(input: BridgeMatchInput): string {
  // Source-side fields canonicalize under the SOURCE family; destination-side
  // fields under the DEST family (a Solana mint on the dest leg must keep its
  // case even when the source leg is EVM, and vice-versa). The shared builder
  // passes RAW values + both leg families; the hash owns canonicalization (same
  // ownership split as the swap path).
  return [
    input.kind,
    input.sessionId,
    input.sourceFamily,
    input.destFamily,
    String(input.fromChainId),
    String(input.toChainId),
    canonAddress(input.sourceFamily, input.sourceWallet),
    canonAddress(input.destFamily, input.recipient),
    canonAddress(input.sourceFamily, input.fromToken),
    canonAddress(input.destFamily, input.toToken),
    canonAmount(input.amount),
    input.tradeType,
    // Money/fee tail (8c) - FIXED order: refundTo, referrer, referrerFeeBps,
    // filler. `refundTo` is a SOURCE-chain address (source-family canonical);
    // `referrer` is an EVM address (lowercase); `referrerFeeBps` is already the
    // canonical integer string from the builder; `filler` is an OPAQUE provider
    // name (case-preserved, trim-only - NOT an address, per Khalani docs). Each
    // is "" when omitted/defaulted so an all-omitting quote↔execute collide.
    canonAddress(input.sourceFamily, input.refundTo),
    input.referrer === "" ? "" : canonAddress("eip155", input.referrer),
    input.referrerFeeBps,
    input.filler.trim(),
    // Wave-2c venue binding (LOCKED #4): the bridge provider/venue, so a khalani
    // quote and a relay quote for the same route hash differently.
    input.provider.trim().toLowerCase(),
    // Slippage tail: appended LAST so the field order of every pre-existing
    // material element is untouched. "" for a provider without a slippage
    // surface (khalani) and for an omitted relay slippage, so those
    // quote↔execute pairs still collide; a divergent relay slippage blocks.
    input.slippageBps,
  ].join(" ");
}
