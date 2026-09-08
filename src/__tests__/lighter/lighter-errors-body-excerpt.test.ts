/**
 * `describeLighterBody` - the provider's own words, with no venue-local cut.
 *
 * THE DEFECT THIS PINS (Codex round-1 minor M4). The function used to slice the
 * already-sanitized provider text at 200 characters and append "...", a SECOND
 * cut layered on top of the one the shared sanitizer owns. Lighter's longest
 * rejections are the ones worth reading: a reproduction of a rejected order put
 * the actionable "missing required field ..." instruction at the END of the
 * body, and the 200-character slice removed exactly that sentence, leaving the
 * agent a mutilated preamble with no way to learn what was left out
 * (CLAUDE.md, "FORBIDDEN: silent content cutting").
 *
 * WHAT THIS DOES NOT CLAIM. `summarizeProtocolError` still owns a documented
 * bound of its own (`MAX_SAFE_ERROR_MESSAGE`, `utils/error-summary/scrub.ts`),
 * shared by every venue. The property asserted here is the one this file can
 * own: whatever that shared owner returns reaches the caller unchanged, so the
 * text is no longer cut twice and no "..." of ours hides anything. Redaction is
 * asserted alongside, because removing a cut must not remove a secret's cover.
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../errors.js";
import { describeLighterBody, mapLighterError } from "@tools/lighter/errors.js";
import { summarizeProtocolError } from "@utils/error-summary.js";
import { MAX_SAFE_ERROR_MESSAGE } from "@utils/error-summary/scrub.js";

/** The shape a Lighter validation rejection actually arrives in. */
function longRejectionBody(instruction: string): { error: { message: string } } {
  return {
    error: {
      message:
        `order rejected by the matching engine: ${"the request failed validation. ".repeat(6)}`
        + instruction,
    },
  };
}

describe("describeLighterBody surfaces the sanitized provider body without a venue-local cut", () => {
  it("keeps the trailing actionable instruction of a long rejection", () => {
    const instruction = "missing required field base_amount for a limit order.";
    const excerpt = describeLighterBody(longRejectionBody(instruction));
    expect(excerpt).toBeDefined();
    // The whole point: the last sentence, past the old 200-character slice,
    // is what the caller has to act on.
    expect(excerpt).toContain(instruction);
    expect(excerpt?.endsWith(instruction)).toBe(true);
    expect(excerpt).not.toContain("...");
  });

  it("returns exactly what the shared sanitizer returned, byte for byte", () => {
    const body = longRejectionBody("set price_protection and retry.");
    const excerpt = requireExcerpt(describeLighterBody(body));
    const sanitized = summarizeProtocolError(new Error(body.error.message)).message
      .replace(/\s+/g, " ")
      .trim();
    expect(excerpt).toBe(sanitized);
    // A guard on the premise of the test above: the fixture really is longer
    // than the cut that used to be applied here, so a reintroduced 200-char
    // slice cannot pass this file by accident.
    expect(excerpt.length).toBeGreaterThan(200);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_SAFE_ERROR_MESSAGE + 1);
  });

  it("still redacts a secret that sits past the old cut", () => {
    const secret = "sk-ant-abcdef0123456789abcdef0123456789";
    const excerpt = requireExcerpt(
      describeLighterBody({ error: `${"padding text. ".repeat(20)}${secret}` }),
    );
    expect(excerpt).not.toContain(secret);
    expect(excerpt).not.toContain("abcdef0123456789");
  });

  it("carries the whole excerpt into the mapped VexError message", () => {
    const instruction = "account index 42 is not registered for this environment.";
    const error = mapLighterError("rhc", 400, longRejectionBody(instruction));
    expect(error.code).toBe(ErrorCodes.LIGHTER_INVALID_REQUEST);
    expect(error.message).toContain("Upstream said:");
    expect(error.message).toContain(instruction);
  });
});

function requireExcerpt(value: string | undefined): string {
  if (value === undefined) throw new Error("expected a described Lighter body");
  return value;
}
