import type { Result } from "../../../ipc/result.js";
import type {
  SessionBranchInput,
  SessionBranchResult,
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
  SessionRenameInput,
  SessionRenameResult,
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
   * Rename a session (user display title). Returns the updated row, or
   * `null` when the id is unknown or soft-deleted (stale renderer cache).
   */
  readonly rename: (
    input: SessionRenameInput
  ) => Promise<Result<SessionRenameResult>>;
  /**
   * Fork the session at a message (A14): a new session seeded with a copy
   * of the transcript prefix, the source never rewritten. Blocked states
   * come back as a named discriminated outcome. Never auto-retry: each
   * successful call creates a new session.
   */
  readonly branch: (
    input: SessionBranchInput
  ) => Promise<Result<SessionBranchResult>>;
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
