/**
 * ZOD OBJECT-KEY OPTIONALITY CONTRACT — the tripwire for the 4.3.6 → 4.4.3
 * migration (owner decision 2026-08-17).
 *
 * WHAT CHANGED. Up to zod 4.3.6, a `z.unknown()` object property was
 * IMPLICITLY OPTIONAL: `z.object({ a: z.unknown() }).safeParse({})` succeeded.
 * zod 4.4.0 (PR #5661) made absence require input-side optionality, so the same
 * parse now fails with `invalid_type` / `expected: "nonoptional"`. The repo's
 * provider parsers lean on the tolerant-reader idiom from `rules/90` — display
 * fields tolerated when missing, financial fields strict — and every one of
 * them was written against the OLD implicit optionality. The migration made
 * that optionality EXPLICIT (`.unknown().optional().transform(...)`) rather
 * than relying on a default that zod has already changed once.
 *
 * WHY THIS TEST EXISTS. Upstream has not settled the question: PR #6224 would
 * restore `unknown`/`any` as implicitly optional and is unmerged as of 4.4.3.
 * If a future bump flips the default back, the explicit `.optional()` calls stay
 * correct and nothing breaks. But if a bump flips it the OTHER way, or someone
 * "tidies away" an `.optional()` as redundant, a live provider response with a
 * missing display field would start hard-failing an entire quote or price read.
 * That is the outage class `rules/90` records, and a green suite would not
 * otherwise catch it, because fixtures encode well-formed payloads.
 *
 * So this file pins BOTH halves:
 *   1. the raw zod semantic the migration was performed against, and
 *   2. that each migrated lane still tolerates a payload missing its
 *      display-only fields.
 *
 * If (1) fails, zod changed the default again — re-verify the lanes, do not
 * just edit the assertion. If (2) fails, a tolerant reader was silently
 * tightened into a strict one.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parsePair } from "@tools/dexscreener/validation/pairs.js";
import { validateHoneypotFotResponse } from "@tools/kyberswap/token-api/validation.js";

describe("zod object-key optionality (installed version)", () => {
  it("treats a bare z.unknown() property as REQUIRED", () => {
    const result = z.object({ a: z.unknown() }).safeParse({});

    expect(result.success).toBe(false);
    // Documents the migration's premise. A future zod may relax this again;
    // that is safe, but it must be a deliberate, re-verified change.
    expect(result.error?.issues[0]?.code).toBe("invalid_type");
  });

  it("accepts the property once optionality is explicit", () => {
    expect(z.object({ a: z.unknown().optional() }).safeParse({}).success).toBe(true);
  });

  it("still runs a transform on an absent key when .optional() precedes it", () => {
    // This is the exact shape the tolerant readers use. `.optional()` must come
    // BEFORE `.transform()`: reversed, an absent key skips the transform and the
    // defaulted field disappears from the output instead of defaulting.
    const schema = z.object({
      a: z.unknown().optional().transform((v) => (typeof v === "string" ? v : "fallback")),
    });

    expect(schema.parse({})).toEqual({ a: "fallback" });
    expect(schema.parse({ a: "real" })).toEqual({ a: "real" });
  });
});

describe("tolerant readers accept payloads missing display-only fields", () => {
  it("dexscreener: a pair carrying only its required identity fields", () => {
    // Every omitted key here is display-only. The required identity/price
    // fields stay strict, which the surrounding dexscreener suites cover.
    const pair = parsePair({
      chainId: "solana",
      dexId: "raydium",
      url: "https://dexscreener.com/solana/abc",
      pairAddress: "abc",
      // baseToken/quoteToken stay STRICT - they identify what is being traded,
      // so a missing one must fail rather than default.
      baseToken: { address: "So111", name: "Wrapped SOL", symbol: "SOL" },
      quoteToken: { address: "EPjFW", name: "USD Coin", symbol: "USDC" },
      priceNative: "1.5",
    });

    expect(pair.chainId).toBe("solana");
    expect(pair.priceUsd).toBeNull();
    expect(pair.liquidity).toBeNull();
    expect(pair.info).toBeNull();
    expect(pair.labels).toBeNull();
    expect(pair.txns).toEqual({});
    expect(pair.volume).toEqual({});
  });

  it("kyberswap: an empty honeypot/FOT body defaults every field", () => {
    // A missing `isHoneypot` must read as `false`, never as a parse failure -
    // this response gates a swap, so a hard failure here blocks trading.
    expect(validateHoneypotFotResponse({})).toEqual({
      isHoneypot: false,
      isFOT: false,
      tax: 0,
    });
  });
});
