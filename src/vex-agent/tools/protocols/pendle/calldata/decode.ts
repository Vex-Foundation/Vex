/**
 * Pendle Router calldata DECODING — the lowest layer of the broadcast
 * fund-safety extractor.
 *
 * Extracted from `../calldata.ts` (R5a) so that decoding, route binding, claim
 * binding, and the price floor each have one reason to change. `../calldata.ts`
 * remains the public barrel; every consumer import is unchanged.
 *
 * This module answers exactly one question: "what does this calldata actually
 * say?" It performs a FULL `decodeFunctionData` against the complete Router ABI
 * and returns normalized, intent-relevant params. It does NOT know what the
 * caller intended — that is `./bind-route.ts` — and it does NOT know what a fair
 * price is — that is `./price-floor.ts`.
 *
 * Two invariants ARE asserted here, because they are properties of the calldata
 * itself rather than of any intent:
 *   - the `limit` tuple carries no maker-order fills (the convert body always
 *     sends `useLimitOrder: false`);
 *   - `TokenInput.pendleSwap` / `TokenOutput.pendleSwap` is a helper we
 *     recognise (see {@link assertKnownPendleSwap}).
 */

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import {
  PENDLE_NATIVE_TOKEN,
  PENDLE_REFLECT_ABI,
  PENDLE_ROUTER_ABI,
  PENDLE_SWAP_HELPER,
  type PendleRouterMethod,
} from "@tools/pendle/constants.js";

// ── Refusal vocabulary (shared by every binding module) ──────────────

/**
 * Refuse to sign. The message is OUR fixed text — an upstream body never
 * reaches the model through this path.
 */
export function unsafe(reason: string): never {
  throw new VexError(
    ErrorCodes.PENDLE_UNSAFE_TX,
    `Pendle refused to sign: ${reason}.`,
    "The quoted transaction did not match the requested trade. Re-quote and retry; do not approve.",
  );
}

/** Try to checksum an address; unsafe() on a malformed value. */
export function requireAddress(value: string, label: string): Address {
  try {
    return getAddress(value);
  } catch {
    return unsafe(`${label} is not a valid address`);
  }
}

// ── Full calldata decode ────────────────────────────────────────────

export interface TokenTupleBind {
  /** TokenInput.tokenIn or TokenOutput.tokenOut. */
  token: Address;
}

export interface DecodedRouterCall {
  method: PendleRouterMethod;
  /** Where the proceeds land (arg 0 on every allowed method). */
  receiver: Address;
  /**
   * Arg 1 on every allowed method: the MARKET (swaps, LP add/remove), the YT
   * (PY mint/redeem) or — since R5d — the SY CONTRACT (`mintSyFromToken` /
   * `redeemSyToToken`, which have no market and no maturity). The caller knows
   * which of the three its action expects and binds accordingly; this layer only
   * reports what arg 1 says.
   */
  marketOrYt: Address;
  /**
   * The ACTUAL spend amount the Router will pull: TokenInput.netTokenIn (buy),
   * exactPtIn/exactYtIn (sell), netPyIn (redeem), netLpToRemove (LP remove).
   */
  spendWei: bigint;
  /** Buy / mint / LP-add: the decoded TokenInput.tokenIn (zero address for native). */
  input?: TokenTupleBind;
  /** Sell / redeemPyToToken / LP-remove: the decoded TokenOutput.tokenOut. */
  output?: TokenTupleBind;
  /**
   * The DECODED argument list, exactly as the ABI produced it.
   *
   * Deliberately `unknown[]`: this is an external-boundary value, and the one
   * consumer that reads positionally — the per-selector min-out binding table in
   * `./price-floor.ts` — narrows each field with an explicit runtime check and
   * refuses anything unexpected. Handing out a pre-cast shape here would move
   * that check somewhere it can be forgotten.
   */
  args: readonly unknown[];
}

/**
 * The convert body always sends `useLimitOrder: false`, so a route's decoded
 * `limit` tuple must carry ZERO fills — injected maker-order fills would change
 * the tx/approval semantics behind the quote.
 */
function assertNoLimitFills(args: readonly unknown[], index: number): void {
  const limit = args[index] as { normalFills: readonly unknown[]; flashFills: readonly unknown[] };
  if (limit.normalFills.length !== 0 || limit.flashFills.length !== 0) {
    unsafe("route carries limit-order fills — useLimitOrder is disabled");
  }
}

/**
 * Pin the helper contract a TokenInput/TokenOutput hands the external swap to.
 *
 * CLAIM-PATH PARITY (G-19 / P1-9). `decodeClaimCall` has pinned the claim's
 * `pendleSwap` since the original binding; the swap path pinned nothing, so a
 * route could name an arbitrary helper. LIVE-MEASURED 2026-07-27 across seven
 * aggregator-engaged chain-1 routes (three KyberSwap, four OKX): `pendleSwap`
 * was `0xd4F480965D2347d421F1bEC7F545682E5Ec2151D` — {@link PENDLE_SWAP_HELPER},
 * the exact constant the claim path already pins — on EVERY one, while
 * `swapData.extRouter` varied by aggregator (KyberSwap
 * `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`, OKX
 * `0x28b1Dc1a5E3699A428BC51d234DFab7C9CB2a183`). Pure-Pendle routes carry the
 * zero address.
 *
 * `extRouter` is deliberately NOT pinned: it is a per-aggregator address with no
 * stable set we have measured, and P1-9's own judgement is that binding the
 * min-out (`./price-floor.ts`) closes the composition without it. Named as a
 * residual, not silently skipped.
 */
function assertKnownPendleSwap(value: unknown, label: string): void {
  if (typeof value !== "string") return unsafe(`${label} does not carry a pendleSwap address`);
  const helper = requireAddress(value, `${label} pendleSwap`);
  if (helper !== PENDLE_NATIVE_TOKEN && helper !== PENDLE_SWAP_HELPER) {
    unsafe(`${label} routes through an unverified pendleSwap helper`);
  }
}

/**
 * FULL-decode a Pendle Router call. An unknown selector, a truncated body, or a
 * layout that does not decode against the complete ABI → unsafe. Returns the
 * normalized intent-relevant params. (ABI selectors are pinned by tests that
 * decode LIVE-probed calldata.)
 */
export function decodeRouterCall(data: string): DecodedRouterCall {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(data)) {
    return unsafe("transaction calldata is malformed");
  }
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex }) as {
      functionName: string;
      args: readonly unknown[];
    };
  } catch {
    return unsafe("transaction does not decode as a known Router method");
  }
  const args = decoded.args;
  const receiver = getAddress(args[0] as string);
  const marketOrYt = getAddress(args[1] as string);

  switch (decoded.functionName) {
    case "swapExactTokenForPt":
    case "swapExactTokenForYt": {
      // Both carry the TokenInput at arg 4 with the same layout — bind the
      // actual netTokenIn spend + the input token.
      assertNoLimitFills(args, 5);
      const input = args[4] as { tokenIn: string; netTokenIn: bigint; pendleSwap: string };
      assertKnownPendleSwap(input.pendleSwap, "the route's input leg");
      return {
        method: decoded.functionName as PendleRouterMethod,
        receiver,
        marketOrYt,
        spendWei: input.netTokenIn,
        input: { token: getAddress(input.tokenIn) },
        args,
      };
    }
    case "swapExactPtForToken":
    case "swapExactYtForToken": {
      // Both carry exactPtIn/exactYtIn at arg 2 and the TokenOutput at arg 3.
      assertNoLimitFills(args, 4);
      const output = args[3] as { tokenOut: string; pendleSwap: string };
      assertKnownPendleSwap(output.pendleSwap, "the route's output leg");
      return {
        method: decoded.functionName as PendleRouterMethod,
        receiver,
        marketOrYt,
        spendWei: args[2] as bigint,
        output: { token: getAddress(output.tokenOut) },
        args,
      };
    }
    case "mintPyFromToken": {
      // mintPyFromToken(receiver, YT, minPyOut, TokenInput) — the TokenInput is at
      // arg 3 (no ApproxParams/guess tuple), and arg 1 is the YT. Bind the actual
      // netTokenIn spend + the input token, like the token→PT/YT buys.
      const input = args[3] as { tokenIn: string; netTokenIn: bigint; pendleSwap: string };
      assertKnownPendleSwap(input.pendleSwap, "the mint's input leg");
      return {
        method: "mintPyFromToken",
        receiver,
        marketOrYt,
        spendWei: input.netTokenIn,
        input: { token: getAddress(input.tokenIn) },
        args,
      };
    }
    case "redeemPyToToken": {
      const output = args[3] as { tokenOut: string; pendleSwap: string };
      assertKnownPendleSwap(output.pendleSwap, "the redeem's output leg");
      return {
        method: "redeemPyToToken",
        receiver,
        marketOrYt,
        spendWei: args[2] as bigint,
        output: { token: getAddress(output.tokenOut) },
        args,
      };
    }
    case "redeemPyToSy":
      // No TokenOutput tuple: the proceeds are SY, so there is no external swap
      // leg and no pendleSwap to pin. minSyOut (arg 3) is bound by the floor.
      return {
        method: "redeemPyToSy",
        receiver,
        marketOrYt,
        spendWei: args[2] as bigint,
        args,
      };
    case "addLiquiditySingleToken": {
      // addLiquiditySingleToken(receiver, market, minLpOut, guessPtReceivedFromSy,
      // input(TokenInput), limit) — the TokenInput is at arg 4 (after the
      // ApproxParams guess tuple). arg1 is the MARKET (== the LP token).
      assertNoLimitFills(args, 5);
      const input = args[4] as { tokenIn: string; netTokenIn: bigint; pendleSwap: string };
      assertKnownPendleSwap(input.pendleSwap, "the LP add's input leg");
      return {
        method: "addLiquiditySingleToken",
        receiver,
        marketOrYt,
        spendWei: input.netTokenIn,
        input: { token: getAddress(input.tokenIn) },
        args,
      };
    }
    case "removeLiquiditySingleToken": {
      // removeLiquiditySingleToken(receiver, market, netLpToRemove, output(TokenOutput),
      // limit) — arg2 is the ACTUAL LP burned and the TokenOutput at arg 3 carries
      // the quoted output token; arg1 is the MARKET (the LP being redeemed).
      assertNoLimitFills(args, 4);
      const output = args[3] as { tokenOut: string; pendleSwap: string };
      assertKnownPendleSwap(output.pendleSwap, "the LP remove's output leg");
      return {
        method: "removeLiquiditySingleToken",
        receiver,
        marketOrYt,
        spendWei: args[2] as bigint,
        output: { token: getAddress(output.tokenOut) },
        args,
      };
    }
    // ── R5d: SY wrap / unwrap ──────────────────────────────────────
    case "mintSyFromToken": {
      // mintSyFromToken(receiver, SY, minSyOut, TokenInput) — arg1 is the SY
      // CONTRACT, not a market or a YT. There is no `limit` tuple to check.
      const input = args[3] as { tokenIn: string; netTokenIn: bigint; pendleSwap: string };
      assertKnownPendleSwap(input.pendleSwap, "the SY mint's input leg");
      return {
        method: "mintSyFromToken",
        receiver,
        marketOrYt,
        spendWei: input.netTokenIn,
        input: { token: getAddress(input.tokenIn) },
        args,
      };
    }
    case "redeemSyToToken": {
      // redeemSyToToken(receiver, SY, netSyIn, TokenOutput) — arg1 is the SY,
      // arg2 the ACTUAL SY burned. No `limit` tuple.
      const output = args[3] as { tokenOut: string; pendleSwap: string };
      assertKnownPendleSwap(output.pendleSwap, "the SY redeem's output leg");
      return {
        method: "redeemSyToToken",
        receiver,
        marketOrYt,
        spendWei: args[2] as bigint,
        output: { token: getAddress(output.tokenOut) },
        args,
      };
    }
    // ── R5d: dual / keep-YT liquidity ──────────────────────────────
    case "removeLiquidityDualTokenAndPt": {
      // removeLiquidityDualTokenAndPt(receiver, market, netLpToRemove,
      // output(TokenOutput), minPtOut) — arg2 is the ACTUAL LP burned. The PT leg
      // has NO token field in the calldata; the floor binding resolves it as the
      // route output that is not the TokenOutput's token. No `limit` tuple.
      const output = args[3] as { tokenOut: string; pendleSwap: string };
      assertKnownPendleSwap(output.pendleSwap, "the dual LP remove's output leg");
      return {
        method: "removeLiquidityDualTokenAndPt",
        receiver,
        marketOrYt,
        spendWei: args[2] as bigint,
        output: { token: getAddress(output.tokenOut) },
        args,
      };
    }
    case "addLiquiditySingleTokenKeepYt": {
      // addLiquiditySingleTokenKeepYt(receiver, market, minLpOut, minYtOut,
      // input(TokenInput)) — the TokenInput is at arg 4 (two bare minimums
      // precede it, where the plain single-token add has one min + a guess
      // tuple). No `limit` tuple.
      const input = args[4] as { tokenIn: string; netTokenIn: bigint; pendleSwap: string };
      assertKnownPendleSwap(input.pendleSwap, "the keep-YT LP add's input leg");
      return {
        method: "addLiquiditySingleTokenKeepYt",
        receiver,
        marketOrYt,
        spendWei: input.netTokenIn,
        input: { token: getAddress(input.tokenIn) },
        args,
      };
    }
    case "removeLiquiditySinglePt": {
      // removeLiquiditySinglePt(receiver, market, netLpToRemove, minPtOut,
      // guessPtReceivedFromSy, limit) — the proceeds are PT, so there is no
      // TokenOutput tuple and no pendleSwap to pin. `limit` is at arg 5.
      assertNoLimitFills(args, 5);
      return {
        method: "removeLiquiditySinglePt",
        receiver,
        marketOrYt,
        spendWei: args[2] as bigint,
        args,
      };
    }
    // ── R5d: callAndReflect inner legs ─────────────────────────────
    // Each is reached ONLY through `decodeReflectCall`'s recursion, but it is
    // decoded here, by the same allowlist, so an inner leg can never be read by a
    // weaker decoder than an outer call. None carries a TokenInput/TokenOutput:
    // every one moves PT/SY/LP, which are protocol tokens, not swap legs — so
    // there is no pendleSwap to pin on any of them.
    case "swapExactPtForSy": {
      assertNoLimitFills(args, 4);
      return { method: "swapExactPtForSy", receiver, marketOrYt, spendWei: args[2] as bigint, args };
    }
    case "swapExactSyForPt": {
      assertNoLimitFills(args, 5);
      return { method: "swapExactSyForPt", receiver, marketOrYt, spendWei: args[2] as bigint, args };
    }
    case "removeLiquiditySingleSy": {
      assertNoLimitFills(args, 4);
      return { method: "removeLiquiditySingleSy", receiver, marketOrYt, spendWei: args[2] as bigint, args };
    }
    case "addLiquiditySingleSy": {
      assertNoLimitFills(args, 5);
      return { method: "addLiquiditySingleSy", receiver, marketOrYt, spendWei: args[2] as bigint, args };
    }
    default:
      return unsafe("transaction calls an unknown Router method");
  }
}

// ── callAndReflect: RECURSIVE decode ────────────────────────────────
//
// LIVE-CAPTURED 2026-07-27 (`floor-fixtures.ts` `rollOverPt`, a chain-1
// `roll-over-pt` convert): the Router's `callAndReflect(address reflector,
// bytes selfCall1, bytes selfCall2, bytes reflectCall)` wraps a MULTI-LEG
// action whose legs are themselves Router calls. Leg 1's decoded receiver was
// the REFLECTOR (`0x30544e00cf296b34a9ee59e5540ae2f9cccd55dd`), NOT the wallet
// — the documented exception `./bind-route.ts` enforces — while the final leg's
// receiver was the wallet and its min-out equalled our computed floor EXACTLY.
//
// R5d (2026-07-28) PINNED THE INNER LAYOUTS R5a deferred. Re-probed live and
// confirmed by computing each selector from its derived signature:
//   roll-over-pt       : swapExactPtForSy (0x3346d3a3) → swapExactSyForPt (0x2a50917c)
//   transfer-liquidity : removeLiquiditySingleSy (0xd13b4fdc) → addLiquiditySingleSy (0x58bda475)
// Both pairs are now in `PENDLE_ROUTER_ABI`, so a real reflect body DECODES
// rather than being refused wholesale. Which pair appears depends on whether the
// two markets share an SY; when they do not (the chain-143 capture), the legs are
// the already-pinned `removeLiquiditySingleToken` / `addLiquiditySingleToken`.
//
// `roll-over-pt` and `transfer-liquidity` are the ONLY actions that reach this
// wrapper. `convert-lp-to-pt` does NOT: it live-probed as a plain single-leg
// `removeLiquiditySinglePt`.
//
// The reflector itself is NOT universal — see `PENDLE_REFLECTORS` — so a caller
// must pin the per-chain address before granting the leg-1 receiver exception.

export interface DecodedReflectCall {
  /** The reflector contract leg 1 is allowed to pay out to. */
  reflector: Address;
  /**
   * Every non-empty inner leg, in execution order. Each is decoded through
   * {@link decodeRouterCall}, so an inner selector outside the allowlist is
   * refused by the same code path that refuses an outer one — there is no
   * second, weaker decoder.
   */
  legs: readonly DecodedRouterCall[];
}

/**
 * FULL-decode a `callAndReflect` body and, recursively, each of its inner legs.
 *
 * An empty leg (`0x`) is skipped — the live capture leaves `selfCall2` empty.
 * A body with no decodable leg at all is refused: a reflect call that does
 * nothing we can read is not something to sign.
 */
export function decodeReflectCall(data: string): DecodedReflectCall {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(data)) {
    return unsafe("reflect calldata is malformed");
  }
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: PENDLE_REFLECT_ABI, data: data as Hex }) as {
      functionName: string;
      args: readonly unknown[];
    };
  } catch {
    return unsafe("transaction does not decode as callAndReflect");
  }
  if (decoded.functionName !== "callAndReflect") {
    return unsafe("reflect body calls an unexpected Router method");
  }
  const reflector = requireAddress(decoded.args[0] as string, "reflector");
  const legs: DecodedRouterCall[] = [];
  for (const raw of decoded.args.slice(1)) {
    if (typeof raw !== "string") return unsafe("a reflect leg is not calldata");
    if (raw === "0x" || raw === "") continue;
    legs.push(decodeRouterCall(raw));
  }
  if (legs.length === 0) return unsafe("reflect body carries no decodable leg");
  return { reflector, legs };
}
