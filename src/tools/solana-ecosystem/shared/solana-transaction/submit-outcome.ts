/**
 * The shared OUTCOME vocabulary for landing an already-signed, already-staged
 * Solana transaction (design `solana-landing-lanes-design.md` D2/D4).
 *
 * Every landing lane — Jupiter `/tx/v1/submit`, Jupiter Forecast
 * `/prediction/v1/execute`, and the protocol-agnostic RPC lane — reports
 * through this ONE union so a handler renders the same truthful vocabulary
 * regardless of which lane carried the bytes. Protocol-agnostic by design, so
 * it lives here rather than in `jupiter-swaps/` (the RPC lane may not import
 * from a protocol shelf).
 *
 * The load-bearing distinction is `rejected_before_broadcast` vs
 * `transport_uncertain`:
 *
 *   - `rejected_before_broadcast` — the landing service ANSWERED and refused.
 *     Nothing reached the network through this attempt. Telling the agent
 *     "broadcast, confirmation pending" here is a false claim (it is what hid
 *     the tipless-submit defect during the funded live gate), so a handler
 *     MUST report this as a rejection and surface the sanitized reason.
 *   - `transport_uncertain` — the request may or may not have been delivered
 *     (network error, timeout, 5xx, unparseable answer). The transaction may
 *     still land, so the handler stays truthful-pending and the sweep resolves
 *     the row.
 *
 * NEITHER kind terminalizes the `agent_activity` row: the K3 sweep remains the
 * sole settlement/expiry authority (design D4). This union only decides what
 * the agent is TOLD.
 *
 * `cause` is the RAW thrown value and is NOT safe to print — it may embed
 * provider URLs, bodies, or auth material. Handlers pass it through their
 * scrub boundary (`summarizeProtocolError`) before it reaches output or logs.
 */

import { VexError } from "../../../../errors.js";

export type SolanaSubmitOutcome =
  | { readonly kind: "accepted"; readonly signature: string }
  | {
      readonly kind: "signature_mismatch";
      readonly localSignature: string;
      readonly providerSignature: string;
    }
  | { readonly kind: "rejected_before_broadcast"; readonly cause: unknown }
  | { readonly kind: "transport_uncertain"; readonly cause: unknown };

/**
 * Classify a throw from an HTTP landing provider (`/tx/v1/submit`,
 * `/prediction/v1/execute`).
 *
 * A 4xx is the ONLY definitive "nothing was broadcast" evidence available at
 * this boundary: the provider parsed the request and refused it (Jupiter
 * documents `400` for "missing or insufficient tip"). Everything else —
 * 5xx, timeouts, DNS/socket errors, a 200 whose body failed schema validation
 * — is ambiguous, because the signed bytes may already have been forwarded.
 *
 * Defaults to `transport_uncertain`: claiming "definitely not broadcast" when
 * we do not know would be the same class of lie this module exists to prevent.
 */
export function classifyProviderSubmitFailure(err: unknown): SolanaSubmitOutcome {
  const status = err instanceof VexError ? err.httpStatus : undefined;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return { kind: "rejected_before_broadcast", cause: err };
  }
  return { kind: "transport_uncertain", cause: err };
}
