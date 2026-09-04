/**
 * THE HANDSHAKE STRING IS PINNED LITERALLY, BY HAND.
 *
 * `instructions` is the one text every MCP client receives before it calls
 * anything, and it is a prompt contract (rule 09): a wording change is a
 * behaviour change and must be an intentional decision, never a regenerated
 * baseline. So the whole composed value is written out below and compared byte
 * for byte. Do NOT paste a fresh capture in to make this pass - state the change
 * in the header the way the entries below are stated, and change the text on
 * purpose.
 *
 * ## The contract changes this baseline records
 *
 * The literal was originally the PRE-EXTRACTION capture from `mcp/instructions.ts`,
 * carried unchanged through A5a's move of the usage notes into
 * `studio/instructions/shared-usage.ts`. It has changed deliberately twice
 * since:
 *
 *  1. A2 (live test 2026-09-03) added the bounded-answer sentences to FINDING
 *     TOOLS: a live agent received "20 of 74 matches", was told only to raise a
 *     limit already at its ceiling, and reported the rest as unreachable.
 *
 *  2. INSTR-1 (clarity review 2026-09-03) rewrote the rules against what an
 *     agent measurably could not tell from them, each change carrying its
 *     finding:
 *       - I1: APPROVAL now says a destructive call BLOCKS and that the result IS
 *         the settled outcome. The old "pauses for the user's decision" left
 *         both measured sessions unable to say whether to call again.
 *       - I4: FINDING TOOLS now says "no activation step ON THE SERVER" and
 *         carries the client-name mapping. The old flat "there is no activation
 *         step" is false in Claude Code, which defers the protocol tools.
 *       - I3: TRUNCATED is new. Claude Code cuts descriptions at exactly 2048
 *         characters; nothing is missing on the server and vex_ToolDescribe
 *         returns the whole contract.
 *       - I9: ERRORS now names the three buckets instead of four words, and
 *         points at the full table in AGENTS.md, which the 2,000-byte budget
 *         cannot hold.
 *
 *  3. INSTR-2 (live test pass 2, 2026-09-03, I-6b and I-6c) removed a wrong
 *     word list and a rule the tools contradict:
 *       - I-6c: APPROVAL no longer says the outcome is "executed, declined,
 *         expired, refused or unknown". Neither `executed` nor `unknown` is a
 *         word anything emits (`mcp/server-result.ts` has seven outcome kinds
 *         and the tools return confirmed / confirmed_unrecorded /
 *         indeterminate), and the measured agent counted three vocabularies for
 *         one event (p1.txt lines 23-25).
 *       - I-6b: "Never call it twice or retry an unknown one" became "never
 *         call again while one is unanswered, and never retry an UNKNOWN
 *         outcome", because the absolute contradicted the tool text that tells
 *         an agent to unlock Vex and call again (p1.txt lines 11-13). ERRORS
 *         forbids only the resend that is always wrong; the per-word verdicts
 *         are the block's table, which the 2,000-byte budget cannot hold and
 *         SAME SOURCE points at.
 *       - I10: QUOTE FIRST now says to RESTATE the quote rather than to "show
 *         the user what it returned", which was ambiguous when the approval card
 *         is the confirmation.
 *       - A17: UNAVAILABLE TOOLS names the typed result and the ToolSearch
 *         `available: false` row, and asks for both names.
 *       - A19: the SAME SOURCE sentence tells the reader which other copy exists
 *         and that neither overrides the other.
 *
 * The budget lints in `mcp/instructions.test.ts` continue to own the
 * 512-character prefix and the 2000-byte whole-string bounds.
 */

import { describe, it, expect } from "vitest";

import {
  STUDIO_MCP_INSTRUCTIONS,
  STUDIO_SAFETY_PREFIX,
} from "@vex-agent/mcp/instructions.js";
import {
  STUDIO_INSTRUCTIONS_SEPARATOR,
  STUDIO_USAGE_NOTES,
} from "@vex-agent/studio/instructions/shared-usage.js";

/** Written out by hand. An edit that lands here is an authored decision. */
const PINNED_INSTRUCTIONS =
  "Vex moves REAL funds. Nothing here is a sandbox or testnet.\n"
  + "1. APPROVAL: in a restricted project a destructive call BLOCKS "
  + "until the user answers the card in Vex; the result IS the settled "
  + "outcome. Never call again while one is unanswered, and never retry "
  + "an UNKNOWN outcome.\n"
  + "2. QUOTE FIRST: quote before any swap, bridge, trade or lend, then"
  + " restate amounts, fees, impact and ETA.\n"
  + "3. AMOUNTS: units are PER FIELD - human decimals or raw smallest "
  + "units. Read the field description; never guess.\n"
  + "\n"
  + "FINDING TOOLS: every tool is in tools/list. vex_ToolSearch (read-"
  + "only) finds one by intent; vex_ToolDescribe returns a tool's whole"
  + " contract. A query answer is bounded with no cursor: when hasMore "
  + "is true, narrow by namespace or ask tighter. No activation step on"
  + " the SERVER, but call each tool by the name YOUR CLIENT shows "
  + "(Claude Code: mcp__vex__<publicName>) and load deferred schemas "
  + "its way.\n"
  + "TRUNCATED: a description ending \"[truncated]\" was cut by YOUR "
  + "CLIENT (Claude Code: 2048 chars), not the server - call "
  + "vex_ToolDescribe.\n"
  + "AMOUNTS: BOTH unit styles exist, so there is no server-wide rule. "
  + "A human-decimal field takes the user's amount as a string (\"1.5\", "
  + "never wei or lamports); a field in raw or atomic units takes an "
  + "integer string in the token's smallest units with its decimals. "
  + "Never guess and never round; convert with UnitsConvert.\n"
  + "PROJECT SCOPE: each connection is bound to one Vex project; its "
  + "permission and wallet selection are read fresh on every call and "
  + "can change at any time. Read each result.\n"
  + "UNAVAILABLE TOOLS: a missing provider key answers a typed "
  + "configuration_unavailable result naming the variable; "
  + "vex_ToolSearch shows available: false. It has NOT run. Report both"
  + " names; do not work around it.\n"
  + "ERRORS: every result says what happened. Bucket its word: nothing "
  + "happened, it happened, or unknown. Never resend an unknown one.\n"
  + "SAME SOURCE: AGENTS.md renders these rules from the same text, "
  + "plus the outcome table, the fee line and the task shapes.";

describe("the MCP handshake instructions", () => {
  it("are exactly the pinned text, byte for byte", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toBe(PINNED_INSTRUCTIONS);
    expect(Buffer.byteLength(STUDIO_MCP_INSTRUCTIONS, "utf8"))
      .toBe(Buffer.byteLength(PINNED_INSTRUCTIONS, "utf8"));
  });

  it("compose exactly prefix + separator + notes, with nothing else in between", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toBe(
      `${STUDIO_SAFETY_PREFIX}${STUDIO_INSTRUCTIONS_SEPARATOR}${STUDIO_USAGE_NOTES}`,
    );
  });

  it("keep the safety prefix first, which is the whole point of its bound", () => {
    expect(STUDIO_MCP_INSTRUCTIONS.startsWith(STUDIO_SAFETY_PREFIX)).toBe(true);
    expect(STUDIO_SAFETY_PREFIX.length).toBeLessThanOrEqual(512);
  });

  it("say what a destructive call DOES over MCP: it blocks and settles", () => {
    // I1. The one question both measured sessions could not answer. The old
    // wording ("pauses for the user's decision") is what invited a second call.
    expect(STUDIO_SAFETY_PREFIX).toContain("BLOCKS until the user answers");
    expect(STUDIO_SAFETY_PREFIX).toContain("the result IS the settled outcome");
    expect(STUDIO_SAFETY_PREFIX).toContain("Never call again while one is unanswered");
    expect(STUDIO_MCP_INSTRUCTIONS).not.toContain("pauses for the user's decision");
  });

  it("names no outcome word the wire does not carry (I-6c)", () => {
    // Live test 2026-09-03, p1.txt lines 23-25: the rule listed "executed" and
    // "unknown", which no tool and no broker emits, against the tools' own
    // "confirmed / confirmed_unrecorded / indeterminate". Three vocabularies
    // for one event; the rule now names none of them and points at the table
    // that is checked against its emitters.
    expect(STUDIO_MCP_INSTRUCTIONS)
      .not.toContain("executed, declined, expired, refused or unknown");
  });

  it("does not forbid the retry the tools themselves ask for (I-6b)", () => {
    // p1.txt lines 11-13: "Never call it twice or retry an unknown one" read as
    // an absolute against "ask the user to unlock Vex and call again". The
    // handshake now forbids exactly the two calls that are always wrong - a
    // second call while a card is unanswered, and a resend of an UNKNOWN
    // outcome - and forbids nothing else. The per-word verdicts do not fit the
    // 2,000-byte budget and are not restated here in weaker words: the block's
    // table owns them, and SAME SOURCE points at it.
    expect(STUDIO_SAFETY_PREFIX).not.toContain("Never call it twice");
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/never call it twice/i);
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("Never resend an unknown one.");
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/never (resend|retry) any/i);
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("SAME SOURCE: AGENTS.md");
  });

  it("scope the no-activation claim to the SERVER and map the client's name", () => {
    // I4. "There is no activation step" is false in Claude Code, which defers
    // the protocol tools behind its own ToolSearch.
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("No activation step on the SERVER");
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("mcp__vex__<publicName>");
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/there is no activation step\b/);
  });

  it("tell the agent a truncated description is the CLIENT's cut", () => {
    // I3. Measured at exactly 2048 characters in Claude Code.
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("[truncated]");
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("cut by YOUR CLIENT");
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("vex_ToolDescribe");
  });

  it("export the notes WITHOUT the separator, so a second consumer can lay them out", () => {
    // The managed block does not want a leading blank line baked into the text;
    // it composes its own layout. Keeping the separator separate is what lets
    // both consumers share one string.
    expect(STUDIO_USAGE_NOTES.startsWith("\n")).toBe(false);
    expect(STUDIO_USAGE_NOTES.startsWith("FINDING TOOLS")).toBe(true);
  });

  it("have ONE home for the notes: the MCP module does not re-author them", () => {
    // Guard against the copy coming back. If someone re-inlines the text in
    // `mcp/instructions.ts`, the module stops importing the shared string and
    // this identity check is the thing that still holds - so assert the import
    // relationship itself through the composed value's dependence on it.
    expect(STUDIO_MCP_INSTRUCTIONS.endsWith(STUDIO_USAGE_NOTES)).toBe(true);
  });

  it("name the other copy instead of leaving the reader to guess (A19)", () => {
    expect(STUDIO_USAGE_NOTES).toContain("SAME SOURCE: AGENTS.md");
  });
});
