/**
 * Shared bridge identity builder (record-time AND gate-time) + the bridge-only
 * param helpers.
 *
 * THE crux of Stage 8c: the bridge QUOTE recorder (`khalani.quote.get`) and the
 * bridge EXECUTE gate (`khalani.bridge`) MUST compute an IDENTICAL bridge
 * identity so their match-hashes collide. Both tools receive the SAME
 * alias-translated params (the `bridge_quote` and `bridge` aliases translate to
 * the same khalani param keys), so this builder is purely params- + context-
 * driven and is the SINGLE source of bridge identity — neither side reimplements
 * the field extraction or the defaults.
 *
 * Defaults (mirror the khalani bridge/quote handlers + `prepareQuoteRequest`):
 *   - chain ids   : `resolveChainId(from/toChain, chains)` → numeric Khalani id,
 *   - source/dest family: `getChainFamily(chainId, chains)`,
 *   - sourceWallet: `resolveSelectedAddress(..., sourceFamily)` (the signer),
 *   - recipient   : explicit `params.recipient`, else the dest-family selected
 *                   wallet (`resolveSelectedAddress(..., destFamily)`),
 *   - tradeType   : "EXACT_OUTPUT" iff params.tradeType === "EXACT_OUTPUT",
 *                   else "EXACT_INPUT" (same as `parseTradeType`),
 *   - refundTo    : explicit `params.refundTo`, else `sourceWallet` (mirrors
 *                   `prepareQuoteRequest`: an omitted refundTo → the resolved
 *                   `fromAddress`, which under a session IS the source wallet),
 *   - referrer    : explicit `params.referrer`, else "" (EVM address; the hash
 *                   lowercases it),
 *   - referrerFeeBps: explicit `params.referrerFeeBps` canonicalized via
 *                   `canonReferrerFeeBps`, else "",
 *   - filler      : explicit `params.filler`, else "" (opaque provider NAME, not
 *                   an address — case-preserved by the hash).
 *
 * Tokens/amount/money-fee fields are passed through (the hash canonicalizes per
 * leg family / per field). Any throw (unresolved chain, wallet-scope, invalid
 * referrerFeeBps) propagates to the caller: the recorder treats it as a skip,
 * the gate treats it as a fail-closed block.
 */

import { getCachedKhalaniChains, getChainFamily, resolveChainId } from "@tools/khalani/chains.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { BridgeMatchInput, BridgeTradeType } from "./hash.js";
import { GateIdentityError } from "../gate-errors.js";

export function bridgeStr(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseBridgeTradeType(raw: string): BridgeTradeType {
  return raw === "EXACT_OUTPUT" ? "EXACT_OUTPUT" : "EXACT_INPUT";
}

/**
 * Canonicalize `referrerFeeBps` to the SAME numeric identity the Khalani handler
 * derives. The handler's `parseReferrerFeeBps` does `Number(value)` and requires
 * an integer in [0, 9999]; collapsing the string with the generic amount
 * canonicalizer is unsafe here (it would not merge `"0x64"`/`"1e2"`/`"+100"`
 * into the same integer the handler accepts, producing false-negative gate
 * blocks). We reproduce the handler's parse so quote↔execute collide whenever
 * the handler would treat the fees as equal. Empty/omitted → "" (stable token).
 * An invalid value THROWS — the recorder skips, the gate fails closed (BLOCK),
 * mirroring `parseReferrerFeeBps` rejecting it before any broadcast.
 */
function canonReferrerFeeBps(raw: string): string {
  if (raw === "") return "";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 9999) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "referrerFeeBps must be an integer between 0 and 9999.",
    );
  }
  return String(parsed);
}

/**
 * Build the canonical bridge identity from the (untrusted) khalani bridge/quote
 * params + execution context. Async: resolves the Khalani chain registry to map
 * chain aliases/ids to numeric ids and to derive each leg's family. Throws on a
 * missing required field, an unresolved chain, or a wallet-scope error.
 */
export async function buildBridgeIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<BridgeMatchInput> {
  const fromChain = bridgeStr(params, "fromChain");
  const toChain = bridgeStr(params, "toChain");
  const fromToken = bridgeStr(params, "fromToken");
  const toToken = bridgeStr(params, "toToken");
  const amount = bridgeStr(params, "amountRaw");
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Bridge identity missing required field.");
  }

  const chains = await getCachedKhalaniChains();
  const fromChainId = resolveChainId(fromChain, chains);
  const toChainId = resolveChainId(toChain, chains);
  const sourceFamily = getChainFamily(fromChainId, chains);
  const destFamily = getChainFamily(toChainId, chains);

  // Source signer = the session's selected wallet for the source family.
  const sourceWallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, sourceFamily);

  // Recipient default mirrors the bridge handler: explicit recipient honored,
  // else the dest-family selected wallet (fail-closed if neither resolves).
  const explicitRecipient = bridgeStr(params, "recipient");
  const recipient = explicitRecipient !== ""
    ? explicitRecipient
    : resolveSelectedAddress(context.walletResolution, context.walletPolicy, destFamily);

  // Money/fee leg (8c security fix) — bound so a quote cannot authorize an
  // execute that redirects refunds or changes the fee. Defaults mirror
  // `prepareQuoteRequest`: refundTo falls back to the source wallet (== the
  // resolved fromAddress under a session); referrer/referrerFeeBps/filler are
  // absent → "". referrerFeeBps is canonicalized to the handler's numeric
  // identity (throws on an invalid value → recorder skip / gate fail-closed).
  //
  // NOTE: `referrer`/`referrerFeeBps` can no longer be SUPPLIED — the tool and
  // alias surfaces dropped them and both Khalani handlers reject them by name
  // (bridge referral-fee policy in `@tools/khalani/request.js`), so in practice
  // these always read "". The binding is kept deliberately: it costs nothing,
  // keeps persisted match-hashes stable, and means a stray fee arriving by any
  // future path still fails the quote↔execute collision instead of sliding
  // through. It is a second barrier, not the primary defense.
  // DERIVED, never read from params. Binding it from PARAMS was the hole: an
  // attacker who set the SAME address on the quote AND the execute produced two
  // colliding hashes, so the gate passed a redirected refund. The tool and
  // alias surfaces no longer accept the key at all and both handlers reject it
  // by name; binding the derived value keeps the identity honest about where a
  // refund would land. Unchanged for every legitimate call — an omitted
  // `refundTo` already resolved to the source wallet — so persisted hashes do
  // not move.
  const refundTo = sourceWallet;
  const referrer = bridgeStr(params, "referrer");
  const referrerFeeBps = canonReferrerFeeBps(bridgeStr(params, "referrerFeeBps"));
  const filler = bridgeStr(params, "filler");

  return {
    kind: "bridge",
    sessionId,
    // Venue binding (LOCKED #4) — Khalani's own bridge identity path.
    provider: "khalani",
    sourceFamily,
    destFamily,
    fromChainId,
    toChainId,
    sourceWallet,
    recipient,
    fromToken,
    toToken,
    amount,
    tradeType: parseBridgeTradeType(bridgeStr(params, "tradeType")),
    refundTo,
    referrer,
    referrerFeeBps,
    filler,
    // Khalani has NO slippage surface — `khalani.bridge` accepts no
    // `slippageBps` and forwards none, so the identity binds the stable empty
    // on BOTH sides and Khalani quote↔execute pairs collide exactly as before.
    // (The generic `bridge`/`bridge_quote` aliases declare a `slippageBps` arg
    // for their Relay branch; on the Khalani branch it is REJECTED BY NAME —
    // Khalani is filler-bound and the param would have had no effect, so
    // accepting it silently told the agent it had bought price protection it
    // did not have.)
    slippageBps: "",
  };
}

/**
 * EXECUTE-ONLY khalani.bridge params the bridge QUOTE (`khalani.quote.get`) has
 * NO counterpart for — they can never be quote-bound, so they can never appear
 * in the prequote identity. `routeId` pins a specific route; `depositMethod`
 * picks the on-chain deposit path. Both materially change the broadcast but are
 * invisible to the quote, so binding them is impossible by construction.
 */
const BRIDGE_UNBINDABLE_PARAMS = ["routeId", "depositMethod"] as const;

/**
 * Fail closed if a bridge EXECUTE carries an unbindable execute-only param. This
 * runs in the gate (the single broadcast chokepoint), so it protects BOTH the
 * `bridge` alias and the direct `execute_tool({ toolId:"khalani.bridge" })`
 * path — even though the alias surface no longer exposes these params. A
 * non-empty value → `GateIdentityError("unbindable_param")` (caught upstream →
 * bounded BLOCK before approval).
 */
export function assertBridgeParamsBindable(params: Record<string, unknown>): void {
  for (const key of BRIDGE_UNBINDABLE_PARAMS) {
    if (bridgeStr(params, key) !== "") {
      throw new GateIdentityError("unbindable_param");
    }
  }
}
