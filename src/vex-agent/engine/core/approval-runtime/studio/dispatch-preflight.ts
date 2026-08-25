/**
 * The Vex Studio DISPATCH-PREFLIGHT REGISTRY - one slot, one owner, ZERO
 * imports.
 *
 * ## Why this is its own module and not a `let` in `dispatch-gate.ts`
 *
 * The predicate is registered by the MAIN PROCESS, because main is the only
 * party that can observe the condition it answers (a durable generation advance
 * that never committed, and whether this process has finished starting Studio).
 * `dispatch-gate.ts` imports the database client through its repo, so a main
 * process that wanted to register the predicate had to reach it through a
 * DYNAMIC import to keep `pg` out of its static graph - and a dynamic import is
 * fallible and asynchronous.
 *
 * That asynchrony was the defect. Between main's modules loading and the
 * registration landing, NOTHING was registered, and the default with nothing
 * registered is ALLOW. A registration that failed left ALLOW in place for the
 * whole session while main's own readiness flag said the opposite.
 *
 * Holding the slot in a module with no imports at all makes the registration
 * SYNCHRONOUS and infallible: main imports this file statically (the same
 * discipline `terminal-state.ts` already uses) and sets DENY before any
 * fallible initialization runs. There is no window left to lose.
 *
 * ## DEFAULT WHEN NOTHING IS REGISTERED: ALLOW
 *
 * The durable CAS is the authority for every case in which the advance
 * committed, which is all of them but the one above. A headless engine with no
 * main process has no failed advance to cover, and defaulting to refuse would
 * break every dispatch in that configuration for a condition that cannot arise
 * there. `null` therefore means "no main process is speaking", never "deny".
 *
 * This module deliberately does NOT decide what an absent or throwing predicate
 * means for a dispatch. It stores and returns. `studioDispatchPreflightAllows`
 * in `dispatch-gate.ts` owns that policy, including the logging a pure module
 * cannot do.
 */

/** `true` means "this dispatch may proceed as far as the durable fence". */
export type StudioDispatchPreflight = () => boolean;

let registered: StudioDispatchPreflight | null = null;

/**
 * Install the predicate, or clear it back to the headless default with `null`.
 *
 * Last writer wins, on purpose: the bridge sets DENY at setup, swaps in the
 * real predicate when its barrier registers, and sets DENY again at teardown.
 * Those are three points in ONE owner's lifecycle, not three owners.
 */
export function setStudioDispatchPreflight(
  preflight: StudioDispatchPreflight | null,
): void {
  registered = preflight;
}

/** The registered predicate, or `null` when nobody has registered one. */
export function readStudioDispatchPreflight(): StudioDispatchPreflight | null {
  return registered;
}
