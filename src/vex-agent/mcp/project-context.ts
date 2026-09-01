/**
 * `ProjectScope` -> `InternalToolContext`: the Studio MCP context builder.
 *
 * A project IS a backing session (`mode = 'agent'`, `scope = 'vex_studio'`), so
 * every gate that keys off a session sees exactly the shape it already knows.
 * Nothing here relaxes a gate; the built context is deliberately the
 * least-privileged one the tool surface accepts:
 *
 *  - `approved: false` on every path the MCP surface itself takes. An approval
 *    is granted by the Vex privileged executor through the approval card, never
 *    by the caller and never by the model (rule 09): a mutating call under
 *    `restricted` returns the pending refusal and stops. Stage A3 added exactly
 *    ONE producer of `approved: true`, the approval runtime's resumed Studio
 *    dispatch, which runs only after the human decided and only after the
 *    dispatch slot was claimed under the stop gate and the dispatch generation.
 *  - `modelOriginated: true`, because everything on this surface was emitted by
 *    an external coding agent's model. It is what keeps the `execute_tool`
 *    envelope closed on this path even if admission were bypassed.
 *  - `walletPolicy: { kind: "none" }` means NO MISSION ALLOWLIST, not "no
 *    wallet". A project has no mission, so there is no frozen allowed-wallet
 *    snapshot to enforce; the wallet SELECTION is enforced by the resolution
 *    below, which fails closed.
 *  - `planMode: false`, `contextUsageBand: "normal"`, no mission: those are
 *    in-app session concerns with no counterpart here, and each of their gates
 *    reads as "not applicable" at these values rather than as a bypass.
 */

import type { InternalToolContext } from "../tools/internal/types.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import type { ProjectScope } from "./project-scope.js";
import type { ApprovedQuoteAuthority } from "../tools/protocols/quote-authority/approved-authority.js";
import type { ApprovedPrequoteAuthority } from "../tools/protocols/prequote/approved-row-authority.js";

/**
 * Build the wallet resolution for a project.
 *
 * ALWAYS `source: "session"`, the same contract an engine session gets
 * (`engine/core/hydrate.ts`'s `buildSessionWalletResolution`): a family with no
 * selection is `null`, and the resolvers then fail closed for that family with
 * a typed error rather than falling through to the primary wallet
 * (`src/tools/wallet/multi-auth.ts`). Address drift between the stored snapshot
 * and the live inventory entry fails closed there too, which is why the address
 * travels with the id instead of being re-derived here.
 */
export function buildProjectWalletResolution(
  wallets: ProjectScope["wallets"],
): WalletResolution {
  return { source: "session", evm: wallets.evm, solana: wallets.solana };
}

/** Caller-owned inputs that are not part of the durable project scope. */
export interface ProjectToolContextOptions {
  /**
   * `true` ONLY on the approval-runtime's resumed Studio dispatch (stage A3),
   * and only after the privileged executor has committed the human's approve
   * decision. It is never derived from the caller, from the model, or from the
   * MCP surface: the A2 executor builds this context with `approved: false`
   * always, and the ONE producer of `true` is
   * `approval-runtime/post-tx/dispatch-approved/studio.ts`, which has already
   * taken the dispatch slot under the stop gate and the dispatch generation.
   */
  readonly approved?: true;
  /**
   * The approval that authorized the dispatch. Present exactly when `approved`
   * is, so the authorization is traceable from the tool context to the row.
   */
  readonly approvalId?: string;
  /**
   * WHICH QUOTE that approval bound, read from the stored envelope by the
   * approval runtime. Same producer and same trust as `approvalId`: it makes the
   * resumed execute claim the exact snapshot the card named instead of whichever
   * quote is newest at dispatch time.
   */
  readonly approvedQuoteAuthority?: ApprovedQuoteAuthority | null;
  /**
   * WHICH PREQUOTE ROW that approval was gated on, and the digest of what the
   * row disclosed on the card. Same producer and same trust as `approvalId`: it
   * fences the rerun prequote gate to that exact row, so a quote recorded while
   * the card waited cannot replace the disclosure a person decided on.
   */
  readonly approvedPrequoteAuthority?: ApprovedPrequoteAuthority | null;
  /**
   * Cancellation for the MCP call that owns this dispatch. ABSENT means "no
   * cancellation", never "cancelled" - same contract as every other producer of
   * `InternalToolContext.abortSignal`.
   */
  readonly abortSignal?: AbortSignal;
}

export function buildProjectToolContext(
  scope: ProjectScope,
  opts: ProjectToolContextOptions = {},
): InternalToolContext {
  return {
    sessionId: scope.backingSessionId,
    loadedDocuments: new Map<string, string>(),
    sessionPermission: scope.permission,
    approved: opts.approved === true,
    ...(opts.approvalId === undefined ? {} : { approvalId: opts.approvalId }),
    ...(opts.approvedQuoteAuthority === undefined || opts.approvedQuoteAuthority === null
      ? {}
      : { approvedQuoteAuthority: opts.approvedQuoteAuthority }),
    ...(opts.approvedPrequoteAuthority === undefined || opts.approvedPrequoteAuthority === null
      ? {}
      : { approvedPrequoteAuthority: opts.approvedPrequoteAuthority }),
    missionRunId: null,
    missionId: null,
    planMode: false,
    sessionKind: "agent",
    contextUsageBand: "normal",
    modelOriginated: true,
    sourceSurface: "mcp_local",
    sourceSession: scope.backingSessionId,
    walletResolution: buildProjectWalletResolution(scope.wallets),
    walletPolicy: { kind: "none" },
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  };
}
