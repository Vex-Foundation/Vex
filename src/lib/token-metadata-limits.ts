/**
 * Length caps for the metadata `create()` writes ON-CHAIN, PERMANENTLY.
 *
 * PROVENANCE: MEASURED ON-CHAIN, bisected via free `eth_estimateGas` on
 * 2026-08-02 at block ~26003783 (harness: `agents_dm/trench-live/limit-probe.mts`).
 * The Diamond hardcodes the limits in facet bytecode — a storage scan found no
 * limit slots, so a runtime reader is impossible and these measured constants
 * ARE the live data. `create()` reverts `invalid name/symbol/image/desc` past:
 * name 18, symbol 18, description 512, links 4.
 *
 * WHY ONE DEFINITION. Three surfaces cap the same text: the agent runtime
 * (`trench.launch_execute` validation and the `trench.launch_preview` dry-run)
 * and the privileged IPC contract the renderer form is built from
 * (`vex-app/src/shared/schemas/token-launch.ts`). They were hand-duplicated, and
 * a looser cap on any one of them turns a chain revert into a vague
 * `gas_unestimable` instead of a refusal that names the field.
 *
 * THE SYMBOL CAP IS DELIBERATELY TIGHTER THAN THE CHAIN'S. The chain reverts a
 * symbol past 18 characters; Vex refuses past 16. That is a product decision,
 * not a measurement, and it is stated here rather than silently unified with
 * the name cap so no later reader "corrects" it back to 18.
 *
 * WHY THIS LIVES IN `src/lib`. Same reason as its sibling
 * `token-metadata-text-policy.ts`: the renderer and `shared` may not import
 * `src/vex-agent`, and the sanctioned cross-boundary path is `@vex-lib` ->
 * `../src/lib` for modules that are PURE. This module is therefore deliberately
 * dependency-free — it imports nothing, reads no environment, and touches no
 * key, DB or network. Keep it that way, or it stops being importable by the
 * renderer (`vex-app/scripts/check-process-boundaries.mjs`).
 */

/** Chain limit: `create()` reverts `invalid name` past 18 characters. */
export const TOKEN_METADATA_NAME_MAX = 18;

/**
 * Vex's cap, 16. The CHAIN's own limit is 18 (measured); Vex is deliberately
 * stricter here. See the module header before changing it.
 */
export const TOKEN_METADATA_SYMBOL_MAX = 16;

/** Chain limit: `create()` reverts `invalid desc` past 512 characters. */
export const TOKEN_METADATA_DESCRIPTION_MAX = 512;

/** Chain limit: `create()` accepts at most 4 links. */
export const TOKEN_METADATA_LINKS_MAX = 4;

/**
 * Per-link length cap. Not a measured chain revert: a URL this long is already
 * outside anything a launch form legitimately carries, and every link is written
 * on-chain immutably, so the cap is Vex's own and applies on all three surfaces.
 */
export const TOKEN_METADATA_LINK_LENGTH_MAX = 128;
