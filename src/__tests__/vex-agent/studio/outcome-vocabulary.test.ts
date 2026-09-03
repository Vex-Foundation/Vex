/**
 * EVERY WORD IN THE OUTCOME TABLE IS A WORD SOMETHING ACTUALLY EMITS.
 *
 * The clarity review (2026-09-03, I9) found the opposite: the instructions named
 * four failure words while the tools returned a dozen, and safety rule 1's
 * "never retry an unknown outcome" depends entirely on the agent recognising
 * WHICH wire word is the unknown one. The fix was a table; the risk a table
 * creates is a word that stops being emitted and sits in the instructions as a
 * fiction, teaching an agent to look for something it will never see.
 *
 * So each row carries its emitter, and this suite reads that file and finds the
 * literal. It is a static check on purpose: the alternative - driving every
 * handler to its own failure - would need a chain, a provider and a wallet per
 * row, and would still not prove the word reaches the agent's eyes, which is
 * what the emitting text is.
 *
 * Pure, no DB, no network.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  STUDIO_OUTCOME_WORDS,
  renderStudioOutcomeVocabulary,
} from "@vex-agent/studio/instructions/shared-usage.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

describe("the outcome vocabulary", () => {
  it.each(STUDIO_OUTCOME_WORDS.map((row) => [row.word, row] as const))(
    "`%s` is emitted by the file the table names",
    (_word, row) => {
      const source = readFileSync(resolve(REPO_ROOT, row.emitter), "utf8");
      expect(
        source.includes(row.literal),
        `${row.emitter} no longer contains ${JSON.stringify(row.literal)}; `
          + "either the wording moved (update the row) or the outcome is gone "
          + "(remove the row) - do not leave a word in the instructions that "
          + "nothing emits",
      ).toBe(true);
    },
  );

  it("lists every word exactly once", () => {
    const words = STUDIO_OUTCOME_WORDS.map((row) => row.word);
    expect(new Set(words).size).toBe(words.length);
  });

  it("puts every word under one of the three buckets, and fills all three", () => {
    const rendered = renderStudioOutcomeVocabulary();
    expect(rendered).toContain("NOTHING HAPPENED");
    expect(rendered).toContain("IT HAPPENED");
    expect(rendered).toContain("UNKNOWN");
    for (const row of STUDIO_OUTCOME_WORDS) {
      expect(rendered, `${row.word} must be rendered`).toContain(`\`${row.word}\``);
    }
    for (const bucket of ["nothing", "happened", "unknown"] as const) {
      expect(
        STUDIO_OUTCOME_WORDS.some((row) => row.bucket === bucket),
        `bucket ${bucket} must not be empty`,
      ).toBe(true);
    }
  });

  it("tells the agent to RESOLVE an unknown by reading, never by calling again", () => {
    // This is the sentence that stops the one mistake that costs money twice.
    const rendered = renderStudioOutcomeVocabulary();
    expect(rendered).toContain("NEVER resend");
    expect(rendered).toContain("resolved by READING, never by calling again");
    expect(rendered).toContain("`ChainRead` action `tx_receipt`");
    expect(rendered).toContain("`BridgeStatus`");
    expect(rendered).toContain("`AgentScan`");
  });
});
