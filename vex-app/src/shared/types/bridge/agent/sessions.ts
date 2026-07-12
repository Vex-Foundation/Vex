import type { Result } from "../../../ipc/result.js";
import type {
  SessionCreateInput,
  SessionCreateResult,
  SessionDeleteInput,
  SessionDeleteResult,
  SessionExportMarkdownInput,
  SessionExportMarkdownResult,
  SessionGetInput,
  SessionGetModelInput,
  SessionList,
  SessionListItem,
  SessionModelDto,
  SessionSetPinnedInput,
  SessionSetPinnedResult,
} from "../../../schemas/sessions.js";
import type {
  PlanGetInput,
  PlanGetResult,
  PlanSetEnabledInput,
  PlanSetEnabledResult,
  PlanAcceptInput,
  PlanAcceptResult,
} from "../../../schemas/session-plan.js";

export interface SessionsBridge {
  readonly create: (
    input: SessionCreateInput
  ) => Promise<Result<SessionCreateResult>>;
  readonly list: () => Promise<Result<SessionList>>;
  readonly get: (
    input: SessionGetInput
  ) => Promise<Result<SessionListItem | null>>;
  /**
   * Pin/unpin a session. Idempotent on both sides: re-pinning preserves
   * the existing `pinnedAt`, re-unpinning is a no-op. Returns `null`
   * when the id is unknown (stale renderer cache).
   */
  readonly setPinned: (
    input: SessionSetPinnedInput
  ) => Promise<Result<SessionSetPinnedResult>>;
  /**
   * Soft-delete a session. Main enforces fail-closed against active
   * mission runs and pending approvals; the discriminated outcome
   * tells the renderer whether cache cleanup is appropriate.
   */
  readonly delete: (
    input: SessionDeleteInput
  ) => Promise<Result<SessionDeleteResult>>;
  /** Open a native save dialog and export a readable, redacted transcript. */
  readonly exportMarkdown: (
    input: SessionExportMarkdownInput
  ) => Promise<Result<SessionExportMarkdownResult>>;
  /**
   * Resolve the global runtime model for the session — `source:
   * "global_default"` (from `AGENT_PROVIDER`/`AGENT_MODEL`) or
   * `"unconfigured"`. Vex uses one global model; there is no
   * per-session model write.
   */
  readonly getModel: (
    input: SessionGetModelInput
  ) => Promise<Result<SessionModelDto>>;
  /**
   * Session-scoped plan-mode (the agent-authored "HOW"). `setEnabled`/`accept`
   * are server-authoritative; `accept` also resumes a plan-acceptance-paused
   * mission run (`resumed`). `get` returns null when plan-mode was never used.
   */
  readonly plan: {
    readonly get: (input: PlanGetInput) => Promise<Result<PlanGetResult>>;
    readonly setEnabled: (
      input: PlanSetEnabledInput
    ) => Promise<Result<PlanSetEnabledResult>>;
    readonly accept: (
      input: PlanAcceptInput
    ) => Promise<Result<PlanAcceptResult>>;
  };
}
