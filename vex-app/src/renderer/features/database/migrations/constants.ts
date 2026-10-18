/**
 * Constants for the migrations bootstrap surface — the auto-advance
 * delay for the `noop` (schema already up to date) path and the
 * bounded applied-history buffer. (The NOTARY-era "Step X of N"
 * counter is retired with the Chronos rebrand.)
 */

/**
 * Auto-advance delay for the noop branch — visual confirmation tile
 * shows briefly before the orchestrator transitions to the wizard.
 * Existing tests pin this constant; do not raise without updating them.
 */
export const NOOP_AUTO_ADVANCE_MS = 500;

/**
 * Bounded buffer for the list of migration files that completed before
 * a failure. Surfaced by ErrorBody's "Show N applied before failure"
 * disclosure. 50 lines is comfortably larger than any realistic
 * migration count.
 */
export const APPLIED_HISTORY_MAX = 50;
