/**
 * A slippage failure INFORMS the agent; it never escalates the tolerance by
 * itself (owner decree 2026-08-03).
 *
 * WHY THE FLEET-LEVEL ASSERTION IS STRUCTURAL, and why that is the right
 * evidence here rather than a shortcut. The decree's claim is the ABSENCE of a
 * code path: no venue may re-run a refused trade at a tolerance the caller did
 * not pass. A behavioural harness can only ever demonstrate that ONE mocked
 * failure produced one attempt; it cannot show that no other branch escalates,
 * and reproducing the real event needs a funded wallet plus a pool that moves
 * between the quote and the estimate. A source-level assertion is exactly
 * co-extensive with the claim: a tolerance that is bound `const`, never
 * incremented and never widened by `Math.max` cannot be raised at runtime, on
 * any branch, whatever the mocks say.
 *
 * SCOPE. kyberswap, solana-jupiter and pendle - the three money paths
 * that carry a caller `slippageBps` into a signable route AND are owned by this
 * change. Uniswap and relay are deliberately absent: they are being edited
 * concurrently in this same wave, and a characterization test must freeze
 * behaviour it can actually read. Extend the map below when they land.
 *
 * The complementary INFORM side — that the refusal names the applied bps, the
 * ceiling and the observed impact — is asserted behaviourally in
 * `slippage-remediation-contract.test.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../../../../..");

/** Every file that carries a caller tolerance toward a signature, per venue. */
const VENUE_SOURCES: Readonly<Record<string, readonly string[]>> = {
  kyberswap: [
    "src/vex-agent/tools/protocols/kyberswap/handlers/swap",
    "src/tools/kyberswap/swap-price-floor.ts",
    "src/tools/kyberswap/evm/swap-calldata-guard.ts",
  ],
  jupiter: [
    "src/vex-agent/tools/protocols/solana-jupiter/handlers/core",
    "src/tools/solana-ecosystem/jupiter/jupiter-swaps",
  ],
  pendle: [
    "src/vex-agent/tools/protocols/pendle/calldata/price-floor.ts",
    "src/vex-agent/tools/protocols/pendle/handlers/shared.ts",
  ],
};

function sourceFiles(entry: string): string[] {
  const absolute = path.join(ROOT, entry);
  if (entry.endsWith(".ts")) return [absolute];
  return readdirSync(absolute)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(absolute, name));
}

interface SourceLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every CODE line naming a slippage/tolerance binding — comments excluded, they are prose. */
function slippageLines(venue: string): SourceLine[] {
  const found: SourceLine[] = [];
  const entries = VENUE_SOURCES[venue];
  if (entries === undefined) throw new Error(`no sources registered for venue ${venue}`);
  for (const entry of entries) {
    for (const file of sourceFiles(entry)) {
      readFileSync(file, "utf8").split("\n").forEach((text, index) => {
        const code = text.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
        if (!/slippage|tolerance/i.test(code)) return;
        found.push({ file: path.relative(ROOT, file), line: index + 1, text: code });
      });
    }
  }
  return found;
}

/**
 * Raising a tolerance takes one of these shapes. `Math.min(...)` is absent on
 * purpose — lowering toward a venue's own stricter bound is the ceiling doing
 * its job and has never been the concern.
 */
const ESCALATION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["compound assignment", /\b\w*[sS]lippage\w*\s*(\+=|\*=)/],
  // `slippageBps * 2`, `slippageBps + 100` — an increase whoever it is assigned
  // to. Only a NUMERIC operand counts: `(10000 - slippageBps)` is the floor
  // arithmetic, and a string built with `+` is prose, not a tolerance change.
  ["arithmetic increase of a tolerance", /\b\w*[sS]lippage\w*\s*[*+]\s*\d/],
  ["widened by Math.max", /Math\.max\([^)]*[sS]lippage/],
  ["a mutable tolerance binding", /\b(let|var)\s+\w*[sS]lippage\w*\b/],
];

describe("no venue raises the caller's slippage after a refusal", () => {
  for (const venue of Object.keys(VENUE_SOURCES)) {
    const lines = slippageLines(venue);

    it(`${venue} — the tolerance-carrying code exists and is actually being read`, () => {
      // Guards the suite itself: a moved directory must fail loudly rather than
      // pass by scanning nothing.
      expect(lines.length).toBeGreaterThan(0);
    });

    for (const [label, pattern] of ESCALATION_PATTERNS) {
      it(`${venue} — no ${label}`, () => {
        const offenders = lines.filter(({ text }) => pattern.test(text));
        expect(offenders.map((o) => `${o.file}:${o.line} ${o.text}`)).toEqual([]);
      });
    }

    it(`${venue} — no retry loop is built around the tolerance`, () => {
      // A refused attempt is reported, not re-run: the agent decides the next
      // tolerance. Any `for`/`while` on a line naming slippage would be the
      // shape an auto-escalation takes.
      const loops = lines.filter(({ text }) => /\b(for|while)\s*\(/.test(text));
      expect(loops.map((o) => `${o.file}:${o.line} ${o.text}`)).toEqual([]);
    });
  }
});
