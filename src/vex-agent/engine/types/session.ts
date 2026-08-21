/**
 * Session axes — the immutable per-session discriminators.
 *
 * Implementation detail of `engine/types.ts`; import from there.
 */

// ── Session axes ────────────────────────────────────────────────

/**
 * Engine-level session discriminator.
 *
 * `"agent"` is a one-shot conversational session (may use tools, may execute
 * tx subject to `Permission`). `"mission"` is a goal-driven session that
 * runs in a loop (agent self-schedules wake via `LoopDefer`).
 *
 * The session-level `mode` column on `sessions` is the source of truth;
 * this type is propagated through `EngineContext`, `InternalToolContext`,
 * and `ProtocolExecutionContext` so tool visibility and prompt shaping can
 * branch on it. Immutable per session.
 */
export type SessionKind = "agent" | "mission";

/**
 * Session-scoped approval policy. Replaces the previous `LoopMode` tri-state
 * (`off|restricted|full`) — the `off` arm collapses into `mode === "agent"`
 * (no loop), and `restricted | full` becomes its own immutable axis.
 *
 *  - `"restricted"` — every mutating tool requires user approval (default)
 *  - `"full"` — mutating tools auto-execute without approval
 *
 * Immutable per session; set at session creation.
 */
export type Permission = "restricted" | "full";
