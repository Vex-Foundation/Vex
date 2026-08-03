/**
 * Bridge prequote recording (Khalani + Relay). A route proves availability, not
 * token safety, so the verdict is ALWAYS `unknown`.
 */

import { randomUUID } from "node:crypto";

import logger from "@utils/logger.js";

import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { CreatePrequoteInput } from "@vex-agent/db/repos/swap-prequotes.js";

import { PREQUOTE_MAX_AGE_MS } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import type { BridgeMatchInput } from "../identity/hash.js";
import { buildBridgeIdentity } from "../identity/bridge.js";
import { buildRelayBridgeIdentity, isValidRelayQuoteShape } from "../identity/relay-bridge.js";
import { writePrequoteRow } from "./row.js";

/**
 * Bounded structural-only safetyDetail for a bridge prequote. A successful
 * Khalani quote proves route availability, NOT token safety — so the verdict is
 * ALWAYS `unknown` and the detail says exactly that (object shape, no raw text).
 */
const BRIDGE_SAFETY_DETAIL: Record<string, unknown> = {
  bridge: true,
  note: "route-only; no token-safety check",
};

/**
 * Record a bridge prequote from a successful `khalani.quote.get`. The identity
 * comes from the QUOTE params via the SHARED `buildBridgeIdentity` (the same
 * builder the execute gate uses), so quote↔execute hashes collide. Verdict is
 * ALWAYS `unknown`. Best-effort: an identity-build throw (unresolved chain /
 * wallet-scope) is a bounded skip, never a fabricated row.
 */
export async function recordBridgePrequote(
  toolId: string,
  sessionId: string,
  provider: string,
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  // Relay gets its OWN extraction (LOCKED #5): validate the quote's step shape
  // (transaction steps only, chainIds ∈ {origin, destination}) BEFORE recording,
  // so a malformed quote never seeds the gate. Khalani route availability is
  // proven by its own quote validation upstream.
  if (provider === "relay" && !isValidRelayQuoteShape(resultData)) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "relay_shape_invalid" });
    return;
  }

  let identity: BridgeMatchInput;
  try {
    identity =
      provider === "relay"
        ? await buildRelayBridgeIdentity(sessionId, params, context)
        : await buildBridgeIdentity(sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "bridge_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }

  const matchHash = computePrequoteMatchHash(identity);
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash,
    kind: "bridge",
    // Bridge prequote `family` is the SOURCE family (where the signer lives) —
    // mirrors the verdict provider/family pairing the gate reads back by kind.
    family: identity.sourceFamily,
    provider,
    // Bridge rows have two chain ids; only the SOURCE id maps onto the single
    // `chain_id` column (the dest id is part of the match-hash, not a column).
    chainId: identity.fromChainId,
    walletAddress: identity.sourceWallet,
    tokenIn: identity.fromToken,
    tokenOut: identity.toToken,
    amount: identity.amount,
    slippageBps: null,
    safetyVerdict: "unknown",
    safetyDetail: BRIDGE_SAFETY_DETAIL,
    routeRef: null,
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  };

  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", {
      toolId,
      family: identity.sourceFamily,
      verdict: "unknown",
    });
  }
}
