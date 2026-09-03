/**
 * The `AGENTS.md` managed block: idempotency, drift, and "the rest of the file
 * is the user's".
 *
 * The risk here is not formatting. It is that Vex silently overwrites a
 * human's edit, or silently fails to notice one. So the assertions are about
 * the DRIFT CONTRACT: the hash in the opening marker is the digest of the body
 * Vex wrote, an edited body is detected as drifted, a drifted body survives an
 * ordinary merge untouched, and only an explicit Repair replaces it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { STUDIO_SAFETY_PREFIX } from "@vex-agent/mcp/instructions.js";
import {
  STUDIO_PROTOCOLS_DOC_PATH,
  inspectStudioManagedBlock,
  mergeStudioManagedBlock,
  removeStudioManagedBlock,
  renderStudioManagedBlock,
  renderStudioManagedBody,
  studioManagedBodyHash,
} from "@vex-agent/studio/installer/render/managed-block.js";
import {
  STUDIO_CHANGE_NOTE_LIMIT,
  boundStudioChangeNotes,
} from "@vex-agent/studio/instructions/project-brief.js";
import {
  STUDIO_CLAUDE_MD_IMPORT,
  claudeMdImportsAgents,
  mergeClaudeMdImport,
  removeClaudeMdImport,
  renderFreshClaudeMd,
} from "@vex-agent/studio/installer/render/claude-md.js";
import {
  STUDIO_FEE_NOTE,
  STUDIO_ONE_SOURCE_IN_BLOCK,
  STUDIO_USAGE_AMOUNTS,
  STUDIO_USAGE_FINDING_TOOLS,
  STUDIO_USAGE_TRUNCATION,
  STUDIO_USAGE_UNAVAILABLE_TOOLS,
} from "@vex-agent/studio/instructions/shared-usage.js";
import { STUDIO_MANAGED_BLOCK_MAX_BYTES } from "@vex-agent/studio/installer/render/managed-block.js";
import { STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT } from "./render-fixtures.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const USER_TEXT_BEFORE = "# Contributing\n\nRun the tests before you push.\n";
const USER_TEXT_AFTER = "\n## House style\n\nNo em dashes.\n";

function textOf(result: ReturnType<typeof mergeStudioManagedBlock>): string {
  if (result.status !== "rendered") {
    throw new Error(`expected rendered bytes, got ${result.status}`);
  }
  return result.text;
}

describe("the managed block's content", () => {
  it("reuses the safety prefix and the shared usage notes rather than restating them", () => {
    const body = renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);
    expect(body).toContain(STUDIO_SAFETY_PREFIX);
    // The notes reach the block as their NAMED PARTS (the block presents them
    // under the owner's section layout), so each part is asserted verbatim.
    expect(body).toContain(STUDIO_USAGE_FINDING_TOOLS);
    expect(body).toContain(STUDIO_USAGE_AMOUNTS);
    expect(body).toContain(STUDIO_USAGE_TRUNCATION);
    expect(body).toContain(STUDIO_USAGE_UNAVAILABLE_TOOLS);
    expect(body).toContain(STUDIO_FEE_NOTE);
    // A19: the block SAYS which other copy exists, instead of leaving the
    // reader to decide which of two identical-looking texts is authoritative.
    expect(body).toContain(STUDIO_ONE_SOURCE_IN_BLOCK);
  });

  it("stays inside its byte bound, and says which lever shortens it", () => {
    // The bound is new (2026-09-03): the block sits in a file every agent loads
    // on every turn, so its size is a cost the user pays per request. Codex
    // bounds its own AGENTS.md the same way (`project_doc_max_bytes`). Nothing
    // is ever CUT to fit - exceeding this fails here, and the shortening
    // decision is the protocol blocks first.
    const bytes = Buffer.byteLength(
      renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT),
      "utf8",
    );
    expect(bytes).toBeLessThanOrEqual(STUDIO_MANAGED_BLOCK_MAX_BYTES);
  });

  it("stays inside its byte bound for the LONGEST project half the store can hand it", () => {
    // The fixture is a two-wallet project with two short notes, so a green run
    // on it says nothing about the project a real user can build. The project
    // half is bounded by its own contracts, and this brief sits on every one of
    // them: eight selected wallets (four per family), and STUDIO_CHANGE_NOTE_LIMIT
    // notes each at the 400-character summary bound the durable row enforces
    // (`project_change_notes.summary` CHECK, migration 089). Nothing enforces
    // the bound at runtime, so a render that only fits the fixture would ship
    // an oversized block to exactly the user with the most in the project.
    const summary = "s".repeat(400);
    const longest = {
      ...STUDIO_TEST_BRIEF,
      wallets: [
        ...Array.from({ length: 4 }, (_, index) => ({
          family: "evm" as const,
          address: `0x${String(index + 1).repeat(40)}`,
        })),
        ...Array.from({ length: 4 }, (_, index) => ({
          family: "solana" as const,
          address: `So${String(index + 1).repeat(40)}`,
        })),
      ],
      changeNotes: Array.from({ length: STUDIO_CHANGE_NOTE_LIMIT }, (_, index) => ({
        version: `0.9.${String(9 - index)}`,
        date: `2026-08-${String(28 - index).padStart(2, "0")}`,
        summary,
      })),
    };
    const bytes = Buffer.byteLength(
      renderStudioManagedBody(longest, STUDIO_TEST_ENVIRONMENT),
      "utf8",
    );
    expect(bytes).toBeLessThanOrEqual(STUDIO_MANAGED_BLOCK_MAX_BYTES);
  });

  it("points at the rich protocol declarations instead of inlining them", () => {
    expect(renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT)).toContain(STUDIO_PROTOCOLS_DOC_PATH);
  });

  it("says it is generated and what editing it does", () => {
    expect(renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT)).toContain("generated by Vex");
    expect(renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT)).toContain("drift");
  });

  it("is deterministic: the same inputs give the same bytes", () => {
    expect(renderStudioManagedBlock(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT)).toBe(renderStudioManagedBlock(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT));
  });

  it("records the digest of its own body in the opening marker", () => {
    const block = renderStudioManagedBlock(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);
    const expected = studioManagedBodyHash(renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT));
    // The marker carries the Vex version alongside the drift hash.
    expect(
      block.startsWith(
        `<!-- vex:studio:begin vex=${STUDIO_TEST_BRIEF.vexVersion} hash=${expected} -->\n`,
      ),
    ).toBe(true);
    expect(block.endsWith("<!-- vex:studio:end -->\n")).toBe(true);
  });
});

describe("merging the managed block into AGENTS.md", () => {
  it("appends to a file that has none, leaving the user's text first", () => {
    const merged = textOf(mergeStudioManagedBlock(USER_TEXT_BEFORE, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }));
    expect(merged.startsWith(USER_TEXT_BEFORE)).toBe(true);
    expect(merged).toContain(renderStudioManagedBlock(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT));
  });

  it("creates the file content when there is none at all", () => {
    const merged = textOf(mergeStudioManagedBlock("", STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }));
    expect(merged).toBe(renderStudioManagedBlock(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT));
  });

  it("is idempotent: merging an up-to-date file changes nothing", () => {
    const once = textOf(mergeStudioManagedBlock(USER_TEXT_BEFORE, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }));
    expect(mergeStudioManagedBlock(once, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }).status).toBe("unchanged");
  });

  it("replaces the block in place, preserving text on BOTH sides", () => {
    const stale = `${USER_TEXT_BEFORE}<!-- vex:studio:begin hash=${studioManagedBodyHash("old body")} -->\nold body\n<!-- vex:studio:end -->\n${USER_TEXT_AFTER}`;
    const merged = textOf(mergeStudioManagedBlock(stale, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }));

    expect(merged.startsWith(USER_TEXT_BEFORE)).toBe(true);
    expect(merged.endsWith(USER_TEXT_AFTER)).toBe(true);
    expect(merged).not.toContain("old body");
    expect(merged).toContain(renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT));
  });
});

describe("drift", () => {
  const installed = textOf(mergeStudioManagedBlock(USER_TEXT_BEFORE, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }));
  const edited = installed.replace(
    "This repository is connected to Vex",
    "This repository is TOTALLY connected to Vex",
  );

  it("reports an untouched block as intact and up to date", () => {
    // The ENVIRONMENT is stated here for the same reason the render tests state
    // it: `installed` was rendered with the fixture environment, and
    // `inspectStudioManagedBlock` compares against a fresh render. Letting the
    // comparison resolve the live `process.env` would make "is this block
    // current?" depend on which provider keys the machine running the suite
    // happens to have set.
    const state = inspectStudioManagedBlock(installed, STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);
    expect(state).toEqual({ kind: "intact", upToDate: true });
  });

  it("reports an absent block as absent, not as drifted", () => {
    expect(inspectStudioManagedBlock(USER_TEXT_BEFORE, STUDIO_TEST_BRIEF)).toEqual({ kind: "absent" });
  });

  it("detects a human edit inside the fence", () => {
    const state = inspectStudioManagedBlock(edited, STUDIO_TEST_BRIEF);
    expect(state.kind).toBe("drifted");
    if (state.kind === "drifted") {
      expect(state.actualHash).not.toBe(state.recordedHash);
    }
  });

  it("does NOT detect an edit OUTSIDE the fence: that text is the user's", () => {
    const outsideEdited = `${installed}\n${USER_TEXT_AFTER}`;
    expect(inspectStudioManagedBlock(outsideEdited, STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT)).toEqual({ kind: "intact", upToDate: true });
  });

  it("never silently overwrites a drifted block", () => {
    expect(mergeStudioManagedBlock(edited, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }).status).toBe("unchanged");
  });

  it("overwrites a drifted block ONLY on an explicit repair", () => {
    const repaired = textOf(mergeStudioManagedBlock(edited, STUDIO_TEST_BRIEF, { overwriteDrift: true, environment: STUDIO_TEST_ENVIRONMENT }));
    expect(repaired).not.toContain("TOTALLY");
    expect(inspectStudioManagedBlock(repaired, STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT)).toEqual({ kind: "intact", upToDate: true });
    expect(repaired.startsWith(USER_TEXT_BEFORE)).toBe(true);
  });

  it("refuses a half-open fence instead of guessing where its region ends", () => {
    const halfOpen = `${USER_TEXT_BEFORE}<!-- vex:studio:begin hash=abc -->\nbody with no end\n`;
    const merge = mergeStudioManagedBlock(halfOpen, STUDIO_TEST_BRIEF, { overwriteDrift: true, environment: STUDIO_TEST_ENVIRONMENT });
    expect(merge.status).toBe("refused");
    if (merge.status === "refused") expect(merge.reason).toBe("malformed_managed_block");

    const orphanEnd = `${USER_TEXT_BEFORE}<!-- vex:studio:end -->\n`;
    expect(mergeStudioManagedBlock(orphanEnd, STUDIO_TEST_BRIEF, { overwriteDrift: true, environment: STUDIO_TEST_ENVIRONMENT }).status).toBe("refused");
  });
});

describe("removing the managed block", () => {
  it("leaves the rest of the file byte-identical", () => {
    const withBlock = textOf(mergeStudioManagedBlock(USER_TEXT_BEFORE, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }));
    const removed = removeStudioManagedBlock(withBlock);
    expect(removed.status).toBe("rendered");
    if (removed.status === "rendered") expect(removed.text).toBe(USER_TEXT_BEFORE);
  });

  it("is a no-op when there is no block", () => {
    expect(removeStudioManagedBlock(USER_TEXT_BEFORE).status).toBe("unchanged");
  });
});

/**
 * ITEM 7b: the project-dependent half. These assertions exist because every one
 * of these facts is something an agent acts on - how many tools it can find,
 * what authority it holds, when that authority was granted, and who decides
 * whether a bug report leaves the machine.
 */
describe("the project-dependent half of the block", () => {
  const body = renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);

  it("says what the server is, that it dies with the app, and where keys live", () => {
    expect(body).toContain("LOCAL MCP server inside the Vex desktop app");
    expect(body).toContain("unreachable when the");
    expect(body).toContain("Private keys NEVER leave the Vex app");
    expect(body).toContain("unlocked vault");
    expect(body).toContain("registered");
    // t1 #7: `.mcp.json` can point at a path that no longer exists, and "start
    // Vex" was then the only diagnosis the agent had, which was wrong.
    expect(body).toContain("`vex-mcp` path in `.mcp.json` no longer exists");
    // A15: what a locked vault looks like from the agent's side.
    expect(body).toContain("locked vault refuses BY NAME");
  });

  it("tells the agent an app it builds speaks MCP to the SAME server", () => {
    expect(body).toContain("## Building on Vex MCP");
    expect(body).toContain("MCP IS the API");
    expect(body).toContain("`vex-mcp` bridge command");
    expect(body).toContain("`vex-mcp`");
    expect(body).toContain("publicName");
  });

  it("says the app inherits every restriction, and that there is NO REST API", () => {
    // The load-bearing half: an agent that believes it can build a thin HTTP
    // wrapper around a wallet has just invented a door around the approval
    // card, the permission snapshot and the vault.
    expect(body).toContain("INHERITS EVERY RESTRICTION");
    expect(body).toContain("because there is no other");
    expect(body).toContain("per-call scope snapshot");
    expect(body).toContain("approval card");
    expect(body).toContain("vault-locked signing");
    expect(body).toContain("NO separate REST endpoint");
  });

  it("carries the LIVE tool counts it was given, not a pinned number", () => {
    expect(body).toContain("4 tools are ALWAYS LOADED");
    expect(body).toContain("147 protocol tools across");
    expect(body).toContain("3 protocols");

    // The proof that they are not constants: a different inventory renders
    // different text from the same code path.
    const other = renderStudioManagedBody({
      ...STUDIO_TEST_BRIEF,
      inventory: {
        alwaysLoadedCount: 1,
        alwaysLoadedNames: ["vex_ToolSearch"],
        searchableCount: 200,
        protocols: [{ name: "pendle", toolCount: 200 }],
      },
    }, STUDIO_TEST_ENVIRONMENT);
    expect(other).toContain("1 tools are ALWAYS LOADED");
    expect(other).toContain("200 protocol tools across");
  });

  it("NAMES every always-loaded tool instead of describing the set", () => {
    // The block used to call this set "the core wallet tools". That stopped
    // being true once swap, bridge, chain-read, research and social tools
    // joined the hot set, and an agent told it holds "wallet tools" goes
    // looking through `vex_ToolSearch` for a swap tool it was already handed.
    // The roster is bounded by what the server exports at all, so it is listed.
    for (const tool of STUDIO_TEST_BRIEF.inventory.alwaysLoadedNames) {
      expect(body, `${tool} must be named`).toContain(`- ${tool}`);
    }
    expect(body).not.toContain("the core wallet tools");

    // Driven by the brief, not by a literal in the renderer.
    const other = renderStudioManagedBody({
      ...STUDIO_TEST_BRIEF,
      inventory: {
        ...STUDIO_TEST_BRIEF.inventory,
        alwaysLoadedCount: 1,
        alwaysLoadedNames: ["OnlyThisOne"],
      },
    }, STUDIO_TEST_ENVIRONMENT);
    expect(other).toContain("- OnlyThisOne");
    expect(other).not.toContain("- WalletBalances");
  });

  it("puts WHAT'S NEW first, above every other section", () => {
    const whatsNew = body.indexOf("## What's new in Vex");
    expect(whatsNew).toBeGreaterThan(-1);
    for (const heading of [
      "## This project",
      "## How to work with Vex MCP",
      "## How to do the common jobs",
      "## Protocols available to this project",
      "## Your position",
      "## Building on Vex MCP",
      "## Reporting Vex bugs",
    ]) {
      expect(body.indexOf(heading), `${heading} must follow the notes`)
        .toBeGreaterThan(whatsNew);
    }
  });

  it("renders the owner's eight-section order exactly", () => {
    const order = [
      "# Vex Studio - project \"acme-trading\"",
      "## What's new in Vex 0.2.6",
      "## This project",
      "## How to work with Vex MCP",
      "## How to do the common jobs",
      "## Protocols available to this project",
      "## Your position",
      "## Building on Vex MCP",
      "## Reporting Vex bugs (bounty)",
    ];
    const positions = order.map((heading) => body.indexOf(heading));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names the project, its id and its configured agents", () => {
    expect(body).toContain("project \"acme-trading\"");
    expect(body).toContain("- Project id: `0f6b1c2e-8a4d-4f1b-9c3e-7d5a2b8e4c10`");
    expect(body).toContain("- Configured agents: Claude Code, Codex CLI");
  });

  it("says the first render is the first render, not an empty log", () => {
    const first = renderStudioManagedBody({ ...STUDIO_TEST_BRIEF, changeNotes: [] }, STUDIO_TEST_ENVIRONMENT);
    expect(first).toContain("initial render for this project");
    expect(first).toContain("Vex 0.2.6");
  });

  it("reuses the shared usage notes VERBATIM rather than restating them", () => {
    // One source for the words an agent acts on: the file and the MCP handshake
    // cannot tell it two different things about units or about "declined".
    expect(body).toContain(STUDIO_USAGE_AMOUNTS);
    expect(body).toContain(STUDIO_USAGE_FINDING_TOOLS);
    expect(body).toContain(STUDIO_USAGE_UNAVAILABLE_TOOLS);
    expect(body).toContain(STUDIO_USAGE_TRUNCATION);
  });

  it("names the GENERIC SIGNING PAIRS by their real registry names", () => {
    // These four are why an app can sign anything the user's wallets can sign.
    // The names are the registry's own (`tools/registry/wallet-transaction.ts`);
    // an invented name here would send an agent looking for a tool that does
    // not exist and, worse, invite it to roll its own signing path.
    for (const tool of [
      "WalletEvmTransactionPrepare",
      "WalletEvmTransactionConfirm",
      "WalletSolanaTransactionPrepare",
      "WalletSolanaTransactionConfirm",
    ]) {
      expect(body, `${tool} must be named`).toContain(tool);
    }
    expect(body).toContain("signs nothing, holds no key");
    expect(body).toContain("durable intent");
    // A19/I: the decode-set paragraph and the Prepare/Confirm sentence are no
    // longer COPIED out of the tool descriptions into this file. They have one
    // home - the tool's own description - and the block points at it.
    // Asserted on a phrase that sits inside ONE rendered line: the block is
    // hard-wrapped, so "The decode / set is CLOSED" spans a newline and a
    // substring match across it proves nothing about the text an agent reads.
    expect(body).toContain("set is CLOSED, and router or aggregator calldata");
    expect(body).not.toContain("THE DECODE SET IS CLOSED, AND IT IS NOT");
    expect(body).toContain("digest");
    expect(body).toContain("fee caps");
  });

  it("tells the reader the file does NOT grow across Vex updates", () => {
    // t1 #1 and #2: "nothing else is hidden" had no referent, and the entries
    // sat BELOW a sentence that called them "above".
    expect(body).toContain("THIS SECTION STAYS BOUNDED");
    expect(body).toContain("only change-log entries are ever dropped");
    expect(body).toContain("the change log below");
    expect(body).toContain("OUTSIDE the markers, which Vex never touches");
    expect(body).not.toContain("nothing else is hidden");
  });

  it("tells the agent there is NO generic execute tool to invent", () => {
    // A7: the old pair of sentences ("There is NO generic execute tool" and
    // "Two generic pairs exist for exactly this") read as a contradiction.
    // I-6e (live test pass 2, p1.txt lines 47-49): so did the word "arbitrary",
    // which the block used to forbid ("No tool signs arbitrary calldata") while
    // `WalletEvmTransactionPrepare` opens by offering it. The block now says
    // what is actually true - Vex signs nothing it has not decoded - and its
    // own section heading no longer uses the word either.
    expect(body).toContain("No tool signs calldata Vex has not decoded");
    expect(body).toContain("no generic execute");
    expect(body).toContain("### A transaction Vex has no dedicated tool for");
    expect(body).not.toContain("signs arbitrary calldata");
    expect(body).not.toContain("Two generic pairs exist for exactly this");
  });

  it("carries the I-6 contradictions' fixed wording, each against its finding", () => {
    // Every assertion here is one sentence a measured agent could not act on,
    // with the transcript line it came from. The DESCRIPTION side of the same
    // contradictions is DESC-3's; this is the BLOCK side.

    // I-6a, p1.txt lines 7-9. The block forbade what SwapQuote/SwapExecute
    // instruct ("re-quote with a higher slippageBps", "raise it in steps").
    expect(body).toContain("RE-QUOTE AT THE SAME SLIPPAGE FIRST");
    expect(body).toContain("Raise `slippageBps` only when the");
    expect(body).not.toContain("never raise slippage to force a trade through");
    // p1.txt lines 43-45: a literal reading refused every Solana quote.
    expect(body).toContain("on Solana there are no USD figures at all");

    // I-6f, p1.txt lines 51-53. ChainRead has three actions and no raw call.
    expect(body).toContain("an ERC-721 mint recovered from a receipt");
    expect(body).toContain("There is no raw call");
    expect(body).not.toContain("a receipt, a token balance, a raw call");

    // I-6h, p1.txt lines 92-94. The card's wait was stated nowhere.
    expect(body).toContain("for up to 60 minutes");

    // I-6l, p1.txt lines 124-126. protocols.md is not in the agent's context.
    expect(body).toContain("READ ON DEMAND, not loaded into your");
    expect(body).toContain("every Execute,");
    expect(body).toContain("Confirm, deposit, withdraw, borrow, repay, claim and launch tool");

    // I-6n, p1.txt lines 81-82. "refuses BY NAME" appeared about ten times and
    // was never defined.
    expect(body).toContain("REFUSES BY NAME, here and");
    expect(body).toContain("names the precondition that");

    // I-6j, p1.txt lines 71-73. The privacy sentence forbade what every quote
    // necessarily does.
    expect(body).toContain("Calling a Vex tool is not publishing");
    expect(body).not.toContain("leaves this machine without");

    // A-8, live test pass 2 section 2. The interactive session hesitated
    // because its own harness demands a confirmation the card already is.
    expect(body).toContain(
      "card satisfies any confirm-before-irreversible-action rule your client",
    );

    // I-1's block half: over MCP nothing dispatches WalletSendConfirm for you.
    expect(body).toContain("OVER MCP NOTHING FOLLOWS IT BY");
    expect(body).toContain("`WalletSendConfirm` yourself with that `intentId`");

    // I-6c's block half: what actually counts as a delivered bridge. ONE home
    // for it - the outcome table, whose rows are checked against the modules
    // that emit them (`outcome-vocabulary.test.ts`) - and the Bridge job points
    // at that table instead of restating its words a second time.
    expect(body).toContain("A BRIDGE NEVER REPORTS SUCCESS: a deposit that");
    expect(body).toContain("broadcast is not a delivered bridge.");
    expect(body).toContain("the ONE state that means DELIVERED");
    expect(body).toContain("the ONLY state that means DELIVERED");
    expect(body).toContain("`BridgeStatus` for a");
    expect(body).not.toContain("executed, declined, expired, refused or unknown");
  });

  it("states the card's wait from the constant that enforces it", () => {
    // The minutes are written out in `project-brief.ts` rather than imported,
    // because `APPROVAL_TTL_MS` lives with the durable approval rows and pulls
    // the database graph in with it. The number is still not free-floating:
    // this reads the constant's own source line, the same technique the outcome
    // table uses for its emitters.
    const source = readFileSync(
      resolve(REPO_ROOT, "src/vex-agent/engine/core/approval-runtime/enqueue.ts"),
      "utf8",
    );
    const match = /export const APPROVAL_TTL_MS = ([^;]+);/.exec(source);
    expect(match, "APPROVAL_TTL_MS moved; the block states its value").not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const minutes = Math.round(Number(new Function(`return ${String(match?.[1])}`)()) / 60_000);
    expect(body).toContain(`for up to ${String(minutes)} minutes`);
  });

  it("states the permission AND the wallets AND the dates", () => {
    // I2: the old text said "Every mutation waits for the user's approval
    // card", which is false - the gate fires at risk >= high only, and a local
    // write such as WalletTrackToken was measured running with no card.
    expect(body).toContain("Permission: RESTRICTED");
    expect(body).toContain("Every call marked destructive blocks until the");
    expect(body).toContain("user answers the approval card in Vex");
    expect(body).toContain("Reads, quotes, Prepare tools and local writes raise no card");
    expect(body).not.toContain("Every mutation waits");
    expect(body).toContain("0x1111111111111111111111111111111111111111");
    expect(body).toContain("So11111111111111111111111111111111111111112");
    // A2: one dated line for one event, not four dates for one.
    expect(body).toContain("- Created: 2026-08-01");
    expect(body).toContain("- Scope last changed: 2026-08-25");
    expect(body).not.toContain("- Granted:");
    expect(body).toContain("read FRESH ON EVERY CALL");
  });

  it("says a Solana-less selection refuses BY NAME, and where the user fixes it", () => {
    // A16: the block listed one address per family without saying they are the
    // SELECTED ones, and said nothing about a family with no selection at all.
    const evmOnly = renderStudioManagedBody(
      {
        ...STUDIO_TEST_BRIEF,
        wallets: [{ family: "evm", address: "0x1111111111111111111111111111111111111111" }],
      },
      STUDIO_TEST_ENVIRONMENT,
    );
    expect(evmOnly).toContain("No Solana wallet is selected");
    expect(evmOnly).toContain("refuses by name");
    expect(evmOnly).toContain("under Wallets and then in the project settings");
    expect(evmOnly).toContain("wallets selected RIGHT NOW");
  });

  it("renders the stored `full` permission as FULL ACCESS, with its meaning", () => {
    const full = renderStudioManagedBody(
      { ...STUDIO_TEST_BRIEF, permission: "full" },
      STUDIO_TEST_ENVIRONMENT,
    );
    expect(full).toContain("Permission: FULL ACCESS");
    expect(full).toContain("chose full access knowingly");
    expect(full).toContain("do not add a confirmation step of your own");
    expect(full).toContain("with no approval card");
    // What is true under BOTH levels, and the reason the owner insisted on it.
    expect(full).toContain("Not asking is not the same as not telling");
    expect(full).toContain("no tool widens it");
  });

  it("says so when no wallet is selected instead of listing nothing", () => {
    const none = renderStudioManagedBody(
      { ...STUDIO_TEST_BRIEF, wallets: [] },
      STUDIO_TEST_ENVIRONMENT,
    );
    expect(none).toContain("No wallet is selected for this project");
  });

  it("lists change-log entries newest first and declares its own bound", () => {
    expect(body).toContain(`Vex keeps the last ${String(STUDIO_CHANGE_NOTE_LIMIT)} entries`);
    const newest = body.indexOf("updated the wallet selection");
    const older = body.indexOf("added the codex config");
    expect(newest).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newest);
  });

  it("bounds the change-note list by dropping the OLDEST entries", () => {
    const many = Array.from({ length: STUDIO_CHANGE_NOTE_LIMIT + 4 }, (_, i) => ({
      version: "0.9.9",
      date: "2026-08-25",
      summary: `change ${String(i)}`,
    }));
    const bounded = boundStudioChangeNotes(many);
    expect(bounded).toHaveLength(STUDIO_CHANGE_NOTE_LIMIT);
    expect(bounded[0]?.summary).toBe("change 0");
    expect(bounded.at(-1)?.summary).toBe(`change ${String(STUDIO_CHANGE_NOTE_LIMIT - 1)}`);
  });

  it("ends with a bug-report note that ASKS and never reports on its own", () => {
    expect(body).toContain("https://github.com/Vex-Foundation/Vex");
    expect(body).toContain("USDC or");
    expect(body).toContain("Discord");
    expect(body).toContain("ASK FIRST, ALWAYS");
    expect(body).toContain("Never open a report");
  });

  it("covers the change notes and the authority WITH the drift hash", () => {
    // The whole point of putting them inside the markers: editing a change note
    // or a wallet line is drift, exactly like editing the safety prefix.
    const installed = textOf(
      mergeStudioManagedBlock("", STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }),
    );
    const tampered = installed.replace(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    );
    expect(inspectStudioManagedBlock(tampered, STUDIO_TEST_BRIEF).kind).toBe("drifted");

    const noteTampered = installed.replace("added the codex config", "did nothing");
    expect(inspectStudioManagedBlock(noteTampered, STUDIO_TEST_BRIEF).kind).toBe("drifted");
  });

  it("reports a stale block as intact but NOT up to date when the brief moves", () => {
    const installed = textOf(
      mergeStudioManagedBlock("", STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: STUDIO_TEST_ENVIRONMENT }),
    );
    const state = inspectStudioManagedBlock(installed, {
      ...STUDIO_TEST_BRIEF,
      permission: "full",
    });
    expect(state).toEqual({ kind: "intact", upToDate: false });
  });
});

describe("the CLAUDE.md import", () => {
  const USER_CLAUDE = "# My rules\n\nBe brief.\n";

  it("creates a file that imports AGENTS.md", () => {
    const fresh = renderFreshClaudeMd();
    expect(fresh.status).toBe("rendered");
    if (fresh.status === "rendered") {
      expect(claudeMdImportsAgents(fresh.text)).toBe(true);
      expect(fresh.text).toContain(STUDIO_CLAUDE_MD_IMPORT);
    }
  });

  it("appends the import to an existing file, keeping the user's text first", () => {
    const merged = mergeClaudeMdImport(USER_CLAUDE);
    expect(merged.status).toBe("rendered");
    if (merged.status === "rendered") {
      expect(merged.text.startsWith(USER_CLAUDE)).toBe(true);
      expect(claudeMdImportsAgents(merged.text)).toBe(true);
    }
  });

  it("is idempotent", () => {
    const merged = mergeClaudeMdImport(USER_CLAUDE);
    if (merged.status !== "rendered") throw new Error("expected rendered");
    expect(mergeClaudeMdImport(merged.text).status).toBe("unchanged");
  });

  it("does not mistake prose about @AGENTS.md for an import", () => {
    expect(claudeMdImportsAgents("See @AGENTS.md for the Vex section.\n")).toBe(false);
  });

  it("removes only the import line and returns the original bytes", () => {
    const merged = mergeClaudeMdImport(USER_CLAUDE);
    if (merged.status !== "rendered") throw new Error("expected rendered");
    const removed = removeClaudeMdImport(merged.text);
    expect(removed.status).toBe("rendered");
    if (removed.status === "rendered") expect(removed.text).toBe(USER_CLAUDE);
  });

  it("is a no-op to remove when there is no import", () => {
    expect(removeClaudeMdImport(USER_CLAUDE).status).toBe("unchanged");
  });
});
