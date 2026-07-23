/**
 * Relay bridge identity builder + quote-shape validator (LOCKED Wave-2 #4/#5).
 *
 * Relay gets its OWN bridge identity path — it does NOT reuse Khalani's builder.
 * The relay QUOTE recorder (`relay.quote.get`) and the relay EXECUTE gate
 * (`relay.bridge`) both build an IDENTICAL identity from the same params so
 * their match-hashes collide, with `provider: "relay"` bound in (so a khalani
 * quote can never authorize a relay execute).
 *
 * Relay is EVM-only here (v1): both legs are `eip155`, and Relay has no
 * referrer/fee/filler concept, so those identity fields are stable empties.
 */

import { z } from "zod";

import { getCachedRelayChains } from "@tools/relay/client.js";
import { resolveRelayChainId, toRelayCurrency } from "@tools/relay/chains.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { BridgeMatchInput, BridgeTradeType } from "./hash.js";

function relayStr(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse the (untrusted) relay `tradeType` param into a DISTINCT identity value.
 * `EXPECTED_OUTPUT` (Relay's recommended plain-bridge mode) is kept distinct from
 * `EXACT_INPUT` (R10) so a quote and an execute that disagree on the trade
 * direction produce different digests → the gate blocks. Applied IDENTICALLY at
 * record-time and gate-time (both go through `buildRelayBridgeIdentity`), so a
 * matching param still collides. Unknown/absent → `EXACT_INPUT` (unchanged
 * default; the handler defaults the same way).
 */
function parseTradeType(raw: string): BridgeTradeType {
  if (raw === "EXACT_OUTPUT") return "EXACT_OUTPUT";
  if (raw === "EXPECTED_OUTPUT") return "EXPECTED_OUTPUT";
  return "EXACT_INPUT";
}

/**
 * Build the canonical relay bridge identity from the (untrusted) relay params +
 * execution context. Async: resolves the cached Relay chain registry to map
 * chain aliases/ids. Throws on a missing required field, an unsupported chain, or
 * a wallet-scope error (recorder → skip, gate → fail-closed block).
 */
export async function buildRelayBridgeIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<BridgeMatchInput> {
  const fromChain = relayStr(params, "fromChain");
  const toChain = relayStr(params, "toChain");
  const fromToken = relayStr(params, "fromToken");
  const toToken = relayStr(params, "toToken");
  const amount = relayStr(params, "amount");
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Relay bridge identity missing required field.");
  }

  const chains = await getCachedRelayChains();
  const fromChainId = resolveRelayChainId(fromChain, chains);
  const toChainId = resolveRelayChainId(toChain, chains);

  // Relay v1 is EVM-only — the signer + recipient are the same EVM EOA across
  // EVM chains.
  const sourceWallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  const explicitRecipient = relayStr(params, "recipient");
  const recipient = explicitRecipient !== "" ? explicitRecipient : sourceWallet;
  const explicitRefundTo = relayStr(params, "refundTo");
  const refundTo = explicitRefundTo !== "" ? explicitRefundTo : sourceWallet;

  return {
    kind: "bridge",
    sessionId,
    provider: "relay",
    sourceFamily: "eip155",
    destFamily: "eip155",
    fromChainId,
    toChainId,
    sourceWallet,
    recipient,
    fromToken: toRelayCurrency(fromToken),
    toToken: toRelayCurrency(toToken),
    amount,
    tradeType: parseTradeType(relayStr(params, "tradeType")),
    refundTo,
    // Relay has no referrer/fee/filler surface — stable empties.
    referrer: "",
    referrerFeeBps: "",
    filler: "",
  };
}

// ── Relay quote shape validation (own extraction) ─────────────────────────────

const RelayQuoteStepShape = z.object({
  kind: z.string(),
  chainIds: z.array(z.number()),
});

const RelayQuoteResultShape = z.object({
  provider: z.literal("relay"),
  originChainId: z.number(),
  destinationChainId: z.number(),
  steps: z.array(RelayQuoteStepShape).min(1),
});

/**
 * Validate a relay quote result's step shape before it seeds the gate: at least
 * one `transaction` step, and EVERY step chainId is the origin or destination.
 * A malformed quote returns false → the recorder skips it (the gate then
 * fail-closes on the missing prequote). Fee sanity: the recorder only records a
 * quote the client already Zod-validated, so structural chain-scoping is the
 * meaningful gate here.
 */
export function isValidRelayQuoteShape(data: Record<string, unknown>): boolean {
  const parsed = RelayQuoteResultShape.safeParse(data);
  if (!parsed.success) return false;
  const { originChainId, destinationChainId, steps } = parsed.data;
  const allowed = new Set([originChainId, destinationChainId]);
  let hasTransaction = false;
  for (const step of steps) {
    if (step.kind === "transaction") hasTransaction = true;
    for (const chainId of step.chainIds) {
      if (!allowed.has(chainId)) return false;
    }
  }
  return hasTransaction;
}
