/**
 * What the BLUE MARKET legs share, and the request that starts one.
 *
 * The market sibling of the context in `./run.ts`, and the same discipline: it
 * carries exactly what a later leg needs from an earlier one and nothing else.
 * It satisfies `MorphoAllowanceContext` structurally, so the approval legs are
 * the SAME code the vault lane runs.
 *
 * `rebuild` is a closure rather than a set of ingredients on purpose. Phase 2
 * must rebuild the transaction against freshly accrued state, and the four
 * operations build in two entirely different ways: two through the SDK and
 * Bundler3, two as direct Morpho Blue calls. Handing the leg a function it can
 * call keeps that dispatch in ONE place, `./market-run.ts`, instead of making
 * every consumer of this context re-derive which shape it is holding.
 */

import type { Address, Hex } from "viem";

import type { MorphoBlueMarketState, MorphoBorrowIntent, MorphoBorrowLeg } from "@tools/morpho/mutations.js";

import type { MorphoAllowanceContext } from "./allowance-context.js";

export interface MorphoMarketExecutionRequest {
  readonly toolId: string;
  readonly sessionId: string;
  /** Raw handler params. Sanitized where the intent is built, not here. */
  readonly intentParams: Record<string, unknown>;
  /** The wallet that signs. Must be the wallet client's own account AND `onBehalf`. */
  readonly walletAddress: Address;
  /** Price protection for a repayment, resolved by the handler from the slippage policy. */
  readonly slippageBps: number;
}

export interface MorphoMarketExecutionContext extends MorphoAllowanceContext {
  readonly request: MorphoMarketExecutionRequest;
  readonly intent: MorphoBorrowIntent;
  readonly market: MorphoBlueMarketState;
  /** The engine's resolved leg: the token, its OWN decimals, and the amount. */
  readonly leg: MorphoBorrowLeg;
  /**
   * The chain's Morpho Blue CORE deployment, which EMITS the four market events.
   * NOT the transaction target: a supply or repay targets Bundler3 instead.
   */
  readonly blueAddress: Address;
  /** The target the decoder accepted, which phase 2's rebuild is held to. */
  readonly verifiedTarget: Address;
  /**
   * Rebuild against CURRENT state and re-verify the bytes. Throws to refuse,
   * pre-signature. Async because the bundled shapes re-read the position and
   * re-derive their price ceiling from it.
   */
  readonly rebuild: () => Promise<{
    to: Address;
    data: Hex;
    value: bigint;
    /** What the rebuilt bytes would pull, or `null` when they pull nothing. */
    pullAmountRaw: bigint | null;
  }>;
}
