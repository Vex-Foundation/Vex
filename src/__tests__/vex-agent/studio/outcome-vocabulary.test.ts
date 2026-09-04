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
    // I-6: BridgeStatus follows KHALANI order ids only, so a Relay requestId
    // and a Solana signature need their own named read or the sentence names
    // nothing for them (live test pass 2, p1.txt lines 55-57).
    expect(rendered).toContain("KHALANI orderId");
    expect(rendered).toContain("Relay requestId");
  });

  it("gives EVERY word its own retry verdict, not one rule per bucket", () => {
    // I-6b (p1.txt lines 11-17): the measured agent could not reconcile a flat
    // "never call it twice" with "ask the user to unlock Vex and call again",
    // and asked why `failed before broadcast` was the only repeatable one when
    // declined, expired, refused and dispatch_failed moved nothing either. The
    // verdict is per word because the words inside one bucket do not share one.
    const rendered = renderStudioOutcomeVocabulary();
    for (const row of STUDIO_OUTCOME_WORDS) {
      expect(row.retry.trim().length, `${row.word} needs a retry verdict`)
        .toBeGreaterThan(0);
      expect(rendered, `${row.word}'s verdict must be rendered`)
        .toContain(`CALL AGAIN? ${row.retry}.`);
    }
    // Every UNKNOWN says never, which is the one verdict that is uniform.
    for (const row of STUDIO_OUTCOME_WORDS.filter((r) => r.bucket === "unknown")) {
      expect(row.retry, `${row.word} may never be retried`).toContain("never");
    }
  });

  it("carries the bridge states the tools emit, and the ONE state that means delivered", () => {
    // I-6c: `failed`, `refunded` and `refund_pending` reach the agent from the
    // bridge lanes and were absent from the table, and nothing said what DOES
    // count as delivered - so an agent could never tell a user a bridge was
    // done (p1.txt lines 103-108).
    const words = STUDIO_OUTCOME_WORDS.map((row) => row.word);
    expect(words).toContain("failed (bridge)");
    expect(words).toContain("refunded (bridge)");
    expect(words).toContain("refund_pending (bridge)");
    const delivered = STUDIO_OUTCOME_WORDS.find(
      (row) => row.word === "vexStatus: confirmed (bridge)",
    );
    expect(delivered?.bucket).toBe("happened");
    expect(delivered?.meaning).toContain("DELIVERED");
  });

  it("says on its face that `executed` and `unknown` are not wire words", () => {
    // Three vocabularies for one event was the finding (p1.txt lines 23-25).
    const rendered = renderStudioOutcomeVocabulary();
    expect(rendered).toContain("there is no");
    expect(rendered).toContain("`executed`");
    expect(STUDIO_OUTCOME_WORDS.map((row) => row.word)).not.toContain("executed");
    expect(STUDIO_OUTCOME_WORDS.map((row) => row.word)).not.toContain("unknown");
  });
});
