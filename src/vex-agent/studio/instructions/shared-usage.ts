/**
 * The Vex Studio USAGE NOTES: the text that is true of this server for every
 * project, every client and every environment.
 *
 * ONE HOME, TWO CONSUMERS. This text was authored inside
 * `mcp/instructions.ts`, where it is the tail of the `instructions` string the
 * MCP server sends at handshake. The `AGENTS.md` managed block needs the SAME
 * words - an agent that reads the repo file and an agent that reads the
 * handshake must not be told two different things about amounts, project scope
 * or what "unknown outcome" means. Copying it would have created exactly that
 * drift, so it was EXTRACTED here and both consumers import it.
 *
 * THE TWO CONSUMERS HAVE DIFFERENT BUDGETS, and that is why this module exports
 * NAMED PARTS rather than one string. The handshake is capped at 2,000 bytes
 * (owner decision O23) and cannot carry the whole outcome table or the whole fee
 * note; the managed block can. So the rules an agent must have before its first
 * call - approval, quote-first, amounts, how tools are named and found, what an
 * unavailable tool is - are shared VERBATIM by both, each side says so in one
 * sentence (`STUDIO_ONE_SOURCE_IN_HANDSHAKE` and `STUDIO_ONE_SOURCE_IN_BLOCK`),
 * and the longer tables live in the block with the handshake pointing at them.
 * Neither side restates the other in its own wording, which is the property that
 * keeps them from drifting.
 *
 * GENERIC ONLY, for the same reason the handshake string is: nothing here names
 * a project's permission or wallet selection, because either can change after
 * the text is delivered and an agent acting on stale authority text is the exact
 * failure the per-call scope snapshot exists to prevent.
 */

/**
 * The lead sentence and the three numbered rules: the handshake's first-512
 * character prefix, and the same words inside the managed block.
 *
 * RULE 1 IS THE ANSWER TO THE ONE QUESTION EVERY MEASURED SESSION ASKED. The
 * clarity review (2026-09-03) found that neither a fresh Claude Code session nor
 * an interactive one could tell whether a destructive call BLOCKS on the
 * approval card or returns a pending status to poll. Over MCP it blocks:
 * `vex-app/src/main/studio/approval-service.ts` waits on the broker and the
 * result the agent receives IS the settled outcome. The rule now says so, which
 * is what stops the second call the old wording invited.
 */
export const STUDIO_SAFETY_LEAD =
  "Vex moves REAL funds. Nothing here is a sandbox or testnet.";

export const STUDIO_RULE_APPROVAL =
  "1. APPROVAL: in a restricted project a destructive call BLOCKS until the "
  + "user answers the card in Vex; the result IS the settled outcome. Never "
  + "call again while one is unanswered, and never retry an UNKNOWN outcome.";

export const STUDIO_RULE_QUOTE_FIRST =
  "2. QUOTE FIRST: quote before any swap, bridge, trade or lend, then restate "
  + "amounts, fees, impact and ETA.";

export const STUDIO_RULE_AMOUNTS =
  "3. AMOUNTS: units are PER FIELD - human decimals or raw smallest units. "
  + "Read the field description; never guess.";

/** The lead plus the three rules, in the order both consumers render them. */
export const STUDIO_SAFETY_RULES = [
  STUDIO_SAFETY_LEAD,
  STUDIO_RULE_APPROVAL,
  STUDIO_RULE_QUOTE_FIRST,
  STUDIO_RULE_AMOUNTS,
].join("\n");

/**
 * The notes, as NAMED PARTS.
 *
 * `STUDIO_USAGE_NOTES` below joins them into the tail of the handshake string.
 * The parts exist because the `AGENTS.md` managed block presents the same facts
 * under the owner's section layout rather than as one paragraph block: it
 * composes THESE constants, so there is still exactly one source for the words
 * an agent acts on, and no consumer restates them in its own wording.
 *
 * FINDING TOOLS carries the client-name mapping because the measured failure was
 * a naming failure: Claude Code defers the protocol tools, exposes them as
 * `mcp__vex__<publicName>`, and loads their schema through its OWN ToolSearch.
 * The previous sentence "there is no activation step" was true of the SERVER and
 * false of the session the agent was actually in, and both measured sessions
 * named it as their most likely first-contact failure.
 */
export const STUDIO_USAGE_FINDING_TOOLS =
  "FINDING TOOLS: every tool is in tools/list. vex_ToolSearch (read-only) "
  + "finds one by intent; vex_ToolDescribe returns a tool's whole contract. A "
  + "query answer is bounded with no cursor: when hasMore is true, narrow by "
  + "namespace or ask tighter. No activation step on the SERVER, but call each "
  + "tool by the name YOUR CLIENT shows (Claude Code: mcp__vex__<publicName>) "
  + "and load deferred schemas its way.";

/**
 * The truncation note.
 *
 * MEASURED, not assumed: Claude Code cuts every MCP tool description at exactly
 * 2048 characters and appends an ellipsis plus "[truncated]" (clarity review
 * prompt 4; six of the 27 always-loaded descriptions were affected). The cut is
 * the CLIENT's and nothing is missing on the server. An agent that reads the
 * marker as "Vex sent me a broken description" stops instead of asking for the
 * rest, so the remedy is named here.
 */
export const STUDIO_USAGE_TRUNCATION =
  "TRUNCATED: a description ending \"[truncated]\" was cut by YOUR CLIENT "
  + "(Claude Code: 2048 chars), not the server - call vex_ToolDescribe.";

export const STUDIO_USAGE_AMOUNTS =
  "AMOUNTS: BOTH unit styles exist, so there is no server-wide rule. A "
  + "human-decimal field takes the user's amount as a string (\"1.5\", never wei "
  + "or lamports); a field in raw or atomic units takes an integer string in the "
  + "token's smallest units with its decimals. Never guess and never round; "
  + "convert with UnitsConvert.";

export const STUDIO_USAGE_PROJECT_SCOPE =
  "PROJECT SCOPE: each connection is bound to one Vex project; its permission "
  + "and wallet selection are read fresh on every call and can change at any "
  + "time. Read each result.";

export const STUDIO_USAGE_UNAVAILABLE_TOOLS =
  "UNAVAILABLE TOOLS: a missing provider key answers a typed "
  + "configuration_unavailable result naming the variable; vex_ToolSearch shows "
  + "available: false. It has NOT run. Report both names; do not work around it.";

/**
 * ERRORS, at the HANDSHAKE's budget.
 *
 * The lead is I-6c's fix: "every refusal says what did not happen" was false of
 * a result that says the transaction confirmed. What this note deliberately
 * does NOT carry is the per-word retry verdict, because the 2,000-byte budget
 * (owner decision O23) cannot hold the table AND the rules an agent needs
 * before its first call. That is placement, not truncation: the whole table,
 * with a verdict on every word, is in the managed block, and the sentence right
 * after this one (`STUDIO_ONE_SOURCE_IN_HANDSHAKE`) points at it. What this
 * note must still not do is FORBID the retry the tool descriptions themselves
 * ask for (live test 2026-09-03, p1.txt lines 11-13), so it forbids exactly the
 * resend that is always wrong and no other.
 */
export const STUDIO_USAGE_ERRORS =
  "ERRORS: every result says what happened. Bucket its word: nothing "
  + "happened, it happened, or unknown. Never resend an unknown one.";

/**
 * The one sentence each consumer says about the other.
 *
 * The measured complaint was not that the rules repeat - it was that a reader
 * could not tell WHICH copy was authoritative and therefore trusted neither ("I
 * cannot tell which is authoritative", clarity review section 6, p1 #21).
 * Naming the relationship costs one sentence and removes the doubt; deleting one
 * copy would not, because a client that never reads the repo file and a client
 * that never shows the handshake both exist.
 */
export const STUDIO_ONE_SOURCE_IN_BLOCK =
  "These are the same rules the vex MCP server sends at connection; both render "
  + "from one source, so neither overrides the other.";

export const STUDIO_ONE_SOURCE_IN_HANDSHAKE =
  "SAME SOURCE: AGENTS.md renders these rules from the same text, plus the "
  + "outcome table, the fee line and the task shapes.";

/**
 * WHERE ONE WIRE WORD BELONGS.
 *
 * Three buckets, and the bucket is the whole point: an agent that cannot place a
 * word does the wrong thing with at least one of them, and the expensive mistake
 * is resending something that already moved funds.
 */
export type StudioOutcomeBucket = "nothing" | "happened" | "unknown";

/**
 * One word an agent can actually receive, with the file that emits it.
 *
 * `emitter` is not decoration:
 * `__tests__/vex-agent/studio/outcome-vocabulary.test.ts` finds `literal` inside
 * `emitter` for every row, so a word that stopped being emitted - or was never
 * emitted - fails the suite rather than sitting in the instructions as a
 * fiction. The clarity review found the opposite failure, four words in the
 * instructions against a dozen on the wire, and a list nobody checks is how that
 * happens again.
 */
export interface StudioOutcomeWord {
  readonly word: string;
  readonly bucket: StudioOutcomeBucket;
  readonly meaning: string;
  /**
   * MAY THIS CALL BE MADE AGAIN, and under what condition.
   *
   * Per WORD, not per bucket, because the buckets are not uniform: a locked
   * vault and an expired card are both NOTHING HAPPENED and their verdicts
   * differ (fix the cause and call again; stop and report). The live test
   * (2026-09-03, p1.txt lines 11-17) measured an agent unable to reconcile the
   * flat "never call it twice" with the tool text that tells it to unlock Vex
   * and call again, so the verdict now travels with the word it belongs to.
   */
  readonly retry: string;
  /** Repo-relative path of a module that emits it. */
  readonly emitter: string;
  /** The exact text that must be present in `emitter`. */
  readonly literal: string;
}

export const STUDIO_OUTCOME_WORDS: readonly StudioOutcomeWord[] = [
  {
    word: "declined",
    bucket: "nothing",
    meaning: "a person said no in Vex",
    retry: "call the tool again only if the user asks for it again",
    emitter: "src/vex-agent/mcp/server-result.ts",
    literal: "A person DECLINED this action in Vex.",
  },
  {
    word: "expired",
    bucket: "nothing",
    meaning: "nobody decided the card in time",
    retry: "stop and report; quote and call again only when the user asks",
    emitter: "src/vex-agent/mcp/server-result.ts",
    literal: "This action EXPIRED before anyone decided it in Vex.",
  },
  {
    word: "refused",
    bucket: "nothing",
    meaning: "VEX refused it before it ran, and the sentence names why",
    retry: "call again once the named cause is fixed",
    emitter: "src/vex-agent/mcp/server-result.ts",
    literal: "This action was REFUSED by Vex before it ran.",
  },
  {
    word: "cancelled",
    bucket: "nothing",
    meaning:
      "the call was abandoned before Vex ran it - YOUR client aborted it, or "
      + "Vex locked, quit or lost the connection; the sentence names which",
    retry: "call again once the named cause is fixed",
    emitter: "vex-app/src/main/studio/approval-service.ts",
    literal: "This call was cancelled before Vex ran it",
  },
  {
    word: "dispatch_failed",
    bucket: "nothing",
    meaning: "approved, but Vex could not carry it out, and it was NOT retried",
    retry: "call again once the named cause is fixed",
    emitter: "src/vex-agent/mcp/server-result.ts",
    literal: "This action was approved but Vex could not carry it out",
  },
  {
    word: "refused by name",
    bucket: "nothing",
    meaning: "a precondition failed before anything was signed; the message names which",
    retry: "fix the named precondition, then call again",
    emitter: "src/vex-agent/tools/registry/wallet.ts",
    literal: "refused BY NAME",
  },
  {
    word: "failed before broadcast",
    bucket: "nothing",
    meaning: "nothing was sent, so no transaction exists",
    retry: "prepare again and call again",
    emitter: "src/vex-agent/tools/internal/wallet/send/finalize.ts",
    literal: "failed before broadcast",
  },
  {
    word: "in_flight",
    bucket: "nothing",
    meaning:
      "a bridge on this route is ALREADY running; this attempt recorded and "
      + "signed nothing",
    retry: "no; follow the earlier bridge instead of starting another",
    emitter: "src/vex-agent/tools/protocols/relay/handlers/bridge/results.ts",
    literal: "status: \"in_flight\"",
  },
  {
    word: "configuration_unavailable",
    bucket: "nothing",
    meaning: "a provider key is missing; the result names the variable",
    retry: "not until the user sets the named variable in Vex",
    emitter: "src/vex-agent/mcp/availability.ts",
    literal: "configuration_unavailable",
  },
  {
    word: "available: false",
    bucket: "nothing",
    meaning: "the same state on a vex_ToolSearch row, with the variable named",
    retry: "not until the user sets the named variable in Vex",
    emitter: "src/vex-agent/mcp/tool-search-export.ts",
    literal: "available: false",
  },
  {
    word: "confirmed",
    bucket: "happened",
    meaning: "the transaction is on chain and Vex recorded it",
    retry: "never",
    emitter: "src/vex-agent/tools/protocols/uniswap/handlers/swap/finalize-confirmed.ts",
    literal: "\"confirmed\"",
  },
  {
    word: "confirmed_unrecorded",
    bucket: "happened",
    meaning: "on chain, but Vex could not match its own record",
    retry: "never",
    emitter: "src/vex-agent/tools/protocols/uniswap/handlers/swap/finalize-confirmed.ts",
    literal: "confirmed_unrecorded",
  },
  {
    word: "reverted on-chain",
    bucket: "happened",
    meaning: "a real transaction that paid gas and moved nothing",
    retry: "only on the user's word: a new attempt is a new transaction that costs gas again",
    emitter: "src/vex-agent/tools/registry/wallet-wrap.ts",
    literal: "reverted on-chain",
  },
  {
    word: "failed (bridge)",
    bucket: "happened",
    meaning:
      "the deposit is on chain and Khalani reports that the destination "
      + "amount did NOT arrive",
    retry: "never; read `BridgeStatus` on the orderId and tell the user",
    emitter: "src/vex-agent/tools/protocols/khalani/handlers/bridge-poll.ts",
    literal: "Khalani reports this bridge as failed",
  },
  {
    word: "refunded (bridge)",
    bucket: "happened",
    meaning:
      "the deposit is on chain, nothing was delivered, and the funds are on "
      + "their way back to the refund address",
    retry: "never; money back is not a delivered bridge",
    emitter: "src/vex-agent/tools/protocols/khalani/handlers/bridge-poll.ts",
    literal: "Khalani reports this bridge as refunded",
  },
  {
    word: "refund_pending (bridge)",
    bucket: "happened",
    meaning: "the deposit is on chain and a refund is in flight; nothing was delivered",
    retry: "never; Vex tracks it, so read `BridgeStatus` instead",
    emitter: "src/vex-agent/tools/protocols/khalani/handlers/bridge-poll.ts",
    literal: "refund_pending",
  },
  {
    word: "vexStatus: confirmed (bridge)",
    bucket: "happened",
    meaning:
      "the ONLY state that means DELIVERED: Vex verified the destination fill "
      + "itself, and `BridgeStatus` and the `AgentScan` row say so",
    retry: "never",
    emitter: "src/vex-agent/db/repos/agent-activity/bridge-lifecycle.ts",
    literal: "SET status = 'confirmed', confirmed_at = NOW()",
  },
  {
    word: "indeterminate",
    bucket: "unknown",
    meaning: "Vex dispatched it and cannot prove what happened",
    retry: "never; open Vex and read the approval first",
    emitter: "src/vex-agent/mcp/server-result.ts",
    literal: "DO NOT RETRY THIS CALL.",
  },
  {
    word: "broadcast with confirmation UNKNOWN",
    bucket: "unknown",
    meaning: "the transaction exists and may still settle",
    retry: "never; read it with `ChainRead` action `tx_receipt`",
    emitter: "src/vex-agent/tools/registry/wallet-wrap.ts",
    literal: "broadcast with confirmation UNKNOWN",
  },
  {
    word: "pending",
    bucket: "unknown",
    meaning: "money is in motion and the outcome is not yet known",
    retry: "never; read the outcome rather than calling again",
    emitter: "src/vex-agent/engine/core/tool-display-status.ts",
    literal: "PENDING_STATUS = \"pending\"",
  },
  {
    word: "filled_unverified",
    bucket: "unknown",
    meaning: "the bridge provider reports a fill Vex has NOT verified",
    retry: "never; do NOT re-bridge, follow it with `BridgeStatus`",
    emitter: "src/vex-agent/tools/protocols/khalani/handlers/bridge-poll.ts",
    literal: "filled_unverified",
  },
];

const BUCKET_HEADINGS: Readonly<Record<StudioOutcomeBucket, string>> = {
  nothing: "NOTHING HAPPENED - no funds moved and no transaction exists",
  happened: "IT HAPPENED - a transaction exists on chain",
  unknown: "UNKNOWN - it may have moved funds, so NEVER resend it",
};

const BUCKET_ORDER: readonly StudioOutcomeBucket[] = ["nothing", "happened", "unknown"];

/**
 * The outcome table: every wire word once, under its bucket, WITH its retry
 * verdict.
 *
 * The verdict is per word rather than per bucket because the words inside one
 * bucket do not share one: `refused` (a locked vault) is fixed and called
 * again, `expired` is reported and dropped. A single rule over the bucket was
 * what the measured agent could not reconcile with the tool descriptions.
 */
export function renderStudioOutcomeVocabulary(): string {
  const lines: string[] = [];
  for (const bucket of BUCKET_ORDER) {
    lines.push(`${BUCKET_HEADINGS[bucket]}:`, "");
    for (const entry of STUDIO_OUTCOME_WORDS.filter((row) => row.bucket === bucket)) {
      lines.push(`- \`${entry.word}\` - ${entry.meaning}. CALL AGAIN? ${entry.retry}.`);
    }
    lines.push("");
  }
  lines.push(
    "Every word above is one this server or a tool actually emits; there is no",
    "`executed` and no `unknown` on the wire, and a word that stops being",
    "emitted is removed from this table rather than left here to be looked for.",
    "",
    "An unknown outcome is resolved by READING, never by calling again:",
    "`ChainRead` action `tx_receipt` for an EVM hash, `BridgeStatus` for a",
    "KHALANI orderId, `AgentScan` view `transactions` for a Relay requestId, a",
    "Solana signature, or anything else Vex recorded.",
  );
  return lines.join("\n");
}

/**
 * Vex's own fee, in one place.
 *
 * EVERY CLAIM IS CROSS-CHECKED against the constants by
 * `__tests__/vex-agent/studio/instructions-fee-note.test.ts`: the rate against
 * `KYBERSWAP_FEE_BPS`, `UNISWAP_FEE_BPS`, `JUPITER_SWAP_FEE_BPS`,
 * `BRIDGE_FEE_BPS`, `TRENCH_FEE_BPS`, `POOLS_FEE_BPS` and `WALLET_TX_FEE_BPS`,
 * and the free paths against the modules that keep them free (neither the wrap
 * lane nor the send lane imports a fee module at all). The clarity review found
 * the fee described per tool, contradicted between tools, and mentioned NOWHERE
 * in the instructions, so an agent guessed at it in every measured session.
 */
export const STUDIO_FEE_NOTE = [
  "Vex charges 25 bps (0.25%) of the INPUT asset at the moment the operation",
  "succeeds - inside the route for a swap, or as a separate transfer once the",
  "operation confirms - and never on a failed, reverted or never-broadcast",
  "attempt.",
  "",
  "- Swaps (`SwapQuote`/`SwapExecute` on KyberSwap and Solana):",
  "  EMBEDDED IN THE QUOTE, so the quoted output is already net of it and you",
  "  never add it on top when reporting what was spent. The Uniswap pair takes",
  "  the same 25 bps from the input, but Uniswap's routers carry no fee field,",
  "  so it is Vex's own transfer leg after the swap confirms: the swap spends",
  "  `amountIn` minus 25 bps and that 25 bps is transferred to Vex, and the two",
  "  together are exactly `amountIn`, which is what the user is debited.",
  "- Bridges (`BridgeQuote`/`BridgeExecute` and the Relay pair): a SEPARATE",
  "  transfer that runs only after the deposit lands, so a bridge that does not",
  "  happen is never charged.",
  "- Trench curve trades: a SEPARATE transfer after the trade confirms, 25 bps",
  "  of the ETH sent on a buy or of the ETH received on a sale.",
  "- The generic EVM pair: 25 bps of that transaction's own native `valueWei`,",
  "  as a separate transfer after it confirms. A zero-value transaction - every",
  "  ERC-20 transfer and every approve - pays NOTHING, and nothing is charged",
  "  when the fee would cost more to collect than it is worth.",
  "- Trench and pools.fun launches: 25 bps of the native value the launch sends.",
  "",
  "FREE: every read, quote, preview and research call; `WalletSendPrepare` and",
  "`WalletSendConfirm`; the wrap pair, which is exactly 1:1; every Pendle and",
  "Morpho action; and the Solana lend, borrow and prediction actions, which",
  "carry no Vex fee either. Each protocol block below repeats its own fee in",
  "one line, so a namespace is never left to be guessed at. Network gas,",
  "the venue's own protocol fee and bridge relayer costs are NOT Vex's fee -",
  "never conflate them when the user asks what something cost.",
].join("\n");

/**
 * The usage notes, WITHOUT the separator that joins them to the safety rules.
 *
 * The composed handshake value is pinned literally by
 * `__tests__/vex-agent/studio/instructions-extraction.test.ts`, so an edit here
 * is a deliberate contract change written out by hand rather than a regenerated
 * baseline.
 */
export const STUDIO_USAGE_NOTES = [
  STUDIO_USAGE_FINDING_TOOLS,
  STUDIO_USAGE_TRUNCATION,
  STUDIO_USAGE_AMOUNTS,
  STUDIO_USAGE_PROJECT_SCOPE,
  STUDIO_USAGE_UNAVAILABLE_TOOLS,
  STUDIO_USAGE_ERRORS,
  STUDIO_ONE_SOURCE_IN_HANDSHAKE,
].join("\n");

/** The separator between the safety rules and the usage notes. */
export const STUDIO_INSTRUCTIONS_SEPARATOR = "\n\n";
