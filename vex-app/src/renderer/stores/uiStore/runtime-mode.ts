/**
 * Runtime-mode seam for the future vex-studio surface. A plain union slot in
 * the uiStore - no UI logic reads it yet; the studio workspace will be
 * mounted by a top-level dispatch on this value.
 */

export type RuntimeMode = "agent" | "studio";

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "agent";

/**
 * A persisted runtime mode, coerced from user-writable storage.
 *
 * The slot is persisted (Studio is where you left it), and localStorage is
 * untrusted input, so the value is narrowed to the CLOSED union here rather
 * than trusted because it sits on the whitelist. Anything else - a hand-edited
 * string, a number, an object - degrades to the launch default instead of
 * reaching the shell's top-level dispatch as an unknown mode.
 */
export function coerceRuntimeMode(value: unknown): RuntimeMode {
  return value === "studio" || value === "agent" ? value : DEFAULT_RUNTIME_MODE;
}
