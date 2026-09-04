/**
 * The requesting client's name, as the approval card will show it -
 * pure-function tests.
 *
 * Split out of `approval-intent-preview.test.ts` (2026-09-04) when that file
 * passed the 750-line gate. It earns a file of its own for the reason its own
 * header below already gives: this is the ONE field on the card that an
 * external process chooses for itself, so these are boundary tests over
 * hostile input rather than formatting tests over ours. Assertions are
 * unchanged by the move.
 */

import { describe, it, expect } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "../../tools/_test-context.js";
import {
  buildIntentPreview,
  buildPolicySnapshot,
  sanitizeRequestingClientName,
  REQUESTING_CLIENT_NAME_MAX,
} from "@vex-agent/engine/core/approval-intent-preview.js";

/**
 * WHO ASKED, as the approval card will show it.
 *
 * The name is the one field on the card that an EXTERNAL PROCESS chooses for
 * itself (an MCP client's `initialize` handshake), so these are boundary tests
 * rather than formatting tests: every case below is a value another process can
 * put on the wire, and the assertion is what a human ends up reading because
 * of it.
 */
describe("sanitizeRequestingClientName", () => {
  const context: InternalToolContext = makeTestContext({
    sessionId: "00000000-0000-4000-8000-000000000002",
  });

  it("keeps a plain client name, trimmed", () => {
    expect(sanitizeRequestingClientName("  Claude Code  ")).toBe("Claude Code");
  });

  // Control characters are refused because the actor row is a LINE a human
  // reads on a money-path card: a newline inside the name forges a second one.
  it.each([
    ["a newline", "Claude Code\nVEX APPROVED"],
    ["a carriage return", "Claude\rCode"],
    ["a NUL", "Claude\u0000Code"],
    ["an ANSI escape introducer", "\u001b[31mClaude Code"],
    ["DEL", "Claude\u007fCode"],
  ])("refuses %s rather than rendering it", (_label, name) => {
    expect(sanitizeRequestingClientName(name)).toBeNull();
  });

  /**
   * The defect this closes: refusing only ASCII controls left every
   * Unicode class that can make the rendered line lie. Each case here is a name
   * a human would read as something OTHER than what the client declared.
   *
   * The suffix under attack is `approvalActorLine`'s "(an MCP client)" - the
   * three words that tell the reader this name is self-declared provenance and
   * not an identity Vex verified. A right-to-left override placed inside the
   * name reorders the glyphs that follow it, so the suffix can be painted
   * backwards or dragged behind the name; a zero-width joiner or space makes two
   * different clients render identically. Both are refused WHOLE, so the card
   * falls back to "an MCP client" and claims nothing it cannot show.
   */
  it.each([
    ["a right-to-left override (U+202E)", "Claude \u202eedoC"],
    ["a left-to-right override (U+202D)", "\u202dClaude Code"],
    ["a right-to-left embedding (U+202B)", "Claude\u202bCode"],
    ["a first-strong isolate (U+2068)", "Claude\u2068Code"],
    ["a pop directional isolate (U+2069)", "Claude Code\u2069"],
    ["a zero-width joiner (U+200D)", "Claude\u200d Code"],
    ["a zero-width non-joiner (U+200C)", "Clau\u200cde Code"],
    ["a zero-width space (U+200B)", "Claude\u200bCode"],
    ["a soft hyphen (U+00AD)", "Clau\u00adde Code"],
    ["a line separator (U+2028)", "Claude Code\u2028VEX APPROVED"],
    ["a paragraph separator (U+2029)", "Claude Code\u2029VEX APPROVED"],
    ["a C1 control (U+0085 NEL)", "Claude\u0085Code"],
    ["a lone high surrogate", "Claude \ud800Code"],
  ])("refuses %s rather than rendering it", (_label, name) => {
    expect(sanitizeRequestingClientName(name)).toBeNull();
  });

  /**
   * The other half of the same invariant, and the reason the rule is a
   * CATEGORY test and not "ASCII only": a client whose name is written in the
   * reader's own script is a client with a name. Refusing these would push every
   * non-English client onto the anonymous label, which is the same loss of
   * provenance the hardening exists to prevent.
   */
  it.each([
    ["Polish letters", "Zażółć gęślą jaźń"],
    ["CJK", "克劳德代码"],
    ["Cyrillic", "Клод Код"],
    ["an astral pictograph (paired surrogates)", "Claude Code \u{1f4bb}"],
    ["a combining mark", "Cláude Côde"],
  ])("keeps a benign non-ASCII name: %s", (_label, name) => {
    expect(sanitizeRequestingClientName(name)).toBe(name);
  });

  /**
   * A refusal is NOT a strip. `String.prototype.trim` eats U+2028, U+2029 and
   * U+FEFF, so a check placed after the trim would quietly accept
   * `"\u2028Claude Code"` as `"Claude Code"` - a name the client never declared,
   * shown to a human as if it had. The class is therefore tested on the raw
   * value, and this test is what goes red if that order is swapped back.
   */
  it.each([
    ["a leading line separator", "\u2028Claude Code"],
    ["a trailing paragraph separator", "Claude Code\u2029"],
    ["a leading BOM", "\ufeffClaude Code"],
  ])("refuses %s instead of silently trimming it away", (_label, name) => {
    expect(name.trim()).not.toBe(name);
    expect(sanitizeRequestingClientName(name)).toBeNull();
  });

  it.each([
    ["a number", 42],
    ["undefined", undefined],
    ["an object", { name: "Claude Code" }],
    ["the empty string", ""],
    ["whitespace only", "   "],
  ])("refuses %s", (_label, value) => {
    expect(sanitizeRequestingClientName(value)).toBeNull();
  });

  it("keeps a name exactly at the bound", () => {
    const name = "c".repeat(REQUESTING_CLIENT_NAME_MAX);
    expect(sanitizeRequestingClientName(name)).toBe(name);
  });

  /**
   * The invariant a "just shorten it" change would break: "Claude Cod..." and
   * "Claude Code" read the same to a human deciding a transfer, and only one of
   * them is a name that person can verify. An over-long name is DROPPED whole,
   * and the card then says "an MCP client", which claims less rather than more.
   */
  it("DROPS an over-long name whole, never shortens it", () => {
    const name = "c".repeat(REQUESTING_CLIENT_NAME_MAX + 1);
    expect(sanitizeRequestingClientName(name)).toBeNull();
  });

  it("carries a sanitized name onto the policy snapshot the card reads", () => {
    expect(buildPolicySnapshot(context, " Claude Code ").requestedByClient).toBe(
      "Claude Code",
    );
  });

  it("records no client for Vex's own agent loop", () => {
    expect(buildPolicySnapshot(context).requestedByClient).toBeNull();
  });

  it("records no client when the declared name is unusable", () => {
    expect(
      buildPolicySnapshot(context, "Claude\nCode").requestedByClient,
    ).toBeNull();
  });

  // The snapshot is the value that lands in `policy_json` and travels to the
  // card, so the boundary that matters is proven at the boundary, not only on
  // the helper.
  it("records no client when the declared name reorders the line it would be shown on", () => {
    expect(
      buildPolicySnapshot(context, "Claude \u202eedoC").requestedByClient,
    ).toBeNull();
  });

  it("carries a non-ASCII client name through to the snapshot", () => {
    expect(buildPolicySnapshot(context, " Zażółć gęślą jaźń ").requestedByClient).toBe(
      "Zażółć gęślą jaźń",
    );
  });

  /**
   * The card must never show a fee, a rate or a destination that came from the
   * client's NAME. Nothing branches on this value; it lands in `policy_json`
   * and stops there.
   */
  it("keeps the client name out of the preview the digest binds", () => {
    const preview = buildIntentPreview("WalletSendConfirm", {
      intentId: "int-1",
      clientName: "Claude Code",
    });
    expect(preview.criticalArgs).not.toHaveProperty("clientName");
    expect(preview.criticalArgs).not.toHaveProperty("requestedByClient");
  });
});
