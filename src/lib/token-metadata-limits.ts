/**
 * Length and size caps for the metadata a token launch writes PERMANENTLY.
 *
 * PROVENANCE: MEASURED ON-CHAIN, bisected via free `eth_estimateGas` on
 * 2026-08-02 at block ~26003783 (harness: `agents_dm/trench-live/limit-probe.mts`)
 * against the Trench Express Diamond, which hardcoded its limits in facet
 * bytecode. That protocol was retired by migration 108, but the numbers stay:
 * they are the caps Vex applies to token metadata on every launchpad, and a
 * measured ceiling does not stop being a sensible one because the venue that
 * revealed it is gone. What changed is that they are now VEX's product caps
 * rather than one chain's revert boundary, and this header is the record of it.
 *
 * WHY ONE DEFINITION. Two surfaces cap the same text: the privileged IPC
 * contract the renderer form is built from (`vex-app/src/shared/schemas/
 * pools-launch.ts`) and the renderer form itself. They were hand-duplicated,
 * and a looser cap on either turns a launchpad refusal into a vague failure
 * instead of one that names the field.
 *
 * THE SYMBOL CAP IS DELIBERATELY TIGHTER THAN THE NAME CAP. The measurement put
 * both at 18; Vex refuses a symbol past 16. That is a product decision, not a
 * measurement, and it is stated here rather than silently unified so no later
 * reader "corrects" it back to 18.
 *
 * WHAT WAS DELETED WITH TRENCH EXPRESS: the description, link-count and
 * link-length caps. They existed for the `create()` calldata that carried a
 * description and a link array on-chain; pools.fun takes neither through this
 * contract, so after migration 108 they had no consumer left and are gone
 * rather than kept "just in case" (`.claude/CLAUDE.md`).
 *
 * WHY THIS LIVES IN `src/lib`. Same reason as its sibling
 * `token-metadata-text-policy.ts`: the renderer and `shared` may not import
 * `src/vex-agent`, and the sanctioned cross-boundary path is `@vex-lib` ->
 * `../src/lib` for modules that are PURE. This module is therefore deliberately
 * dependency-free - it imports nothing, reads no environment, and touches no
 * key, DB or network. Keep it that way, or it stops being importable by the
 * renderer (`vex-app/scripts/check-process-boundaries.mjs`).
 */

/** Measured revert boundary, now Vex's own cap: at most 18 characters. */
export const TOKEN_METADATA_NAME_MAX = 18;

/**
 * Vex's cap, 16. The measured limit was 18; Vex is deliberately stricter here.
 * See the module header before changing it.
 */
export const TOKEN_METADATA_SYMBOL_MAX = 16;

/**
 * The hard ceiling on the bytes of the SMALL SQUARE DERIVATIVE the desktop
 * image ladder produces. 20 KiB.
 *
 * WHAT IT IS NOW, and what it was. It was the ceiling on image bytes Trench
 * Express wrote inside `create()` calldata, where every byte was gas the user
 * paid. Migration 108 retired that protocol and nothing signs over image bytes
 * any more: pools.fun hosts images off-chain on its own backend (it accepted a
 * 2,104,822-byte PNG, measured), so a launch publishes the stored ORIGINAL and
 * this number never bounds it.
 *
 * The derivative itself survives as the locker grid's THUMBNAIL, and so does
 * this ceiling, because it is durable: `launch_images.onchain_byte_length`
 * carries a CHECK against it (migration 083) over rows already written.
 * Renaming the column is out of scope for the retirement; the honest reading of
 * both is "the bound the stored derivative was written under".
 *
 * The desktop ladder aims LOWER (20 000, with headroom -
 * `vex-app/src/shared/schemas/images.ts`); this is the ceiling nothing may
 * cross, not the budget the ladder targets.
 */
export const TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES = 20_480;
