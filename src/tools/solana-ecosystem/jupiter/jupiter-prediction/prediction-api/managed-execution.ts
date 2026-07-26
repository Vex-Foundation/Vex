/**
 * Jupiter Prediction MANAGED-EXECUTION routing — the one place that decides
 * whether a build response must be submitted through the provider's managed
 * execute endpoint, and the one place that validates the provider-supplied
 * routing fields before any of them can influence signing or a network call.
 *
 * ROUTING SIGNAL (corrected 2026-07-25, live-probed —
 * `agents_dm/verify/probe-predict-execution-lanes.ts`): presence of the
 * response's own `execution` object. The previous rule — route only when
 * `executionModel === "atomic_swap"` (Jupiter Forecast/bisonfi) — was wrong,
 * and it is why every prediction mutation was structurally unable to execute:
 * a keeper-filled Polymarket order carries `execution` with NO `executionModel`
 * at all, so it fell through to the raw RPC lane and then died at the
 * sole-signer guard. Observed, same wallet, minutes apart:
 *
 *   POLY-1654958 (keeper-filled): executionModel absent
 *     execution {"endpoint":"/api/v1/execute","context":{"type":"create_order"}}
 *     requiredSigners ["<ourWallet>"]              tx: 3 signers, ours idx 2
 *   BISON-…-DOWN (Forecast):      executionModel "atomic_swap"
 *     execution {"endpoint":"/api/v1/execute","context":{"type":"bisonfi_swap",…}}
 *     requiredSigners ["<jupFeePayer>","<ourWallet>"]  tx: 2 signers, ours idx 1
 *
 * ENDPOINT IS NEVER A URL (security policy, owner decision 2026-07-25). The
 * provider names a PATH; letting that string select a network destination
 * would hand an external party control of an outbound request. It is matched
 * against a small allowlist of known paths and otherwise REFUSED — never
 * silently ignored, never fallen back from. Vex always posts to its OWN fixed
 * `${JUPITER_PREDICTION_API_BASE_URL}/execute`.
 *
 * `requiredSigners` is surfaced here (not consumed here) so
 * `prepareVersionedTx`'s `coSigned` contract can enforce the actual signing
 * invariant — see that module's doc.
 */

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { KnownSolanaBlockhash } from "../../../shared/solana-transaction.js";
import logger from "../../../../../utils/logger.js";
import type {
  JupiterPredictionExecutionContext,
  JupiterPredictionTxMetaFields,
} from "./types.js";

/**
 * Paths Vex recognises as "the prediction managed execute endpoint". All of
 * them resolve to the SAME fixed URL we build ourselves; the allowlist exists
 * to detect a provider that has moved the endpoint (so we fail loudly instead
 * of posting a signed transaction somewhere unintended), not to choose a host.
 *
 * `/api/v1/execute` is what the live API advertises for both lanes;
 * `/prediction/v1/execute` is the path our own base URL produces. Whether the
 * two are the same service is UNVERIFIED — a GET on each returns 404, which a
 * POST-only route does for both. The first real execution settles it, and a
 * wrong guess is a definitive pre-broadcast rejection, not a lost transaction.
 */
const ALLOWED_EXECUTE_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/execute",
  "/prediction/v1/execute",
  "/execute",
]);

/** What a managed-execution build needs in order to be signed and submitted. */
export interface JupiterPredictionManagedExecution {
  /** Passed to the execute endpoint unchanged, exactly as the provider sent it. */
  readonly context: Record<string, unknown>;
  /** The provider's outstanding-signature list — validated by the `coSigned` signer contract. */
  readonly requiredSigners: readonly string[];
  /** VERIFY-mode evidence from the response's own `txMeta`; mandatory for a co-signed transaction. */
  readonly blockhash: KnownSolanaBlockhash;
}

/** The subset of a build response this module reads. Both build shapes satisfy it. */
export interface JupiterPredictionManagedExecutionSource extends JupiterPredictionTxMetaFields {
  readonly execution?: JupiterPredictionExecutionContext | null;
  readonly requiredSigners?: string[];
}

/**
 * `null` when the response carries no `execution` object — the caller keeps its
 * pre-existing lane (raw RPC, REPLACE-mode blockhash, sole-signer contract).
 *
 * Throws (a PRE-broadcast failure — nothing is recorded yet) when the response
 * DOES declare managed execution but cannot be honoured safely: an unknown
 * endpoint, a missing/blank context, absent `requiredSigners`, or missing
 * blockhash evidence. Failing closed is deliberate — the alternative is
 * submitting a signed, funded transaction down a lane the provider did not
 * name.
 */
export function resolveManagedExecution(
  response: JupiterPredictionManagedExecutionSource,
  feature: string,
): JupiterPredictionManagedExecution | null {
  const execution = response.execution;
  if (!execution) return null;

  assertAllowedExecutePath(execution.endpoint, feature);

  if (!execution.context || typeof execution.context !== "object") {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${feature} declared managed execution but returned no execution context.`,
    );
  }

  const requiredSigners = response.requiredSigners;
  if (!Array.isArray(requiredSigners) || requiredSigners.length === 0) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${feature} declared managed execution but did not say which signatures it requires. `
        + "Vex will not sign a transaction whose required signers it cannot verify.",
    );
  }

  return {
    context: execution.context,
    requiredSigners,
    blockhash: requireBlockhashEvidence(response, feature),
  };
}

/**
 * The response's own blockhash evidence, tolerating both documented shapes
 * (`txMeta` — what the live API returns — and the flat pair the claim-payout
 * prose examples show). Mandatory for managed execution: the provider has
 * already signed the slots it owns, so the blockhash cannot be replaced.
 */
function requireBlockhashEvidence(
  response: JupiterPredictionTxMetaFields,
  feature: string,
): KnownSolanaBlockhash {
  const blockhash = response.txMeta?.blockhash ?? response.blockhash;
  const lastValidBlockHeight = response.txMeta?.lastValidBlockHeight ?? response.lastValidBlockHeight;
  if (!blockhash || typeof lastValidBlockHeight !== "number" || !Number.isFinite(lastValidBlockHeight)) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${feature} returned a provider-co-signed transaction without blockhash evidence (txMeta). `
        + "Vex cannot refresh the blockhash without invalidating the provider's signatures.",
    );
  }
  return { blockhash, lastValidBlockHeight };
}

/**
 * Reject anything that is not a bare, known path. A value carrying a scheme,
 * an authority (`//host`), userinfo, or a `..` traversal is treated as hostile
 * regardless of what it resolves to.
 */
function assertAllowedExecutePath(endpoint: string, feature: string): void {
  const path = typeof endpoint === "string" ? endpoint.trim() : "";
  const looksAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith("//");
  if (!path || looksAbsolute || path.includes("@") || path.includes("..") || !path.startsWith("/")) {
    logger.warn("jupiter_prediction.execute_endpoint_rejected", { feature, reason: "not_a_bare_path" });
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${feature} named an execution endpoint Vex will not route to. `
        + "Vex only posts to its own configured Jupiter Prediction execute endpoint.",
    );
  }
  if (!ALLOWED_EXECUTE_PATHS.has(path)) {
    // The provider moved the endpoint. Refuse loudly: the operator needs to
    // re-verify the route before Vex sends signed transactions to it.
    logger.warn("jupiter_prediction.execute_endpoint_rejected", { feature, reason: "unknown_path", path });
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${feature} named an unrecognised execution endpoint. `
        + "Vex only posts to its own configured Jupiter Prediction execute endpoint.",
    );
  }
}
