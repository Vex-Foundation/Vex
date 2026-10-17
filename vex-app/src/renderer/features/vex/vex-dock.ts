/**
 * VEX DOCKS (docs/design/R3-MINIMAL.md sections 2.3 and 11): the welcome has
 * no right sidebar, Vex stands in its centre; on the first message she docks
 * into the Vex sidebar, which plays her open episode as it first shows (the
 * token turns flat, her beam rises, she assembles). Under reduced motion she
 * simply appears there (the still frame skips the episode).
 *
 * The welcome and the sidebar never stand at once (the shell mounts the
 * sidebar only off the welcome), so the welcome leaves a note that she stood
 * there, and the sidebar that mounts next takes it. A plain module flag, read
 * once per mount: no store key, nothing persisted.
 */

let stoodOnWelcome = false;

/** The welcome showed her hologram: the next Vex sidebar docks her. */
export function noteVexOnWelcome(): void {
  stoodOnWelcome = true;
}

/** Whether she stood on the welcome since the sidebar last took the note. */
export function vexDockPending(): boolean {
  return stoodOnWelcome;
}

/** The sidebar took the note (its plate plays the dock once). */
export function takeVexDock(): void {
  stoodOnWelcome = false;
}
