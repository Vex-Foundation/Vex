/**
 * Pendle CLAIM (income sweep) fund-safety binding.
 *
 * Extracted from `../calldata.ts` (R5a) - a claim has a different response
 * shape, a different ABI, and different invariants from a Convert route, so it
 * has its own reason to change.
 *
 * `pendle.claim` calls `redeemDueInterestAndRewardsV2` (IPActionMiscV3), whose
 * response is FLAT (no routes[]) and whose calldata has NO `receiver` arg -
 * every output lands on msg.sender by protocol (SOURCE-verified 2026-07-06:
 * pendle-core-v2-public ActionMiscV3.sol:92-130). Execution facts the binding
 * rests on:
 *   - `swaps == []` → the NoSwap path; `pendleSwap` is NEVER used there
 *     (ActionMiscV3.sol:99-103) - still pinned as defense-in-depth.
 *   - Per YT tuple: `yt.redeemDueInterestAndRewards(msg.sender, doRedeemInterest,
 *     doRedeemRewards)`; when interest accrued, the Router `_transferFrom`s the
 *     freshly-redeemed SY from the wallet and calls `SY.redeem(msg.sender, …,
 *     tokenRedeemSy, minTokenRedeemOut, true)` (ActionMiscV3.sol:117-126). So a
 *     REAL claim with accrued interest legitimately requires an EXACT allowance
 *     on the market's own SY (LIVE-verified with populated holder probes), and
 *     `tokenRedeemSy` selects the redemption token.
 * Binding (fail → ZERO approve, ZERO send):
 *   tx.to == Router; tx.from absent-or-wallet; value == 0; `SYs`/`swaps` EMPTY;
 *   `pendleSwap` ∈ {zero, PENDLE_SWAP_HELPER}; every YT tuple: yt ⊆ intended,
 *   NOT a no-op (at least one redeem flag), tokenRedeemSy == the market's
 *   underlyingAsset from OUR chain-scoped lookup (never the response);
 *   `minTokenRedeemOut` is the SDK's slippage PROTECTION on an output that goes
 *   to msg.sender - decoded but not value-bound (forcing 0 would REMOVE the
 *   protection, and unlike a Convert route there is no quoted output amount to
 *   re-derive a floor from); markets ⊆ intended; every approval token must be
 *   the SY of a decoded tuple with doRedeemInterest, amount a positive integer,
 *   no duplicates (granted exactly, Router-pinned, by the handler).
 */

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { PENDLE_CLAIM_ABI, PENDLE_NATIVE_TOKEN, PENDLE_ROUTER, PENDLE_SWAP_HELPER } from "@tools/pendle/constants.js";
import type { PendleClaimResponse } from "@tools/pendle/types.js";

import { requireAddress, unsafe } from "./decode.js";

/** Per-YT bind material resolved from OUR market lookup (lowercase addresses). */
export interface PendleClaimYtBind {
  /** The market's underlyingAsset - the ONLY allowed tokenRedeemSy. */
  readonly tokenRedeemSy: string;
  /** The market's SY - the ONLY token an interest claim may approve. */
  readonly sy: string;
}

export interface PendleClaimIntent {
  /** Session wallet - the only allowed sender (funds land here by protocol). */
  wallet: Address;
  /** Lowercase YT address → its bind material (the wallet's held YT markets). */
  intendedYts: ReadonlyMap<string, PendleClaimYtBind>;
  /** Lowercase market addresses the wallet intends to claim LP rewards from. */
  intendedMarkets: ReadonlySet<string>;
}

/** One decoded RedeemYtIncomeToTokenStruct (IPAllActionTypeV3.sol:134-140). */
export interface DecodedClaimYt {
  yt: Address;
  doRedeemInterest: boolean;
  doRedeemRewards: boolean;
  tokenRedeemSy: Address;
  minTokenRedeemOut: bigint;
}

/** The effective (server-pruned) claim set the Router will actually sweep. */
export interface DecodedClaimCall {
  yts: DecodedClaimYt[];
  markets: Address[];
  pendleSwap: Address;
}

/**
 * FULL-decode a claim call against `PENDLE_CLAIM_ABI`. An unknown selector or a
 * layout that does not decode → unsafe. Asserts the pure-sweep invariants that
 * are NOT position-specific: `SYs` empty, `swaps` empty, `pendleSwap` known.
 * Returns the decoded YT tuples + market list for the position-specific binds.
 */
export function decodeClaimCall(data: string): DecodedClaimCall {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(data)) {
    return unsafe("claim calldata is malformed");
  }
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: PENDLE_CLAIM_ABI, data: data as Hex }) as {
      functionName: string;
      args: readonly unknown[];
    };
  } catch {
    return unsafe("claim does not decode as redeemDueInterestAndRewardsV2");
  }
  if (decoded.functionName !== "redeemDueInterestAndRewardsV2") {
    return unsafe("claim calls an unexpected Router method");
  }
  const sys = decoded.args[0] as readonly string[];
  const ytStructs = decoded.args[1] as readonly {
    yt: string;
    doRedeemInterest: boolean;
    doRedeemRewards: boolean;
    tokenRedeemSy: string;
    minTokenRedeemOut: bigint;
  }[];
  const markets = decoded.args[2] as readonly string[];
  const pendleSwap = getAddress(decoded.args[3] as string);
  const swaps = decoded.args[4] as readonly unknown[];
  // The ONLY external-call/fund-routing surface is `swaps`; a pure claim has none.
  if (swaps.length !== 0) return unsafe("claim carries an external swap - not a pure income sweep");
  // The tool scopes to YT + LP income; a claim must never sweep SY interest.
  if (sys.length !== 0) return unsafe("claim carries an unexpected SY leg");
  // pendleSwap is source-proven inert when swaps == [] - pin it anyway.
  if (pendleSwap !== PENDLE_NATIVE_TOKEN && pendleSwap !== PENDLE_SWAP_HELPER) {
    return unsafe("claim uses an unverified pendleSwap helper");
  }
  return {
    yts: ytStructs.map((s) => ({
      yt: getAddress(s.yt),
      doRedeemInterest: s.doRedeemInterest === true,
      doRedeemRewards: s.doRedeemRewards === true,
      tokenRedeemSy: getAddress(s.tokenRedeemSy),
      minTokenRedeemOut: s.minTokenRedeemOut,
    })),
    markets: markets.map((m) => getAddress(m)),
    pendleSwap,
  };
}

/**
 * Validate a claim response against the intent. Returns the decoded (effective)
 * claim set when safe; throws `PENDLE_UNSAFE_TX` otherwise. Nothing is signed
 * unless EVERY check passes.
 */
export function assertClaimSafe(
  intent: PendleClaimIntent,
  response: PendleClaimResponse,
): DecodedClaimCall {
  // 1. Router pin.
  if (requireAddress(response.tx.to, "tx.to") !== PENDLE_ROUTER) {
    return unsafe("claim target is not the pinned Pendle Router");
  }
  // 2. Sender bind.
  if (response.tx.from !== null && response.tx.from !== "") {
    if (requireAddress(response.tx.from, "tx.from") !== getAddress(intent.wallet)) {
      return unsafe("claim sender is not the session wallet");
    }
  }
  // 3. Value bind - a claim never sends native value. Missing/empty → zero.
  const rawValue = response.tx.value;
  const value = typeof rawValue === "string" && rawValue !== "" ? BigInt(rawValue) : 0n;
  if (value !== 0n) return unsafe("a claim must not send native value");

  // 4. Calldata bind - decode + pure-sweep invariants (SYs/swaps/pendleSwap).
  const call = decodeClaimCall(response.tx.data);

  // 5. Per-tuple bind - yt ⊆ intended, no no-op tuples, tokenRedeemSy == OUR
  //    resolved underlyingAsset (a divergent redemption token → BLOCK).
  for (const tuple of call.yts) {
    const bind = intent.intendedYts.get(tuple.yt.toLowerCase());
    if (!bind) return unsafe("claim includes a YT outside the intended positions");
    if (!tuple.doRedeemInterest && !tuple.doRedeemRewards) {
      return unsafe("claim includes a no-op YT tuple");
    }
    if (tuple.tokenRedeemSy.toLowerCase() !== bind.tokenRedeemSy) {
      return unsafe("claim redeems interest into an unexpected token");
    }
  }
  // 6. Market subset bind.
  for (const market of call.markets) {
    if (!intent.intendedMarkets.has(market.toLowerCase())) return unsafe("claim includes a market outside the intended positions");
  }

  // 7. Approvals bind - a real interest claim legitimately approves the market's
  //    own SY (the Router pulls the freshly-redeemed SY interest - source), so
  //    the allowed set is EXACTLY the SYs of decoded tuples with doRedeemInterest.
  //    Anything else, a duplicate, or a non-positive amount → BLOCK. The handler
  //    grants each exactly (spender hard-pinned to the Router downstream).
  const allowedSys = new Set<string>();
  for (const tuple of call.yts) {
    if (!tuple.doRedeemInterest) continue;
    const bind = intent.intendedYts.get(tuple.yt.toLowerCase());
    if (bind) allowedSys.add(bind.sy);
  }
  const seen = new Set<string>();
  for (const approval of response.tokenApprovals) {
    const token = requireAddress(approval.token, "claim approval token").toLowerCase();
    if (!allowedSys.has(token)) return unsafe("a claim approval targets a token outside the intended SYs");
    if (seen.has(token)) return unsafe("duplicate claim approval token");
    if (!/^[0-9]+$/.test(approval.amount) || BigInt(approval.amount) <= 0n) {
      return unsafe("a claim approval amount is not a positive integer");
    }
    seen.add(token);
  }
  return call;
}
