/**
 * Trench Express: the fixed chain facts the HISTORY readers still need.
 *
 * Trench Express was retired by migration `108_trench_express_retirement.sql`.
 * No tool, manifest, handler, client or write path for it exists any more. What
 * survives is this module and its two decoders, because the durable tables
 * still hold confirmed Trench rows (`agent_activity` legs with
 * `protocol='trench'`, `launched_tokens` rows with `launchpad='trench_express'`,
 * `token_launch_intents` rows with `protocol='trench'`) and those rows must
 * stay readable and reconcilable forever.
 *
 * Nothing here may grow a write path. These are read-only constants for
 * decoding receipts that were mined before the retirement.
 */

/** The verified Diamond (trading facet) address on RBC 4663. */
export const LEGACY_TRENCH_DIAMOND_ADDRESS = "0x3857c6c4FE93Abb40945dfc8B9d690384cBae014";

/** RBC chain id the retired launchpad ran on. */
export const LEGACY_TRENCH_CHAIN_ID = 4663;
