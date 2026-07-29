/**
 * `EngineEventsBridge` — main -> renderer push events from the agent
 * runtime spine (engine).
 *
 * Naming follows the `EV.engine.<topic>` channel namespace and the
 * `window.vex.<domain>.on<Topic>` convention used for docker / database
 * progress streams. Each subscription returns an idempotent unsubscribe
 * function; the renderer must call it on cleanup (puzzle 02 mounts the
 * hook in `SessionPanel`, which unsubscribes on unmount).
 *
 * Renderer NEVER reconstructs message rows from the event payload. The
 * event is purely a refresh signal — the DB row is fetched through the
 * existing `messages.getTail` IPC after invalidation.
 */

import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import type { TranscriptAppendEvent } from "@shared/schemas/messages.js";
import type { MissionUpdateEvent } from "@shared/schemas/mission-update.js";
import type { ControlStateEvent } from "@shared/schemas/runtime.js";
import type { StreamDeltaEvent } from "@shared/schemas/stream.js";

export interface EngineEventsBridge {
  /**
   * Subscribe to `EV.engine.transcriptAppend` events. The handler is
   * invoked once per committed `messages` INSERT for any session — the
   * renderer hook filters by `event.sessionId`.
   *
   * Returns an idempotent unsubscribe function.
   */
  readonly onTranscriptAppend: (
    cb: (event: TranscriptAppendEvent) => void,
  ) => () => void;

  /**
   * Subscribe to `EV.engine.streamDelta` events — the EPHEMERAL,
   * sanitized token/tool/usage preview emitted once per provider chunk
   * during a turn (puzzle 09). The renderer hook filters by
   * `event.sessionId`, renders a live preview, and discards it once the
   * canonical message arrives via `onTranscriptAppend`. Deltas are never
   * the source of truth and carry no raw tool arguments.
   *
   * Returns an idempotent unsubscribe function.
   */
  readonly onStreamDelta: (
    cb: (event: StreamDeltaEvent) => void,
  ) => () => void;

  /**
   * Subscribe to `EV.engine.controlState` events — broadcast after a
   * committed runtime control transition (pause / stop / resume /
   * wake-cancel) or a lease release (puzzle 03). The renderer hook
   * (`useControlStateLiveSync`) filters by `event.sessionId` and
   * invalidates that session's runtime-state + pending-approvals
   * queries, so composer gating and the inline approval card refresh
   * without relying on polling alone. The payload carries only a lease
   * summary — never owner IDs.
   *
   * Returns an idempotent unsubscribe function.
   */
  readonly onControlState: (
    cb: (event: ControlStateEvent) => void,
  ) => () => void;

  /**
   * Subscribe to `EV.engine.error` events — emitted when a turn, mission,
   * wake tick, compact job or approval resume FAILS. Before this channel
   * existed a background failure died in a log and a provider 429 reached
   * the user as "Unable to process the message".
   *
   * The payload is BOUNDED CODES ONLY: a user-facing `category`, the
   * provider's error type/class, an HTTP status and a retry hint. It never
   * carries provider prose — the raw message stays server-side, the same
   * doctrine that keeps `memory_jobs.last_error` out of every DTO. The
   * renderer maps `category` to copy.
   *
   * `event.sessionId` is NULLABLE, and the null is a positive claim that the
   * failure is system-wide (memory maintenance owns no session) rather than an
   * unknown. Subscribers must therefore route on it explicitly: a
   * session-scoped consumer IGNORES null events, and the app-wide surface
   * takes ONLY those. Treating null as a wildcard would render a global
   * failure inside one conversation's banner.
   *
   * Returns an idempotent unsubscribe function.
   */
  readonly onEngineError: (
    cb: (event: EngineErrorEvent) => void,
  ) => () => void;

  /**
   * Subscribe to `EV.engine.missionUpdate` events — broadcast after a
   * COMMITTED change to the mission surface (draft patch, readiness flip,
   * contract acceptance, approval enqueue). The renderer invalidates the
   * matching queries; it never reconstructs a draft or an approval row from
   * the payload, which carries only ids, a kind and a timestamp.
   *
   * Returns an idempotent unsubscribe function.
   */
  readonly onMissionUpdate: (
    cb: (event: MissionUpdateEvent) => void,
  ) => () => void;
}
