/**
 * Runtime-mode slot for the shell's top-level dispatch: the Agent shell, the
 * Studio workspace, and the Lighter trading desk. `AppShell` mounts a
 * different sidebar / centre / rail for each value.
 *
 * Lighter is a DESK, not a place you leave the app in: the header toggle stays
 * Agent | Studio, the desk is entered from the BOOK rail (or "light it up") and
 * left through its own "← Agent" control, and a relaunch never lands on it -
 * `persistRuntimeMode` demotes it before the slot is written.
 */

export type RuntimeMode = "agent" | "studio" | "lighter";

/** The modes a relaunch may resume into. */
export type PersistedRuntimeMode = Exclude<RuntimeMode, "lighter">;

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "agent";

/**
 * A persisted runtime mode, coerced from user-writable storage.
 *
 * The slot is persisted (Studio is where you left it), and localStorage is
 * untrusted input, so the value is narrowed to the CLOSED union here rather
 * than trusted because it sits on the whitelist. Anything else - a hand-edited
 * string, a number, an object, or a "lighter" that should never have been
 * written - degrades to the launch default instead of reaching the shell's
 * top-level dispatch as an unknown mode.
 */
export function coerceRuntimeMode(value: unknown): PersistedRuntimeMode {
  return value === "studio" || value === "agent" ? value : "agent";
}

/** The value written to storage: the desk is never a resume point. */
export function persistRuntimeMode(mode: RuntimeMode): PersistedRuntimeMode {
  return mode === "lighter" ? "agent" : mode;
}

/**
 * The desk's ephemeral bookkeeping: where "← Agent" returns to, and the
 * session the desk falls back to when the shell brought none of its own.
 */
export interface LighterModeState {
  /** The mode to restore when the desk is left. */
  readonly lighterReturn: {
    readonly mode: PersistedRuntimeMode;
    readonly sessionId: string | null;
  } | null;
  /** The last session the desk was used with; only a COLD entry reads it. */
  readonly lighterSessionId: string | null;
}

/**
 * The state patch for a mode switch.
 *
 * THE CONVERSATION FOLLOWS THE TRADER. The desk used to park the shell's
 * session on the way in and swap its own one back, which made the agent and
 * the desk two separate correspondents: you asked the agent about a market,
 * opened the chart it was describing, and found a stranger in the rail. They
 * are one surface. A session carried in keeps its whole history, and the desk
 * rail hands it the environment, the market and the chart's own indicators on
 * top, so entering the desk ADDS what the agent can see instead of resetting
 * who it is.
 *
 * `lighterSessionId` survives as the COLD-entry fallback only: entering the
 * desk with nothing selected resumes the last session traded from, rather
 * than opening on the starters. Leaving keeps whatever is active - there is
 * one selection now, and it is the trader's.
 */
export function transitionRuntimeMode(
  state: LighterModeState & {
    readonly runtimeMode: RuntimeMode;
    readonly activeSessionId: string | null;
  },
  next: RuntimeMode,
): Partial<LighterModeState & { runtimeMode: RuntimeMode; activeSessionId: string | null }> {
  if (next === state.runtimeMode) return {};
  if (next === "lighter") {
    return {
      runtimeMode: "lighter",
      lighterReturn: {
        mode: persistRuntimeMode(state.runtimeMode),
        sessionId: state.activeSessionId,
      },
      // Carry the conversation in. Only an empty selection takes the desk's
      // own last session.
      activeSessionId: state.activeSessionId ?? state.lighterSessionId,
    };
  }
  if (state.runtimeMode === "lighter") {
    return {
      runtimeMode: next,
      lighterSessionId: state.activeSessionId,
      // The session leaves with the trader: it is the same conversation on
      // both sides, and dropping it here would be the old swap in reverse.
      activeSessionId: state.activeSessionId,
      lighterReturn: null,
    };
  }
  return { runtimeMode: next };
}
