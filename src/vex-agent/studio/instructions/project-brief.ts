/**
 * The PROJECT-DEPENDENT half of the `AGENTS.md` managed block.
 *
 * `shared-usage.ts` holds what is true of this server for every project. This
 * module holds what is true of ONE project, and it owns the SECTION ORDER the
 * owner co-designed on 2026-08-25 (see `renderStudioProjectSections`): change
 * log first, then what the project is, then the authority it holds, then what
 * the server is, then the tool surface, the safety rules, how to build on the
 * tools, and finally how to report a Vex bug.
 *
 * WHY THE CHANGE LOG IS AT THE TOP. Next.js-style: the first thing a reader
 * (human or model) sees is what moved since they last looked. A regeneration
 * that changed anything is visible before any of the unchanging prose, so a
 * silent rewrite is impossible to mistake for a file nobody touched.
 *
 * PURE, AND FACT-DRIVEN. Nothing here reads a database, a socket or the live
 * inventory. Every project-specific value arrives as a `StudioProjectBrief`
 * that the privileged main process resolved: the tool counts - overall AND per
 * protocol - come from the LIVE inventory at render time and are never pinned
 * literals, the dates come from the project row, the version comes from the
 * app, and the change notes come from the durable provenance store. That is
 * what keeps the goldens byte-stable while the shipped file still tells the
 * truth about the machine it was written on.
 */

import {
  STUDIO_USAGE_AMOUNTS,
  STUDIO_USAGE_ERRORS,
  STUDIO_USAGE_FINDING_TOOLS,
  STUDIO_USAGE_UNAVAILABLE_TOOLS,
} from "./shared-usage.js";

/**
 * A project's granted authority, in the DURABLE vocabulary.
 *
 * `full` is the stored value; the block RENDERS it as "autonomous", which is
 * what it operationally means to an agent holding it. The stored word is not
 * renamed here, because it is a durable database value and this is display copy.
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
  readonly searchableCount: number;
  readonly protocols: readonly StudioBriefProtocol[];
}

/** One entry in the block's change log. */
export interface StudioChangeNote {
  /** The Vex version that wrote it, e.g. `0.2.6`. */
  readonly version: string;
  /** Calendar date, `YYYY-MM-DD`. Not a timestamp: this is a human log. */
  readonly date: string;
  /** What changed, one line, already written for a human reader. */
  readonly summary: string;
}

/**
 * How many change-log entries the block keeps.
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

/** Section 1: the title. */
export function renderStudioBlockTitle(brief: StudioProjectBrief): string {
  return `# Vex Studio - project "${brief.projectName}"`;
}

/**
 * Section 2: the change log, FIRST.
 *
 * The first render says so explicitly rather than showing an empty list: "no
 * entries" and "nothing has ever changed" are different statements, and only
 * one of them is true of a file that has just been created.
 */
export function renderStudioChangeLog(brief: StudioProjectBrief): string {
  const lines = [
    "## Change log (this file)",
    "",
    `Newest first. Vex keeps the last ${String(STUDIO_CHANGE_NOTE_LIMIT)} entries and`,
    "drops older ones; nothing else is hidden. Every regeneration that changed",
    "anything adds a line here, so a Vex update or a settings edit is visible rather",
    "than a silent rewrite.",
    "",
    "THIS FILE DOES NOT GROW. A Vex update regenerates this managed section IN",
    "PLACE - the block is rewritten, never appended to - and the bounded change log",
    "above is what keeps the file the same size across updates. Text outside the",
    "markers is never touched.",
    "",
  ];
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

/** Section 3: what a Vex project IS, and which one this is. */
export function renderStudioProjectIdentity(brief: StudioProjectBrief): string {
  const agents = brief.agentNames.length === 0
    ? "none yet"
    : brief.agentNames.join(", ");
  return [
    "## This project",
    "",
    "A Vex project binds THIS repository to the Vex app: a chosen permission level,",
    "chosen wallets, and the coding agents that were configured to reach them. The",
    "binding is what makes a tool call from this folder act with this project's",
    "authority and no other.",
    "",
    `- Name: ${brief.projectName}`,
    `- Created: ${brief.createdOn}`,
    `- Project id: ${brief.projectId}`,
    `- Configured agents: ${agents}`,
  ].join("\n");
}

/** Section 4: the authority, with the dates it was granted on. */
export function renderStudioAuthorityBrief(brief: StudioProjectBrief): string {
  const lines = [
    `## Your authority - as of ${brief.scopeUpdatedOn}`,
    "",
    brief.permission === "restricted"
      ? "- Permission: RESTRICTED. Every mutation waits for the user's approval card in"
        + " Vex. It can be approved, declined, or expire, and nothing executes until"
        + " they answer."
      : "- Permission: AUTONOMOUS. Mutations execute immediately, with no per-call"
        + " approval card. The user is trusting you with real money: quote first, show"
        + " what you got, and stop at anything you were not asked to do.",
  ];

  if (brief.wallets.length === 0) {
    lines.push(
      "- Wallets: none selected. Fund-moving calls have no wallet to act with until",
      "  the user selects one in Vex.",
    );
  } else {
    for (const wallet of brief.wallets) {
      lines.push(`- Wallet (${wallet.family}): ${wallet.address}`);
    }
  }

  lines.push(
    `- Granted: ${brief.createdOn}`,
    `- Last updated: ${brief.scopeUpdatedOn}`,
    "",
    "This scope is read FRESH ON EVERY CALL and the user can change it at any",
    "moment. The lines above are context, not a guarantee: read each result rather",
    "than assuming what a previous call was allowed to do.",
  );
  return lines.join("\n");
}

/** Section 5: what the server is and where the keys live. */
export const STUDIO_WHAT_VEX_MCP_IS = [
  "## What Vex MCP is",
  "",
  "`vex` is a LOCAL MCP server inside the Vex desktop app, a self-custodial crypto",
  "agent. It is alive while the app is running and unreachable when the app is",
  "closed - a failed connection means \"start Vex\", not \"the tool is broken\".",
  "",
  "This repository connects to it through the `vex-mcp` bridge named in this",
  "project's agent config, so every call arrives already bound to this project.",
  "Private keys NEVER leave the Vex app: signing happens inside it and requires an",
  "unlocked vault, and every action is registered locally in Vex where the user can",
  "read it back.",
].join("\n");

/** Section 6: the surface, with LIVE counts, and how to navigate it. */
export function renderStudioToolSurface(brief: StudioProjectBrief): string {
  const { inventory } = brief;
  const lines = [
    "## The tool surface and how to navigate it",
    "",
    `${String(inventory.alwaysLoadedCount)} tools are ALWAYS LOADED: \`vex_ToolSearch\``,
    "plus the core wallet tools. Another",
    `${String(inventory.searchableCount)} protocol tools across`,
    `${String(inventory.protocols.length)} protocols are discoverable through`,
    "`vex_ToolSearch`, which is read-only and runs nothing.",
    "",
    STUDIO_USAGE_FINDING_TOOLS,
    "",
    "There is NO generic execute tool - do not invent one; this surface does not",
    "have it.",
    "",
    "Protocols and their tool counts:",
    "",
  ];
  if (inventory.protocols.length === 0) {
    lines.push("- (none exported by this build)");
  } else {
    for (const protocol of inventory.protocols) {
      lines.push(`- ${protocol.name}: ${String(protocol.toolCount)}`);
    }
  }
  lines.push(
    "",
    // The amounts discipline, the four failure words and the unavailable-tool
    // contract come VERBATIM from the shared usage notes - the same words the
    // MCP handshake sends. One source, so a file and a handshake can never tell
    // an agent two different things about units or about what "declined" means.
    STUDIO_USAGE_AMOUNTS,
    "",
    STUDIO_USAGE_ERRORS,
    "",
    STUDIO_USAGE_UNAVAILABLE_TOOLS,
    "",
    "Every protocol, tool and argument contract: `.vex/protocols.md`.",
  );
  return lines.join("\n");
}

/** Section 8: what an app built on these tools inherits, and what it cannot escape. */
export const STUDIO_BUILDING_APPS_NOTE = [
  "## Building applications on these tools",
  "",
  "Anything you build calls the same tools the same way: MCP IS the API. There is",
  "NO separate REST endpoint, and writing an HTTP wrapper around a wallet would",
  "only be a way around the door.",
  "",
  "Spawn the same `vex-mcp` bridge command this project's agent config already",
  "invokes, or point an MCP client SDK at it, and call tools by their `publicName`.",
  "",
  "Your app INHERITS EVERY RESTRICTION automatically, because there is no other",
  "door: the same per-call scope snapshot, the same approval card on a mutation in",
  "a restricted project (your app waits on the user's decision exactly as you do),",
  "the same vault-locked signing, and the same local registration of every action.",
  "",
  "SIGNING ANYTHING VEX HAS NO DEDICATED TOOL FOR. Two generic pairs exist for",
  "exactly this: `WalletEvmTransactionPrepare` + `WalletEvmTransactionConfirm` on",
  "EVM, and `WalletSolanaTransactionPrepare` + `WalletSolanaTransactionConfirm` on",
  "Solana. Prepare DECODES and simulates an arbitrary transaction fail-closed - it",
  "signs nothing, holds no key - and records a durable intent; Confirm signs and",
  "broadcasts that intent only after the same decoded effect the user approved",
  "revalidates. So an app can drive ANY contract call or transfer through the",
  "user's own wallets while every safety property still holds: the approval card in",
  "a restricted project, the digest binding between what was shown and what is",
  "signed, and the fee caps.",
].join("\n");

/** Section 9: where a real Vex bug goes, and who decides that it goes there. */
export const STUDIO_BUG_REPORT_NOTE = [
  "## Reporting Vex bugs (bounty)",
  "",
  "If a Vex tool is genuinely broken - wrong result, wrong units, a crash, an",
  "approval that never arrives - you may ASK the user whether they want to report",
  "it as a pull request or issue on https://github.com/Vex-Foundation/Vex. Vex pays",
  "a bounty in USDC or VEX token for real, reproducible reports; the user claims it",
  "on Discord with the link to their PR.",
  "",
  "ASK FIRST, ALWAYS. Never open a report, never send a diagnostic anywhere, and",
  "never publish anything about this project on your own initiative. Nothing about",
  "this machine leaves it without the user's word.",
].join("\n");
