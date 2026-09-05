/**
 * The Studio call SEAM: what one external MCP call can produce, and what the
 * caller may hand in with it.
 *
 * These types live in the engine package rather than beside `runStudioCall` in
 * `vex-app/src/main/studio/approval-service.ts` because there are now two sides
 * to the seam and neither may import the other. The MCP server
 * (`src/vex-agent/mcp/server.ts`, stage A4a-2) receives `runCall` as an
 * INJECTED dependency and projects its outcome onto `CallToolResult`; main owns
 * the implementation. A shared vocabulary in a runtime-free module is what lets
 * both compile against the same contract without the engine reaching into the
 * app or the app's private types leaking into the engine.
 *
 * Types only. Nothing here loads a database, reads configuration, or holds
 * state; the whole module is erased at build time.
 */

import type { ToolResult } from "../tools/types.js";

/** What one Studio call produced. Exactly one of these reaches the agent. */
export type StudioCallOutcome =
  | {
      /** The call ran (with or without an approval) and this is its result. */
      readonly kind: "completed";
      readonly result: ToolResult;
      readonly durationMs?: number;
      readonly approvalId?: string;
    }
  | {
      /** A human rejected the action. Nothing ran. */
      readonly kind: "declined";
      readonly approvalId: string;
      readonly reason: string;
    }
  | {
      /** Nobody decided in time. Nothing ran. */
      readonly kind: "expired";
      readonly approvalId: string;
    }
  | {
      /**
       * An owner terminally cancelled the pending action: Vex locked, the
       * project deleted or its scope edited, the transport went away, or Vex
       * quit. Nothing ran.
       */
      readonly kind: "refused";
      readonly approvalId: string;
      readonly reason: string;
      /** `false` means the cancellation itself is not confirmed durable. */
      readonly confirmed: boolean;
    }
  | {
      /** The approved dispatch could not be carried out. Nothing ran. */
      readonly kind: "dispatch_failed";
      readonly approvalId: string;
      readonly reason: string;
    }
  | {
      /**
       * The approved dispatch MAY have taken effect and Vex cannot prove it.
       * The agent must NOT retry; the scheduled reconciler owns the row.
       */
      readonly kind: "indeterminate";
      readonly approvalId: string;
    }
  | {
      /** The call never became decidable. `reason` names the real cause. */
      readonly kind: "not_queued";
      readonly reason: string;
    };

/**
 * WHY a blocked call is being torn down, as a TRUSTED value.
 *
 * The four causes are set by the OWNER of each teardown, never derived from
 * anything a client sent: an MCP `notifications/cancelled` is `cancelled`, a
 * peer FIN or a lost socket is `disconnect`, the secret-session lock is
 * `lock`, application quit is `vex_quit`. The client's own `reason` string is
 * untrusted model-or-agent text and must never decide what Vex writes into a
 * durable audit column.
 *
 * Each value is one of migration 086's six pending refusal causes, so the
 * cause the owner names is the cause `approval_intents.refusal_reason` records.
 * The remaining two (`project_deleted`, `scope_changed`) belong to the scope
 * and deletion owners, which refuse their rows directly rather than through a
 * blocked call's abort signal.
 */
export type StudioCancelCause = "cancelled" | "disconnect" | "lock" | "vex_quit";

export interface RunStudioCallOptions {
  /** Cancels the in-flight call AND withdraws a pending approval. */
  readonly signal?: AbortSignal;
  /** Called every couple of seconds while a decision is outstanding. */
  readonly onProgress?: () => void;
  /**
   * Asked ONCE, at abort time, for the typed cause of this teardown.
   *
   * A function rather than a value because the cause is not known when the
   * call starts: the same in-flight call can end in any of the four ways, and
   * the owner that aborts the signal is the one that knows which. Absent (or
   * throwing) means `cancelled`, which is the behavior every caller had before
   * this channel existed and is the honest machine fact for "the caller went
   * away without saying why".
   */
  readonly cancelCause?: () => StudioCancelCause;
  /**
   * The `clientInfo.name` this call's MCP client declared in its `initialize`
   * handshake, so an approval card can NAME the actor that proposed the action
   * rather than leaving the row blank (rule 90).
   *
   * UNTRUSTED, SELF-DECLARED DISPLAY TEXT. Another process chose it; nothing
   * may branch on it, and the enqueue path sanitizes it before it is stored.
   * Absent when the client sent no usable name - the card then says "an MCP
   * client", which is the honest claim.
   *
   * It is NOT on the Vex Studio handshake line (`{v, projectId}`): the client
   * name arrives inside the MCP `initialize` the SDK server consumes, so the
   * server module is the only place that can read it.
   */
  readonly clientName?: string;
}
