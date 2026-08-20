/**
 * Sessions schemas for the multi-session app shell.
 *
 * Mirrors the `sessions` row contract established by the base Vex Agent
 * migrations and the engine repo (`src/vex-agent/db/repos/sessions.ts`).
 *
 * Invariants (immutable per session):
 *   - `mode` ∈ { "agent", "mission" }
 *   - `permission` ∈ { "restricted", "full" }
 *   - `initialGoal` is nullable for all modes. Mission sessions start
 *     without a goal; the first chat turn becomes the initial mission goal.
 *
 * The `sessionCreateInputSchema` is a discriminated union on `mode` so the
 * renderer + preload + main agree on the immutable session axes. Mission goal
 * capture belongs to `vex.chat.submit`, not to the create-session modal.
 *
 * Migration 020 adds two GUI-only columns: `title` (user-entered display
 * name, mandatory at create time, capped at 80 chars on UI side / 120 on
 * the DB CHECK) and `pinned_at` (NULL or timestamp; used for the sidebar's
 * Pinned bucket ordering).
 */

import { z } from "zod";
import { reasoningCapabilitySchema } from "./reasoning.js";

export const VEX_APP_SESSION_SCOPE = "vex_app" as const;
export const INITIAL_GOAL_MAX_LENGTH = 2000;
export const SESSION_TITLE_MAX_LENGTH = 80;

/**
 * User-entered session name. Required for both agent and mission sessions —
 * the sidebar always renders the user's title. Trimmed + bounded; DB CHECK
 * gives a 40-char safety margin (120) over the UI cap (80).
 */
export const sessionTitleSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(
    SESSION_TITLE_MAX_LENGTH,
    `Name must be ${SESSION_TITLE_MAX_LENGTH} characters or less.`,
  );

export const sessionModeSchema = z.enum(["agent", "mission"]);
export type SessionMode = z.infer<typeof sessionModeSchema>;

export const sessionPermissionSchema = z.enum(["restricted", "full"]);
export type SessionPermission = z.infer<typeof sessionPermissionSchema>;

// Mirror of `src/vex-agent/engine/types.ts MISSION_RUN_STATUSES`. The
// runtime-status drift test in
// `src/__tests__/lib/diagnostics/runtime-status-sync.test.ts` pins the
// two enums via `.options` against the canonical engine const. Adding a
// new status MUST update both this enum and engine types in lock-step.
export const missionRunStatusSchema = z.enum([
  "running",
  "paused_approval",
  "paused_wake",
  "paused_error",
  "paused_user",
  "paused_plan_acceptance",
  "paused_user_form",
  "completed",
  "failed",
  "stopped",
  "cancelled",
]);
export type MissionRunStatus = z.infer<typeof missionRunStatusSchema>;

/**
 * IPC input for `vex.sessions.create`. Goal text is intentionally absent:
 * mission sessions receive their first goal through `vex.chat.submit`.
 */
export const sessionCreateInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("agent"),
      name: sessionTitleSchema,
      permission: sessionPermissionSchema,
      // Puzzle 5 phase 5C: optional per-session wallet selection (immutable).
      // Renderer sends only inventory IDs; main resolves id → address.
      selectedEvmWalletId: z.string().max(128).nullable().optional(),
      selectedSolanaWalletId: z.string().max(128).nullable().optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("mission"),
      name: sessionTitleSchema,
      permission: sessionPermissionSchema,
      selectedEvmWalletId: z.string().max(128).nullable().optional(),
      selectedSolanaWalletId: z.string().max(128).nullable().optional(),
    })
    .strict(),
]);
export type SessionCreateInput = z.infer<typeof sessionCreateInputSchema>;

/**
 * IPC input for `vex.sessions.get`. Session ids are UUIDv4 minted by the
 * main process at create time — renderer never minted ids in this build.
 */
export const sessionGetInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();
export type SessionGetInput = z.infer<typeof sessionGetInputSchema>;

/**
 * Single row in the sidebar list. Carries enough metadata for the
 * sidebar to render mode/permission badges + optional mission-run
 * status pill without a second IPC roundtrip.
 */
export const sessionListItemSchema = z
  .object({
    id: z.string().uuid(),
    mode: sessionModeSchema,
    permission: sessionPermissionSchema,
    /**
     * User-entered display name for the session. `null` only for rows
     * created before migration 020 landed; new rows always carry a value.
     * Renderer falls back to `initialGoal` or a mode default when null.
     */
    title: z.string().nullable(),
    initialGoal: z.string().nullable(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    /**
     * Active mission_run.status when `mode === "mission"` AND a run is
     * active/paused. Null for agent sessions, mission sessions that haven't
     * started a run yet, and completed/cancelled runs.
     */
    missionStatus: missionRunStatusSchema.nullable(),
    /**
     * `null` when not pinned. When set, the sidebar surfaces the row in a
     * dedicated Pinned bucket ordered by `pinnedAt DESC` (most recently
     * pinned first). The timestamp double as ordering key.
     */
    pinnedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

export const sessionListSchema = z.array(sessionListItemSchema);
export type SessionList = z.infer<typeof sessionListSchema>;

/**
 * Result of `vex.sessions.create`. We return the newly minted id plus the
 * fields we just persisted so the renderer can optimistically insert into
 * the sidebar query cache.
 */
export const sessionCreateResultSchema = sessionListItemSchema;
export type SessionCreateResult = z.infer<typeof sessionCreateResultSchema>;

/**
 * IPC input for `vex.sessions.setPinned`. Pin/unpin is idempotent — pinning
 * an already-pinned row keeps the existing `pinned_at`, and unpinning an
 * already-unpinned row is a no-op. Pinning a non-existent id returns
 * `ok(null)` rather than an error (caller had a stale view).
 */
export const sessionSetPinnedInputSchema = z
  .object({
    id: z.string().uuid(),
    pinned: z.boolean(),
  })
  .strict();
export type SessionSetPinnedInput = z.infer<typeof sessionSetPinnedInputSchema>;

export const sessionSetPinnedResultSchema = sessionListItemSchema.nullable();
export type SessionSetPinnedResult = z.infer<typeof sessionSetPinnedResultSchema>;

/**
 * IPC input for `vex.sessions.rename`. The name rides the same
 * `sessionTitleSchema` bound the create path uses (trimmed, 1-80 chars).
 * Renaming an unknown or soft-deleted id returns `ok(null)` rather than an
 * error (caller had a stale view).
 */
export const sessionRenameInputSchema = z
  .object({
    id: z.string().uuid(),
    name: sessionTitleSchema,
  })
  .strict();
export type SessionRenameInput = z.infer<typeof sessionRenameInputSchema>;

export const sessionRenameResultSchema = sessionListItemSchema.nullable();
export type SessionRenameResult = z.infer<typeof sessionRenameResultSchema>;

/**
 * IPC input for `vex.sessions.delete` (soft delete). The renderer asks
 * to hide a session; main decides whether that is safe.
 */
export const sessionDeleteInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();
export type SessionDeleteInput = z.infer<typeof sessionDeleteInputSchema>;

/**
 * Discriminated outcome of `vex.sessions.delete`. The renderer switches
 * cache cleanup on the value:
 *   - terminal hidden ("removed" | "not_found" | "already_removed") →
 *     remove detail cache + invalidate list + clear `activeSessionId`
 *     if it matches the input id.
 *   - blocked ("blocked_active_mission" | "blocked_pending_approval"
 *     | "state_changed") → leave caches untouched, surface actionable
 *     copy in the confirmation dialog so the user can resolve the
 *     blocker and retry.
 *
 * `state_changed` is the race-loser outcome: the atomic guarded UPDATE
 * saw a blocker, but by the time classification ran the blocker had
 * disappeared. The retry path is "re-click Remove", not an error toast.
 */
export const sessionDeleteOutcomeSchema = z.enum([
  "removed",
  "not_found",
  "already_removed",
  "blocked_active_mission",
  "blocked_pending_approval",
  "state_changed",
]);
export type SessionDeleteOutcome = z.infer<typeof sessionDeleteOutcomeSchema>;

export const sessionDeleteResultSchema = z
  .object({
    outcome: sessionDeleteOutcomeSchema,
  })
  .strict();
export type SessionDeleteResult = z.infer<typeof sessionDeleteResultSchema>;

/**
 * Native Markdown export. Main owns both the save dialog and the destination
 * path; the renderer supplies only the session id and receives back only
 * `saved | cancelled` — never the path.
 */
export const sessionExportMarkdownInputSchema = sessionGetInputSchema;
export type SessionExportMarkdownInput = z.infer<
  typeof sessionExportMarkdownInputSchema
>;

export const sessionExportMarkdownOutcomeSchema = z.enum(["saved", "cancelled"]);
export type SessionExportMarkdownOutcome = z.infer<
  typeof sessionExportMarkdownOutcomeSchema
>;

export const sessionExportMarkdownResultSchema = z
  .object({
    outcome: sessionExportMarkdownOutcomeSchema,
  })
  .strict();
export type SessionExportMarkdownResult = z.infer<
  typeof sessionExportMarkdownResultSchema
>;

// ── Global runtime model resolution ──────────────────────────────────────
//
// Vex uses a single global model for every session, resolved by the
// engine from `AGENT_PROVIDER`/`AGENT_MODEL`. There is no per-session
// model: `sessions.getModel` is read-only and reports the resolved
// global model so the chat header can show it.
//
// `source` discriminates the two real states: `"global_default"` means
// the resolver read `AGENT_PROVIDER`/`AGENT_MODEL`; `"unconfigured"`
// means neither is set (renderer surfaces "Model not configured").

export const sessionModelSourceSchema = z.enum([
  "global_default",
  "unconfigured",
]);
export type SessionModelSource = z.infer<typeof sessionModelSourceSchema>;

export const sessionModelDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    /** Resolved provider id (e.g. `"openrouter"`). `null` when source = "unconfigured". */
    provider: z.string().nullable(),
    /** Resolved model id. `null` when source = "unconfigured". */
    modelId: z.string().nullable(),
    source: sessionModelSourceSchema,
    /**
     * Always `null` — the model is global runtime config, not a
     * per-session override, so there is no per-session update timestamp.
     * Kept on the DTO for a stable shape the chat header can render.
     */
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    /**
     * Whether the resolved model supports reasoning at all (S6), coarse
     * boolean/unknown signal kept for backward compatibility. Resolved in
     * main via the `reasoning` fallback chain below: `true`/`false` when
     * either `reasoning` is non-null or the reasoning-capability catalog
     * entry's `supportsReasoningParameter` is known, `null` when totally
     * unknown (unconfigured, provider locked, or catalog unreachable).
     */
    supportsReasoning: z.boolean().nullable(),
    /**
     * Per-model reasoning capability (S6 reasoning-selector), REQUIRED
     * nullable. `null` means "no selector" (non-reasoning model, or
     * capability data unavailable); non-null is the D4-set-normalized
     * FINAL selectable set (`normalizeReasoningCapability`,
     * `shared/schemas/reasoning.ts`). Resolved in main
     * (`main/ipc/sessions/get-model.ts`) via a fallback chain: the
     * reasoning-capability catalog entry for the configured model id →
     * `null` when the catalog entry itself has no levels but the model
     * still nominally supports reasoning → `null` when the catalog is
     * unavailable entirely (falls back to the pre-S6 pricing-proxy probe
     * for `supportsReasoning` only).
     */
    reasoning: reasoningCapabilitySchema.nullable(),
  })
  .strict();
export type SessionModelDto = z.infer<typeof sessionModelDtoSchema>;

export const sessionGetModelInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();
export type SessionGetModelInput = z.infer<typeof sessionGetModelInputSchema>;
