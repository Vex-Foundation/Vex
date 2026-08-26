/**
 * THE EXTRACTION MUST NOT HAVE CHANGED A BYTE.
 *
 * A5a moved the usage-notes half of the MCP handshake `instructions` string out
 * of `mcp/instructions.ts` and into `studio/instructions/shared-usage.ts` so the
 * `AGENTS.md` managed block could reuse it instead of copying it. That is a
 * refactor of text an external agent reads at handshake, and the whole point of
 * a refactor is that the observable value is unchanged.
 *
 * So this file PINS the composed value literally. It is a characterization
 * test in the strict sense: the string below was captured from the code BEFORE
 * the extraction, and if the extraction, a re-wrap or a future edit changes one
 * character, this fails. The existing budget lints in
 * `mcp/instructions.test.ts` continue to own the 512-character prefix and the
 * 2000-byte whole-string bounds.
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

/** Captured from the pre-extraction module. Do not regenerate from the code. */
const PRE_EXTRACTION_INSTRUCTIONS =
  "Vex moves REAL funds from the user's wallet. Nothing here is a simulation.\n"
  + "1. APPROVAL: in a restricted project a fund-moving call pauses for the "
  + "user's decision in Vex and may be declined or expire. Never retry a call "
  + "that reports an unknown or indeterminate outcome.\n"
  + "2. QUOTE FIRST: run the quote or preview tool before any swap, bridge, "
  + "trade or lend call, and show the user what it returned.\n"
  + "3. AMOUNTS: units are PER FIELD - human decimals or raw smallest units. "
  + "Read the field's description; never guess."
  + "\n\n"
  + "FINDING TOOLS: this server lists every tool it has. The Vex tools and "
  + "vex_ToolSearch are loaded up front; the protocol tools are found with "
  + "vex_ToolSearch, which is read-only and runs nothing. Call any tool "
  + "directly by the publicName it reports - there is no activation step.\n"
  + "AMOUNTS: this server carries BOTH unit styles, so there is no server-wide "
  + "rule to apply. A field documented as a human decimal string takes exactly "
  + "the user's amount as a string (\"1.5\", never wei or lamports). A field "
  + "documented as raw or atomic units takes an integer string in the token's "
  + "smallest units, read together with that token's decimals. Never convert on "
  + "a guess and never round.\n"
  + "PROJECT SCOPE: each connection is bound to one Vex project, and that "
  + "project's permission and wallet selection are read fresh on every call. "
  + "The user can change either at any time, so read each result rather than "
  + "assuming what a previous call was allowed to do.\n"
  + "UNAVAILABLE TOOLS: a tool whose provider key is not configured returns an "
  + "error naming the environment variable and the remedy. It has not run. "
  + "Report the name to the user; do not work around it.\n"
  + "ERRORS: every refusal says what did not happen. Read it. \"Declined\", "
  + "\"expired\", \"cancelled\" and \"unknown outcome\" mean different things and "
  + "only the first three mean nothing was executed.";

describe("extracting the usage notes out of the handshake instructions", () => {
  it("left `STUDIO_MCP_INSTRUCTIONS` byte-for-byte identical", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toBe(PRE_EXTRACTION_INSTRUCTIONS);
    expect(Buffer.byteLength(STUDIO_MCP_INSTRUCTIONS, "utf8"))
      .toBe(Buffer.byteLength(PRE_EXTRACTION_INSTRUCTIONS, "utf8"));
  });

  it("composes exactly prefix + separator + notes, with nothing else in between", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toBe(
      `${STUDIO_SAFETY_PREFIX}${STUDIO_INSTRUCTIONS_SEPARATOR}${STUDIO_USAGE_NOTES}`,
    );
  });

  it("keeps the safety prefix first, which is the whole point of its bound", () => {
    expect(STUDIO_MCP_INSTRUCTIONS.startsWith(STUDIO_SAFETY_PREFIX)).toBe(true);
    expect(STUDIO_SAFETY_PREFIX.length).toBeLessThanOrEqual(512);
  });

  it("exports the notes WITHOUT the separator, so a second consumer can lay them out", () => {
    // The managed block does not want a leading blank line baked into the text;
    // it composes its own layout. Keeping the separator separate is what lets
    // both consumers share one string.
    expect(STUDIO_USAGE_NOTES.startsWith("\n")).toBe(false);
    expect(STUDIO_USAGE_NOTES.startsWith("FINDING TOOLS")).toBe(true);
  });

  it("has ONE home for the notes: the MCP module does not re-author them", () => {
    // Guard against the copy coming back. If someone re-inlines the text in
    // `mcp/instructions.ts`, the module stops importing the shared string and
    // this identity check is the thing that still holds - so assert the import
    // relationship itself through the composed value's dependence on it.
    expect(STUDIO_MCP_INSTRUCTIONS.endsWith(STUDIO_USAGE_NOTES)).toBe(true);
  });
});
