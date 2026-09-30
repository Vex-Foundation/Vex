/**
 * Tool-discovery performance switches (Kairos Phase 6: P-2, P-3, T-5).
 *
 * Every switch here is a NAMED CONSTANT whose OFF value restores the exact
 * behaviour that shipped before it. The tests that prove "OFF equals old" and
 * the ones that measure the ON value both read the constants below, so the
 * switch that is exercised is the switch that ships.
 *
 * None of them touches a gate. Admission to the injected lane, the approval
 * gate and the prequote gate are unchanged in both positions: these switches
 * only decide WHICH read schemas sit in the tools array and how long a
 * discovered schema stays there.
 */

/**
 * P-2: how many RANKED rows of one `ToolSearch` query are recorded (and so
 * injected as real schemas on the next request).
 *
 * `null` is OFF: every ranked row the query returned is recorded, which is
 * what shipped before this switch. A number records only the top N; the other
 * rows are still SHOWN (name, summary, match evidence) and tagged so the model
 * knows a select makes them callable.
 *
 * SHIPS OFF. Measured (`discovery-payload-bytes.test.ts`): ON cuts the
 * injected bytes of 8 representative queries from 204,910 to 73,343 (-64%),
 * but on the 109-query lexical seed eval 16 of the 66 queries that hit in the
 * top five hit at rank 3-5 (24%), and each of those would cost an extra select
 * round under N = 2. The dense eval the app actually runs is pending (it needs
 * pgvector and an embeddings endpoint), so "not worse" is not shown.
 * See `P2_INJECT_TOP_N_WHEN_ON` for the value to flip to.
 */
export const TOOLSEARCH_INJECT_TOP_N: number | null = null;

/** The P-2 value the plan names, kept next to the switch it would set. */
export const P2_INJECT_TOP_N_WHEN_ON = 2;

/**
 * P-3: LRU-by-use cap for the session's discovered working set.
 *
 * `null` is OFF: the FIFO cap `MAX_DISCOVERED_TOOLS_PER_SESSION` (40) applies
 * exactly as before. A number turns on the LRU policy in
 * `discovered-tools.ts`: a call through the injected lane refreshes a tool's
 * recency, the least recently USED tool is displaced first, a tool pinned by a
 * pending approval or a prepared action is never displaced, and the round
 * being recorded is never displaced (so the cap is SOFT: a single round larger
 * than the cap keeps every row it returned, as the D2 whole-namespace flow
 * requires).
 *
 * SHIPS OFF: no eval in this repo measures what a smaller working set costs in
 * re-select rounds, and the contract ships an unproven change OFF.
 */
export const DISCOVERED_TOOL_LRU_CAP: number | null = null;

/** The P-3 value the plan names, kept next to the switch it would set. */
export const P3_LRU_CAP_WHEN_ON = 16;

/**
 * T-5: preload the audited core market reads (`core-market-reads.ts`) into
 * every session outside mission setup, so a price question can read DexScreener
 * on its FIRST round instead of after one or two `ToolSearch` rounds.
 *
 * `false` is OFF: nothing is callable before discovery, exactly as before.
 *
 * SHIPS OFF, for two measured reasons, both owner calls rather than builder
 * calls:
 *   1. Owner decision D-DS9-R (`fresh-model-surface-names.test.ts` lane 1): a
 *      fresh session's tools array may not teach a protocol name it cannot
 *      call. The preloaded `dexscreener__pairs_search` description names
 *      `dexscreener__token_pairs_list` and `dexscreener__pair_get` names
 *      `dexscreener__trades_list`, and neither is preloaded (their schemas are
 *      47 KB and 14 KB). Flipping this switch fails that lane on exactly those
 *      two names until the owner amends the doctrine or the descriptions.
 *   2. Bytes: the two schemas are a stable ~17.8 KB block in EVERY request's
 *      tools array, including sessions that never read the market
 *      (`discovery-payload-bytes.test.ts`). A price question saves one to two
 *      full rounds and the 5-schema injection its ToolSearch would have cost.
 * The round cut itself is proven by `core-market-reads-rounds.test.ts`.
 */
export const CORE_MARKET_READS_PRELOADED = false;
