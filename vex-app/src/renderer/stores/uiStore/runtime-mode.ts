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
 * The desk's ephemeral bookkeeping: where "← Agent" returns to, and which
 * trading session the desk resumes with next time it is entered.
 */
export interface LighterModeState {
  /** The mode and session to restore when the desk is left. */
  readonly lighterReturn: {
    readonly mode: PersistedRuntimeMode;
    readonly sessionId: string | null;
  } | null;
  /** The desk's own active session, remembered across desk visits. */
  readonly lighterSessionId: string | null;
}

/**
 * The state patch for a mode switch. Entering the desk parks the shell's
 * selection and swaps in the desk's session; leaving does the reverse. A
 * switch that neither enters nor leaves the desk is the plain slot write.
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
      activeSessionId: state.lighterSessionId,
    };
  }
  if (state.runtimeMode === "lighter") {
    return {
      runtimeMode: next,
      lighterSessionId: state.activeSessionId,
      activeSessionId: state.lighterReturn?.sessionId ?? null,
      lighterReturn: null,
    };
  }
  return { runtimeMode: next };
}
