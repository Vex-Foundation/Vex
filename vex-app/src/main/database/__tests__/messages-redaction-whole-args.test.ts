/**
 * WHOLE-ARGS CONTRACT (owner decree: no silent content cutting).
 *
 * The displayed tool args are the WHOLE sanitized serialization or null,
 * never a cut string. The reproducer here is the measured production outage
 * of 2026-08-26: the first BoardCompose call serialized past the old
 * 2,000-char cap, the truncation branch appended a suffix that pushed the
 * string past the IPC schema's own bound, and the ENTIRE messages page
 * failed output validation - the session would no longer load. Reverting the
 * fix (any per-string, per-array, per-key, depth or whole-serialization cut)
 * turns these red.
 *
 * Secret REDACTION is a different concern and must survive: it hides what
 * the user must NOT see, and `messages-redaction-tx-hash.test.ts` plus the
 * cases at the bottom keep it pinned.
 */

import { describe, expect, it } from "vitest";
import { sanitizeToolArgs } from "../messages/redaction.js";
import {
  TOOL_ARGS_DISPLAY_CEILING,
  toolCallDisplaySchema,
} from "../../../shared/schemas/messages.js";
import { BOARD_SPEC_MAX_BYTES } from "@vex-lib/board/index.js";

/** A BoardCompose-shaped call: the real producer that exposed the outage. */
function boardComposeSizedArgs(): Record<string, unknown> {
  const note =
    "Liquidity thinned out after the 14:00 candle and the pool has been " +
    "leaning on a single maker since; treat the +60% move as unconfirmed " +
    "until depth returns. Watch the 0.0125 shelf where the accumulation " +
    "range from yesterday evening sat before the breakout attempt began.";
  return {
    title: "Robinhood Chain - Top 5 movers",
    pools: Array.from({ length: 8 }, (_, i) => ({
      chain: "robinhood",
      pairAddress: `0x${String(i).repeat(40)}`,
      caption: `${note} (pool ${i})`,
    })),
    notes: Array.from({ length: 6 }, () => note),
    chart: {
      poolIndex: 0,
      resolution: "15m",
      annotations: Array.from({ length: 12 }, (_, i) => ({
        kind: "level",
        price: `0.0${100 + i}`,
        label: `shelf ${i}: ${note}`,
      })),
    },
  };
}

describe("sanitizeToolArgs ships the WHOLE sanitized serialization", () => {
  it("keeps a 280-char string verbatim (the old 256 cap is gone)", () => {
    // Real prose: capitals, digits and punctuation keep it clear of the
    // base64 and mnemonic secret heuristics, which are correct and separate.
    const value = ("Liquidity thinned after the 14:00 candle; depth sat at 0.0125. ").repeat(5).slice(0, 280);
    expect(value).toHaveLength(280);
    const out = sanitizeToolArgs({ note: value });
    expect(out).not.toBeNull();
    expect(out).toContain(value);
    expect(out).not.toContain("…");
  });

  it("keeps every element of a 60-item array (the old 50 cap is gone)", () => {
    const out = sanitizeToolArgs({ items: Array.from({ length: 60 }, (_, i) => `item-${i}`) });
    expect(out).not.toBeNull();
    expect(out).toContain("item-0");
    expect(out).toContain("item-59");
  });

  it("keeps all 60 keys of a wide object (the old 50-key cap is gone)", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 60; i += 1) wide[`field${i}`] = i;
    const out = sanitizeToolArgs(wide);
    expect(out).not.toBeNull();
    expect(out).toContain("field59");
  });

  it("keeps a depth-6 branch instead of replacing it with an ellipsis marker", () => {
    const out = sanitizeToolArgs({
      a: { b: { c: { d: { e: { f: "deep-leaf" } } } } },
    });
    expect(out).not.toBeNull();
    expect(out).toContain("deep-leaf");
    expect(out).not.toContain("[…]");
  });

  it("round-trips a BoardCompose-sized call through the IPC display schema (the production outage class)", () => {
    const out = sanitizeToolArgs(boardComposeSizedArgs());
    expect(out).not.toBeNull();
    const serialized = out as string;
    // The old cap fired at 2,000 chars; this call is far past it and must
    // arrive whole, with no truncation marker of any spelling.
    expect(serialized.length).toBeGreaterThan(2000);
    expect(serialized).not.toContain("(truncated)");
    const parsed = toolCallDisplaySchema.safeParse({
      toolCallId: "call_1",
      toolName: "BoardCompose",
      toolArgs: serialized,
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips a board at the TOP of the spec budget, whole", () => {
    // The regression this pairs with: the analysis field now admits 10,000
    // characters per pool and the board budget is 256 KiB, so the largest
    // legal BoardCompose args are a quarter of a megabyte of the model's own
    // prose. The display ceiling has to clear that WITH the call envelope, or
    // the user sees a tool call with no arguments and no explanation.
    const insight =
      "Depth has been rebuilding on the bid since the 14:00 candle and the "
      + "single maker that carried the move stepped back without the book "
      + "thinning, which is the part that makes this different from the "
      + "unconfirmed leg two days ago. The 0.0125 shelf is where yesterday's "
      + "accumulation sat and it has held twice. Invalidation is a close "
      + "under it on rising sell count. ";
    const analysis = insight.repeat(Math.ceil(10_000 / insight.length)).normalize();
    const args = {
      ...boardComposeSizedArgs(),
      pools: Array.from({ length: 8 }, (_, i) => ({
        chain: "robinhood",
        pairAddress: `0x${String(i).repeat(40)}`,
        analysis,
      })),
    };
    const out = sanitizeToolArgs(args);
    expect(out).not.toBeNull();
    const serialized = out as string;
    // Proof it is really board-budget-class rather than a small fixture.
    expect(serialized.length).toBeGreaterThan(BOARD_SPEC_MAX_BYTES / 4);
    expect(serialized).toContain("0.0125 shelf");
    expect(serialized).not.toContain("(truncated)");
    expect(serialized).not.toContain("[…]");
    expect(
      toolCallDisplaySchema.safeParse({
        toolCallId: "call_board",
        toolName: "BoardCompose",
        toolArgs: serialized,
      }).success,
    ).toBe(true);
  });

  it("maps a row beyond the corruption ceiling to null, never to a cut string", () => {
    const phrase = "Corrupted row payload, far past every legitimate producer (entry 9). ";
    const over = { blob: phrase.repeat(Math.ceil((TOOL_ARGS_DISPLAY_CEILING + 1024) / phrase.length)) };
    expect(sanitizeToolArgs(over)).toBeNull();
  });

  it("still redacts secret-shaped values while keeping the rest whole", () => {
    const note = ("Watch the 0.0125 shelf; yesterday's accumulation range sat there. ").repeat(5).slice(0, 280);
    const out = sanitizeToolArgs({
      note,
      // Neutral key NAME so the value-shape layer is what fires: a key
      // literally called "jwt" is dropped by name before the value is seen.
      payload: "eyJabc.eyJdef.sig",
      privateKey: "should be dropped by key name",
    });
    expect(out).not.toBeNull();
    expect(out).toContain(note);
    expect(out).toContain("[redacted:jwt]");
    expect(out).not.toContain("should be dropped by key name");
  });
});
