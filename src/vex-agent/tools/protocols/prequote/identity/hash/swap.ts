/**
 * Swap identity family (Stage 6c/7/9 + the W5 Jupiter fee tail).
 */

import type { PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Swap trade identity (Stage 6c/7). `kind: "swap"` is the discriminant tag -
 * Stage 8c made `PrequoteMatchInput` a union so a swap identity and a bridge
 * identity with otherwise-similar values can never collide in the hash.
 *
 * The execute-only money/safety leg (`recipient`/`approveExact`/`slippageBps`)
 * is bound too (Stage 9 security fix). `recipient` (where the output lands) and
 * `approveExact` (allowance behavior) are EVM-execute-only - the swap QUOTE has
 * no such params - so the recorder DEFAULTS them to the executor's omitted-value
 * defaults (recipient → the resolved selected wallet, i.e. output-to-self;
 * approveExact → false). A quote then authorizes an execute ONLY when the
 * execute uses those same defaulted values; an execute that SETS a different
 * recipient/approveExact produces a different digest → the gate blocks. Solana
 * has neither concept (recipient=self, approveExact=false are constants there),
 * so they never affect Solana matching - uniform and inert. `slippageBps` IS in
 * both the quote and the execute params (both families), so binding it stops a
 * 50bps quote from authorizing a 10000bps execute.
 */
export interface SwapMatchInput {
  readonly kind: "swap";
  readonly sessionId: string;
  readonly family: PrequoteFamily;
  /**
   * VENUE binding (LOCKED Wave-2 correction #4). The quoting venue/provider
   * (e.g. "kyberswap" | "uniswap" | "jupiter") is bound into the hash so a
   * KyberSwap quote can NEVER authorize a Uniswap execute for the same
   * tokens/amount (and vice-versa). Unlike Solana, an EVM `provider` does NOT
   * derive from `family` (kyber and uniswap are both eip155), so it must be an
   * explicit identity dimension. The recorder pins it from the quote-tool
   * registration; the gate pins it from the execute-tool registration.
   */
  readonly provider: string;
  /** EVM numeric chainId; null/undefined for Solana (single chain in scope). */
  readonly chainId: number | null | undefined;
  readonly walletAddress: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  /** Human decimal amount the quote was computed for. */
  readonly amount: string;
  /**
   * Output recipient. Defaulted to the resolved selected wallet (output-to-self)
   * when the execute omits it - mirrors `executeKyberSwap`'s
   * `str(p,"recipient") || signer.address`. Canonicalized per family (EVM
   * lowercase / Solana case-preserve). Solana = the selected wallet (constant).
   */
  readonly recipient: string;
  /**
   * Token-allowance behavior (EVM). `true` iff the execute set `approveExact`;
   * the executor's default when omitted is `false`. Canonicalized to "1"/"0" in
   * the hash. Solana = false (constant - no allowance concept).
   */
  readonly approveExact: boolean;
  /**
   * Slippage tolerance in basis points, taken from the QUOTE params (recorder)
   * and the EXECUTE params (gate). A number canonicalizes to its integer string;
   * omitted/null → the stable sentinel "" so a quote-omitted and an
   * execute-omitted slippage collide, while a 50bps quote and a 10000bps execute
   * diverge → block.
   */
  readonly slippageBps: string;
  /**
   * Jupiter fee-bearing `/build` tail (W5 design §6 R4: "prequote identity
   * hash extended with: feeBps, feeMint, tip, CU strategy, dexes,
   * maxAccounts, wrap"). ALL FIVE are `undefined` (→ "" in the hash material)
   * for every non-Jupiter swap (kyberswap/uniswap/pendle) - their
   * quote↔execute pairs still collide unchanged, since both sides omit them
   * identically. Only `solana.swap.quote`/`solana.swap.execute` (provider
   * "jupiter") populate real values, via
   * `fee-swap.ts`'s `canonicalizeJupiterFeeTail` on BOTH the recorder and the
   * gate, so a fee/tip/DEX-filter/maxAccounts/wrap substitution between quote
   * and execute produces a different digest → BLOCK. `routeKnobs` bundles
   * dexes/excludeDexes/maxAccounts/wrap/forJitoBundle into one canonical
   * string (see `canonicalizeJupiterFeeTail`) rather than five separate
   * fields.
   */
  readonly feeBps?: string;
  readonly feeMint?: string;
  readonly tipLamports?: string;
  readonly cuStrategy?: string;
  readonly routeKnobs?: string;
}

export function swapHashMaterial(input: SwapMatchInput): string {
  const chainIdOrEmpty =
    input.family === "eip155" && input.chainId != null ? String(input.chainId) : "";
  return [
    input.kind,
    input.sessionId,
    input.family,
    chainIdOrEmpty,
    canonAddress(input.family, input.walletAddress),
    canonAddress(input.family, input.tokenIn),
    canonAddress(input.family, input.tokenOut),
    canonAmount(input.amount),
    // Stage 9 tail (FIXED order): recipient (family-canonical address),
    // approveExact (stable "1"/"0"), slippageBps (integer string or "").
    canonAddress(input.family, input.recipient),
    input.approveExact ? "1" : "0",
    input.slippageBps,
    // Wave-2c venue binding (LOCKED #4): the quoting provider/venue, so a
    // kyber quote and a uniswap quote for the same identity hash differently.
    input.provider.trim().toLowerCase(),
    // W5 (design §6 R4) Jupiter fee-bearing tail - "" for every non-Jupiter
    // swap (both sides omit it identically, so their collision is unaffected).
    input.feeBps ?? "",
    input.feeMint ?? "",
    input.tipLamports ?? "",
    input.cuStrategy ?? "",
    input.routeKnobs ?? "",
  ].join(" ");
}
