/**
 * The `AGENTS.md` managed block: THE VEX MCP PROTOCOL, addressed to the agent.
 *
 * ONE CONTENT, ONE RENDERER, THREE CARRIERS. `AGENTS.md` is its home; `CLAUDE.md`
 * reaches it through the `@AGENTS.md` import the installer maintains, and the
 * per-agent context redirects the catalogue writes point at the same file. There
 * is no identity layer and no second wording: what an agent is told about Vex is
 * this text, and the handshake string shares its rules from one source
 * (`shared-usage.ts`).
 *
 * THE SECTIONS, in the order `renderStudioManagedBody` composes them:
 *
 *   1. What's new in Vex <version>   - `changelog.ts`, versioned, Next.js style
 *   2. This project                  - the level in force, wallets, agents, id
 *   3. How to work with Vex MCP      - discovery, names, outcomes, fees
 *   4. How to do the common jobs     - the task shapes, in MCP names
 *   5. Protocols available           - `protocol-blocks.ts`
 *   6. Your position                 - what each read tool actually knows
 *   7. Building on Vex MCP           - what an app inherits
 *   8. Reporting Vex bugs            - the bounty, and ASK FIRST
 *
 * WHY THE CHANGE LOG IS FIRST. Next.js-style: the first thing a reader (human or
 * model) sees is what moved since they last looked. A regeneration that changed
 * anything is visible before any of the unchanging prose, so a silent rewrite is
 * impossible to mistake for a file nobody touched.
 *
 * PURE, AND FACT-DRIVEN. Nothing here reads a database, a socket or the live
 * environment. Every project-specific value arrives as a `StudioProjectBrief`
 * that the privileged main process resolved, and every installation-specific
 * value as a `StudioInstallationEnvironment` the caller resolved: the tool
 * counts come from the LIVE inventory at render time and are never pinned
 * literals, the dates come from the project row, the version comes from the app,
 * and the change notes come from the durable provenance store. That is what
 * keeps the goldens byte-stable while the shipped file still tells the truth
 * about the machine it was written on.
 */

import { WALLET_INTENT_TTL_MS } from "../../tools/internal/wallet/send-types.js";
import { PREQUOTE_MAX_AGE_MS } from "../../tools/protocols/prequote/registry.js";
import {
  STUDIO_CHANGELOG_VERSION_LIMIT,
  studioChangelogWindow,
  studioTaggedHeading,
} from "./changelog.js";
import {
  STUDIO_FEE_NOTE,
  STUDIO_ONE_SOURCE_IN_BLOCK,
  STUDIO_SAFETY_RULES,
  STUDIO_USAGE_AMOUNTS,
  STUDIO_USAGE_FINDING_TOOLS,
  STUDIO_USAGE_PROJECT_SCOPE,
  STUDIO_USAGE_TRUNCATION,
  STUDIO_USAGE_UNAVAILABLE_TOOLS,
  renderStudioOutcomeVocabulary,
} from "./shared-usage.js";

/** Minutes a quote stays fresh, from the constant the gate itself enforces. */
const QUOTE_FRESH_MINUTES = String(Math.round(PREQUOTE_MAX_AGE_MS / 60_000));

/** Minutes a prepared wallet intent lives, from the constant that sets it. */
const INTENT_TTL_MINUTES = String(Math.round(WALLET_INTENT_TTL_MS / 60_000));

/**
 * A project's granted authority, in the DURABLE vocabulary.
 *
 * `full` is the stored value; the block RENDERS it as full access, which is what
 * it operationally means to an agent holding it. The stored word is not renamed
 * here, because it is a durable database value and this is display copy.
 */
export type StudioBriefPermission = "restricted" | "full";

/** One wallet the project is allowed to use, by family. */
export interface StudioBriefWallet {
  readonly family: "evm" | "solana";
  /** The on-chain address, resolved by main from the stored inventory id. */
  readonly address: string;
}

/** One protocol family and how many tools it exports, counted live. */
export interface StudioBriefProtocol {
  readonly name: string;
  readonly toolCount: number;
}

/**
 * How big the surface actually is, measured at render time.
 *
 * `alwaysLoadedCount` is the hot set a client sees in `tools/list` without
 * asking for anything; `searchableCount` is what `vex_ToolSearch` can reach,
 * and `protocols` breaks that down by family. All of it is counted from the
 * live inventory by the caller. A pinned number would be wrong the first time a
 * protocol lands, and an agent that believes a wrong number stops searching for
 * tools that exist.
 */
export interface StudioBriefInventory {
  readonly alwaysLoadedCount: number;
  /**
   * The `publicName` of every always-loaded tool, in inventory order, counted
   * and NAMED from the same live inventory as `alwaysLoadedCount`.
   *
   * Named rather than described, because "the core wallet tools" was a
   * description that had stopped being true: the always-loaded set also carries
   * swap, bridge, chain-read, token, research and social tools, and an agent
   * told it holds "wallet tools" searches for a swap tool it already has. The
   * roster is bounded by the hot set the server exports at all, so listing it
   * costs a few lines and removes the guess.
   */
  readonly alwaysLoadedNames: readonly string[];
  readonly searchableCount: number;
  readonly protocols: readonly StudioBriefProtocol[];
}

/** One entry in the block's PROJECT change log. */
export interface StudioChangeNote {
  /** The Vex version that wrote it, e.g. `0.2.6`. */
  readonly version: string;
  /** Calendar date, `YYYY-MM-DD`. Not a timestamp: this is a human log. */
  readonly date: string;
  /** What changed, one line, already written for a human reader. */
  readonly summary: string;
}

/**
 * How many project change-log entries the block keeps.
 *
 * A BOUND, not a truncation: the section says how many it retains and that
 * older entries are dropped, so a reader can tell exactly what is not there.
 * The full history is not hidden somewhere else either - it is a rolling log by
 * design, and the durable provenance store is its owner.
 */
export const STUDIO_CHANGE_NOTE_LIMIT = 8;

/** Everything the managed block needs about ONE project. */
export interface StudioProjectBrief {
  readonly projectName: string;
  /** The project's UUID: the value the bridge is bound to, shown for support. */
  readonly projectId: string;
  /** The running Vex version, read from the app. Never a hardcoded literal. */
  readonly vexVersion: string;
  readonly permission: StudioBriefPermission;
  /** Selected wallets, in family order. Empty means no wallet was selected. */
  readonly wallets: readonly StudioBriefWallet[];
  /** `YYYY-MM-DD` the project was created. */
  readonly createdOn: string;
  /** `YYYY-MM-DD` of the last scope edit (permission, wallets, agents). */
  readonly scopeUpdatedOn: string;
  /** The coding agents this project is configured for, by display name. */
  readonly agentNames: readonly string[];
  readonly inventory: StudioBriefInventory;
  /**
   * Newest first, already bounded to `STUDIO_CHANGE_NOTE_LIMIT` by the caller.
   * Passed in rather than trimmed here so the store and the file agree on which
   * entries exist.
   */
  readonly changeNotes: readonly StudioChangeNote[];
}

/**
 * Keep the newest `STUDIO_CHANGE_NOTE_LIMIT` notes, newest first.
 *
 * One owner for the bound, used by the store before it persists and by tests
 * that pin the bound. Dropping happens at the OLD end, which is the only end a
 * rolling log may drop from.
 */
export function boundStudioChangeNotes(
  notes: readonly StudioChangeNote[],
): readonly StudioChangeNote[] {
  return notes.slice(0, STUDIO_CHANGE_NOTE_LIMIT);
}

/** The title. */
export function renderStudioBlockTitle(brief: StudioProjectBrief): string {
  return `# Vex Studio - project "${brief.projectName}"`;
}

/**
 * Section 1: what changed in VEX, and what changed for THIS PROJECT.
 *
 * Two axes, deliberately under one heading. The Vex notes come from
 * `changelog.ts`, authored with the change and shipped with the build; the
 * project notes come from the durable provenance store and say what the user
 * did. A reader who has just been handed a regenerated file wants both, and
 * neither answers the other's question.
 */
export function renderStudioWhatsNew(brief: StudioProjectBrief): string {
  const lines = [
    `## What's new in Vex ${brief.vexVersion}`,
    "",
    `The notes below cover the last ${String(STUDIO_CHANGELOG_VERSION_LIMIT)} Vex versions that changed anything`,
    "an agent can see. A section or protocol block that one of them names carries",
    "its version beside its own heading.",
    "",
  ];

  const notes = studioChangelogWindow();
  if (notes.length === 0) {
    lines.push("- Nothing has changed in the agent-visible surface yet.");
  } else {
    for (const note of notes) {
      lines.push(
        `- **Vex ${note.version}, ${note.kind}** \`${note.subject}\`: ${note.text}`,
      );
    }
  }

  lines.push(
    "",
    "### This file",
    "",
    `Newest first. Vex keeps the last ${String(STUDIO_CHANGE_NOTE_LIMIT)} entries and drops older ones;`,
    "only change-log entries are ever dropped, and no other part of this section",
    "is trimmed. Every regeneration that changed anything adds a line here, so a",
    "Vex update or a settings edit is visible rather than a silent rewrite.",
    "",
    "THIS SECTION STAYS BOUNDED. A Vex update rewrites the whole managed block IN",
    "PLACE - it is never appended to - and the change log below keeps at most",
    `${String(STUDIO_CHANGE_NOTE_LIMIT)} entries. The file as a whole grows only through text the user adds`,
    "OUTSIDE the markers, which Vex never touches.",
    "",
  );
  if (brief.changeNotes.length === 0) {
    lines.push(
      `- ${brief.scopeUpdatedOn} · Vex ${brief.vexVersion} · initial render for this project`,
    );
  } else {
    for (const note of brief.changeNotes) {
      lines.push(`- ${note.date} · Vex ${note.version} · ${note.summary}`);
    }
  }
  return lines.join("\n");
}

/**
 * The permission paragraph, in the owner's own words (2026-09-03).
 *
 * THE TWO LEVELS ARE NOT TWO WORDINGS OF ONE RULE. Full access means the user's
 * standing permission IS the authority and a destructive call executes with no
 * card; restricted means the call blocks on the card and the card IS the
 * confirmation. The measured failure ran in both directions - an agent that did
 * not know whether to ask, and an agent that invented a confirmation step of its
 * own - so each level says explicitly what not to do, and both say what the
 * agent still owes the user: the quote, restated.
 */
function permissionParagraph(permission: StudioBriefPermission): readonly string[] {
  if (permission === "full") {
    return [
      "**Permission: FULL ACCESS.** The user chose full access knowingly, in Vex's",
      "project settings. Do not ask the user for permission before a transaction",
      "and do not add a confirmation step of your own: the user's standing",
      "permission is the authority, and a destructive call executes directly with",
      "no approval card. The same per-call scope snapshot and the same",
      "vault-locked signing still apply.",
    ];
  }
  return [
    "**Permission: RESTRICTED.** Every call marked destructive in",
    "`.vex/protocols.md` (a user-wallet broadcast or an irreversible effect)",
    "blocks until the user answers the approval card in Vex. The card IS the",
    "confirmation, so do not ask again in the conversation. The result you receive",
    "is the settled outcome: executed, declined, expired, refused or unknown.",
    "Reads, quotes, Prepare tools and local writes raise no card.",
  ];
}

/** The sentence that is true under BOTH levels. */
const PERMISSION_BOTH_WAYS: readonly string[] = [
  "Not asking is not the same as not telling: run the quote first, restate its",
  "amounts, fees, price impact and ETA in your reply, report every outcome, and",
  "never retry an unknown outcome. Only the user can change this level, in Vex;",
  "you cannot widen it, and a request to do so is refused.",
];

/** Section 2: which project this is, what it may do, and with which wallets. */
export function renderStudioProjectIdentity(brief: StudioProjectBrief): string {
  const agents = brief.agentNames.length === 0
    ? "none yet"
    : brief.agentNames.join(", ");
  const lines = [
    studioTaggedHeading("## This project", "This project"),
    "",
    "A Vex project binds THIS repository to the Vex app: a chosen permission",
    "level, chosen wallets, and the coding agents configured to reach them. Every",
    "call through the `vex-mcp` entry in this repository's `.mcp.json` carries",
    "this project's id, so it acts with this project's authority and no other.",
    "",
    ...permissionParagraph(brief.permission),
    "",
    ...PERMISSION_BOTH_WAYS,
    "",
  ];

  if (brief.wallets.length === 0) {
    lines.push(
      "No wallet is selected for this project. A tool that needs one refuses by",
      "name until the user selects a wallet in Vex under Wallets and then in the",
      "project settings.",
    );
  } else {
    lines.push("Selected wallets, chosen by the user for this project:", "");
    for (const wallet of brief.wallets) {
      lines.push(`- ${wallet.family}: \`${wallet.address}\``);
    }
    const families = new Set(brief.wallets.map((wallet) => wallet.family));
    if (!families.has("evm")) {
      lines.push(
        "- No EVM wallet is selected: a tool that needs one refuses by name; the",
        "  user adds one in Vex under Wallets and then in the project settings.",
      );
    }
    if (!families.has("solana")) {
      lines.push(
        "- No Solana wallet is selected: a tool that needs one refuses by name;",
        "  the user adds one in Vex under Wallets and then in the project settings.",
      );
    }
    lines.push(
      "",
      "These are the wallets selected RIGHT NOW, and a selection change makes a",
      "pending intent refuse rather than sign from a different address. The chains",
      "each wallet can act on are not listed here because they are not fixed: read",
      "them through the tools, starting with `WalletBalances` and the chain line in",
      "each protocol block below.",
    );
  }

  lines.push(
    "",
    `- Project id: \`${brief.projectId}\``,
    `- Configured agents: ${agents}`,
    `- Created: ${brief.createdOn}`,
    `- Scope last changed: ${brief.scopeUpdatedOn}`,
    "",
    "This scope is read FRESH ON EVERY CALL and the user can change it at any",
    "moment. The lines above are context, not a guarantee: read each result rather",
    "than assuming what a previous call was allowed to do.",
  );
  return lines.join("\n");
}

/** Section 3: the protocol itself - how to find, name, call and read Vex tools. */
export function renderStudioHowToWorkWithVexMcp(brief: StudioProjectBrief): string {
  const { inventory } = brief;
  const lines = [
    studioTaggedHeading("## How to work with Vex MCP", "How to work with Vex MCP"),
    "",
    "`vex` is a LOCAL MCP server inside the Vex desktop app, a self-custodial",
    "crypto agent. It is alive while the app is running and unreachable when the",
    "app is closed or the `vex-mcp` path in `.mcp.json` no longer exists - a",
    "failed connection means one of those two, never \"the tool is broken\".",
    "Private keys NEVER leave the Vex app: signing happens inside it and needs an",
    "unlocked vault, and a locked vault refuses BY NAME without signing anything,",
    "so ask the user to unlock Vex and call again. Every action is registered",
    "locally in Vex, where the user can read it back.",
    "",
    "### Finding a tool",
    "",
    `${String(inventory.alwaysLoadedCount)} tools are ALWAYS LOADED - they are in \`tools/list\` with full schemas,`,
    "and they are named in full below so you never search for one you already",
    `hold. Another ${String(inventory.searchableCount)} protocol tools across ${String(inventory.protocols.length)} protocols are in \`tools/list\``,
    "too, and your client may list those with DEFERRED schemas.",
    "",
    "Always loaded:",
    "",
  ];
  if (inventory.alwaysLoadedNames.length === 0) {
    lines.push("- (none exported by this build)");
  } else {
    for (const name of inventory.alwaysLoadedNames) {
      lines.push(`- ${name}`);
    }
  }
  lines.push(
    "",
    "Each protocol has its own block further down, with its chains, its tools and",
    "whether its provider key is configured here.",
    "",
    STUDIO_USAGE_FINDING_TOOLS,
    "",
    "`vex_ToolSearch` FINDS a tool: each row carries the `publicName`, the",
    "namespace, whether it mutates, a one-line summary and its availability. It",
    "carries no argument contract. `vex_ToolDescribe` returns the WHOLE contract",
    "of ONE tool: the full description, the input schema, the risk class, whether",
    "it raises the approval card, the Vex fee, what it returns, and which quote",
    "authorizes an execute.",
    "",
    STUDIO_USAGE_TRUNCATION,
    "",
    "No tool signs arbitrary calldata, and there is no generic execute tool to",
    "invent. The generic Prepare and Confirm pairs accept only a closed decode",
    "set. The decode set is CLOSED, and each Prepare description lists its own in",
    "full for its chain family.",
    "",
    "### Amounts",
    "",
    STUDIO_USAGE_AMOUNTS,
    "",
    "### What a result means",
    "",
    "Every refusal says what did not happen. Read the word it uses and place it:",
    "",
    renderStudioOutcomeVocabulary(),
    "",
    "### What Vex charges",
    "",
    STUDIO_FEE_NOTE,
    "",
    "### When a tool cannot run",
    "",
    STUDIO_USAGE_UNAVAILABLE_TOOLS,
    "",
    "### Scope",
    "",
    STUDIO_USAGE_PROJECT_SCOPE,
    "",
    "### The safety rules",
    "",
    STUDIO_SAFETY_RULES,
    "",
    STUDIO_ONE_SOURCE_IN_BLOCK,
  );
  return lines.join("\n");
}

/**
 * Section 4: the task shapes, in MCP names.
 *
 * ADAPTED FROM THE APP'S OWN PROMPT LAYER (`engine/prompts/task-shapes.ts`,
 * `buildTaskShapesPrompt`), which is what Vex's in-app agent is told. The
 * substance is that layer's - venue routing, the same-venue quote gate, the wrap
 * pair being 1:1 and fee-free, price protection binding the quote you were
 * SHOWN, never re-bridging a delivery that is still pending - restated in the
 * names an MCP client actually sees, which differ (`SwapQuote` / `SwapExecute`
 * rather than the in-app tool ids). It is authored rather than imported because
 * the prompt layer's text names in-app tools and branches on session
 * availability that has no meaning here; the two numbers that must not drift are
 * imported from the constants the gates enforce (`PREQUOTE_MAX_AGE_MS`,
 * `WALLET_INTENT_TTL_MS`) rather than written out.
 */
export const STUDIO_COMMON_JOBS_NOTE = [
  studioTaggedHeading("## How to do the common jobs", "How to do the common jobs"),
  "",
  `A quote is fresh for ${QUOTE_FRESH_MINUTES} minutes and authorizes only the execute in its OWN`,
  "pair, on the same venue, with identical parameters. A prepared wallet intent",
  `lives ${INTENT_TTL_MINUTES} minutes, is single-use, and is bound to the wallet that was selected`,
  "when it was prepared.",
  "",
  "### Balances",
  "",
  "`WalletBalances` with no arguments scans the selected wallets on every",
  "reachable chain; narrow it to one chain to confirm that a transfer landed. It",
  "is read-only and raises no card. Report the chains that errored rather than",
  "silently dropping them, and convert with `UnitsConvert`, never in your head.",
  "",
  "### Swap",
  "",
  "`TokenFind` resolves each token to a CONTRACT ADDRESS on the exact chain, then",
  "`SwapQuote`, then `SwapExecute` with identical parameters including the same",
  "slippage. That pair is the one you normally need: it routes EVM trades to",
  "KyberSwap and Solana to Jupiter itself. The Uniswap pair forces Uniswap, for a",
  "chain with a verified Vex deployment where KyberSwap cannot route. Restate the",
  "quote's expected output, price impact, gas and safety verdicts before",
  "executing. Slippage binds the quote you were SHOWN: the execute writes that",
  "floor into the calldata and refuses BY NAME rather than filling worse - so",
  "re-quote, and never raise slippage to force a trade through. A quote is",
  "refused at or above 15% price impact, and when the venue cannot price the",
  "output in USD. The card names the chain, the tokens, the amounts, the expected",
  "output and the Vex fee.",
  "",
  "### Bridge",
  "",
  "`BridgeQuote` then `BridgeExecute` is the normal pair, and it picks the venue",
  "itself: Khalani when it serves both sides, Relay otherwise, which is how",
  "Robinhood Chain routes. The quote authorizes `BridgeExecute` whichever venue",
  "it chose. `BridgeQuoteRelay` then `BridgeExecuteRelay` exists only to FORCE",
  "Relay, which is EVM-only. `amountRaw` is in RAW base units, read together with",
  "that token's decimals. A BRIDGE NEVER REPORTS SUCCESS: a deposit that",
  "broadcast is not a delivered bridge, and `pending` or `filled_unverified`",
  "means the delivery is still in motion. Follow it with `BridgeStatus`; do NOT",
  "re-bridge.",
  "",
  "### Send",
  "",
  "`WalletSendPrepare` records an intent that signs nothing and holds no key;",
  "`WalletSendConfirm` signs and broadcasts that exact intent. Ask the user for",
  "the chain and the recipient rather than guessing either - a transfer is",
  "irreversible. The card names chain, recipient, amount and token. Of the",
  "failure outcomes, `failed before broadcast` is the only one that is safe to",
  "prepare again.",
  "",
  "### Wrap",
  "",
  "A native to wrapped-native pair (ETH/WETH, BNB/WBNB, POL/WPOL, AVAX/WAVAX) is",
  "not a trade: `WalletWrapPrepare` then `WalletWrapConfirm`, exactly 1:1, no",
  "route, no slippage and NO Vex fee. `amountRaw` is in raw units.",
  "",
  "### An arbitrary transaction",
  "",
  "`WalletEvmTransactionPrepare` + `WalletEvmTransactionConfirm` on EVM, and",
  "`WalletSolanaTransactionPrepare` + `WalletSolanaTransactionConfirm` on Solana,",
  "are the only paths for something Vex has no dedicated tool for. Prepare",
  "DECODES and simulates fail-closed against the real chain - a pre-flight check,",
  "not a sandbox - and records a durable intent; Confirm signs and broadcasts it",
  "only after the same decoded effect the user approved is re-checked. The decode",
  "set is CLOSED, and router or aggregator calldata is deliberately outside it.",
  "The fee caps are yours to supply and are never derived from a network",
  "estimate; call `vex_ToolDescribe` on the Prepare tool for which caps it",
  "requires and how to obtain the current estimate.",
  "",
  "### A destructive tool with no quote counterpart",
  "",
  "Some destructive calls have nothing to quote - a rewards claim has no price,",
  "no size and no counterparty. State the expected effect from the READ tools",
  "first (what is claimable, what it is worth, what the gas will cost), say it to",
  "the user, and only then call. A claim is an ordinary approval-gated on-chain",
  "transaction that costs gas, so say so before claiming a dust balance.",
  "",
  "### Research",
  "",
  "Answer through all three layers before reporting: identity and discovery",
  "(which chain, which contract), depth and price sanity, then narrative and",
  "safety. If a layer is unreachable, continue through the others and say which",
  "layer was unavailable and why. DexScreener indexing lags by minutes to hours",
  "for brand-new tokens, so fresh discovery can precede indexed pair research.",
  "Name the exact chain and contract identity, the source freshness, the observed",
  "liquidity, the missing coverage, and whether the result is research or an",
  "executable quote. A provider label is not proof.",
].join("\n");

/** Section 6: what each read tool actually knows, and what it does not. */
export const STUDIO_YOUR_POSITION_NOTE = [
  studioTaggedHeading("## Your position", "Your position"),
  "",
  "You have no standing view of this user's money. Three read tools give three",
  "different, partial views, and mistaking one for another is how an agent",
  "reports a balance that stopped being true three turns ago.",
  "",
  "- `WalletBalances` is a LIVE SNAPSHOT at the moment of the call. Never carry a",
  "  balance across turns and never do arithmetic on a stale one; call it again.",
  "- `AgentScan` is the history of YOUR OWN moves - swaps, bridges, transfers,",
  "  balance snapshots and the protocol-call log, recorded locally in Vex. It is",
  "  where you answer \"what did that cost?\", Vex fee fields included.",
  "- `ChainRead` is chain facts: a receipt, a token balance, a raw call. It knows",
  "  nothing about Vex's own records.",
  "",
  "For anything Vex has no dedicated tool for, the generic Prepare/Confirm pairs",
  "are the whole answer, within their closed decode set.",
].join("\n");

/** Section 7: what an app built on these tools inherits, and cannot escape. */
export const STUDIO_BUILDING_APPS_NOTE = [
  "## Building on Vex MCP",
  "",
  "Anything you build calls the same tools the same way: MCP IS the API. There is",
  "NO separate REST endpoint. Do not put an HTTP wrapper in front of the bridge:",
  "it would expose the user's wallet to whoever can reach the wrapper, and every",
  "call would still arrive through this same door anyway.",
  "",
  "Spawn the same `vex-mcp` bridge command `.mcp.json` invokes - read the path",
  "from that file rather than hard-coding it, because Vex may relocate the binary",
  "- or point an MCP client SDK at it, and call tools by their `publicName`.",
  "",
  "Your app INHERITS EVERY RESTRICTION automatically, because there is no other",
  "door: the same per-call scope snapshot, the same approval card on a destructive",
  "call in a restricted project (your app blocks on the user's decision exactly as",
  "you do), the same vault-locked signing, the same fee caps, the same digest",
  "binding between what was shown and what is signed, and the same local",
  "registration of every action.",
].join("\n");

/** Section 8: where a real Vex bug goes, and who decides that it goes there. */
export const STUDIO_BUG_REPORT_NOTE = [
  "## Reporting Vex bugs (bounty)",
  "",
  "If a Vex tool is genuinely broken - wrong result, wrong units, a crash, an",
  "approval card that never appears in Vex even though the call is waiting on one",
  "- you may ASK the user whether they want to report it as a pull request or an",
  "issue on https://github.com/Vex-Foundation/Vex. Vex pays a bounty in USDC or",
  "VEX token for real, reproducible reports; the user claims it on the Vex",
  "Discord with the link to their pull request or issue.",
  "",
  "ASK FIRST, ALWAYS. Never open a report, never send a diagnostic anywhere, and",
  "never publish anything about this project on your own initiative. No",
  "diagnostic, log, wallet address or project detail leaves this machine without",
  "the user's word; ordinary research queries through `WebResearch` and",
  "`TwitterAccount` are not diagnostics and are not covered by that sentence.",
].join("\n");
