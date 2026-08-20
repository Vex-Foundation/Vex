/**
 * Stop-availability read for the composer's Stop key: maps the runtime-state
 * query into a three-state answer so the caller can fail toward SHOWING the
 * control when the engine's answer is genuinely unknown.
 */

import type { Result } from "@shared/ipc/result.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";

/**
 * Three states, never two.
 *
 * Collapsing "we do not know" into "not stoppable" is the failure this type
 * exists to prevent: a DB hiccup or an errored read would hide the Stop key
 * from work that is running and spending money. So the unknown state is
 * explicit, and the caller fails toward SHOWING the control.
 *
 * A merely PENDING refetch is NOT unknown - the query keeps serving the last
 * value, so the known answer stands until a new one lands.
 *
 * A persistent DB outage therefore leaves Stop visible. That is the declared
 * conservative posture: a Stop that cannot be applied already surfaces its
 * failure notice rather than lying, and the state clears on the next
 * successful `stoppable:false`.
 */
export type StopAvailability =
  | "known-available"
  | "known-unavailable"
  | "unknown";

/** Exactly what `useRuntimeState` serves: the envelope, or nothing read yet. */
export type RuntimeStateQueryData = Result<RuntimeStateDto> | undefined;

/**
 * UNKNOWN means "we ASKED the engine and did not get an answer" - an errored
 * read, at either the transport or the Result layer. Two other absences are
 * deliberately NOT unknown, and both distinctions are load-bearing:
 *
 * NO SESSION. The welcome composer runs with `sessionId === null`, which
 * DISABLES the runtime query, so its data stays `undefined` forever. Read as
 * unknown, that turned Send into a permanent Stop button and the user could
 * never send a first message. A session that does not exist yet is not an
 * unanswered question: there is provably nothing running in it.
 *
 * NOT ASKED YET. On the very first paint the query is still in flight. Read
 * as unknown, EVERY session open would show Stop where Send belongs until an
 * IPC round-trip completed - a guaranteed wrong affordance on the app's most
 * common interaction, to cover a renderer that mounted inside a live slice.
 * That case is covered by something better: a session-lease ACQUIRE
 * publishes a control-state event (both claim primitives do), which
 * invalidates this query and refetches within milliseconds. The push spine
 * closes the window; guessing "stoppable" for everyone is not the way to
 * close it.
 *
 * An ERRORED read has no such correction - nothing will push it back to the
 * truth - which is exactly why it, and only it, fails open.
 */
export function readStopAvailability(
  sessionId: string | null,
  state: RuntimeStateQueryData,
  isError: boolean,
): StopAvailability {
  if (sessionId === null || sessionId.length === 0) return "known-unavailable";
  if (isError) return "unknown";
  if (state === undefined) return "known-unavailable";
  if (!state.ok) return "unknown";
  return state.data.stoppable ? "known-available" : "known-unavailable";
}
