/**
 * `tokenHistoryOutcome` - the pure reader behind the word every token history
 * row ends in (docs/design/R3-MINIMAL.md section 9.2), branch by branch: swap
 * (confirmed, failed, pending with and without a transaction reference,
 * superseded, a legacy capture), bridge (settling, tracking delayed with
 * `nowMs` injected, refunded, failed, superseded) and transfer (its own source
 * word). Split from `TokenHistoryScreen-honesty.test.tsx`, which keeps what the
 * rendered rows are allowed to claim.
 */

import { describe, expect, it } from "vitest";
import type { TokenHistoryEntry } from "@shared/schemas/token-history.js";
import {
  entryDateText,
  tokenHistoryOutcome,
} from "../token-history/token-history-display.js";
import { bridgeEntry, swapEntry, USDC_BASE } from "./_token-history-fixtures.js";

describe("tokenHistoryOutcome - swap", () => {
  it("confirmed is done and says 'Confirmed' with no consequence", () => {
    expect(tokenHistoryOutcome(swapEntry({ id: "s", status: "confirmed" }))).toEqual({
      state: "done",
      word: "Confirmed",
      notes: [],
    });
  });

  it("failed is an error: 'Failed' with the failure code as the consequence's title", () => {
    expect(
      tokenHistoryOutcome(swapEntry({ id: "s", status: "failed", failureCode: "slippage" })),
    ).toEqual({
      state: "error",
      word: "Failed",
      notes: [{ text: "ask Vex what happened", title: "slippage" }],
    });
  });

  it("failed without a failure code carries no title", () => {
    const outcome = tokenHistoryOutcome(
      swapEntry({ id: "s", status: "failed", failureCode: null }),
    );
    expect(outcome.word).toBe("Failed");
    expect(outcome.notes).toEqual([{ text: "ask Vex what happened" }]);
    expect(outcome.notes.every((note) => note.title === undefined)).toBe(true);
  });

  it("failed with the refund code is still 'Failed' for a swap: only a bridge can be refunded", () => {
    expect(
      tokenHistoryOutcome(
        swapEntry({ id: "s", status: "failed", failureCode: "bridge_refunded" }),
      ).word,
    ).toBe("Failed");
  });

  it("pending with a transaction reference is listening: 'Submitted, awaiting confirmation'", () => {
    expect(tokenHistoryOutcome(swapEntry({ id: "s", status: "pending" }))).toEqual({
      state: "listening",
      word: "Submitted, awaiting confirmation",
      notes: [],
    });
  });

  it("pending without a transaction reference is listening: plain 'Pending'", () => {
    expect(
      tokenHistoryOutcome(swapEntry({ id: "s", status: "pending", txRefs: [] })),
    ).toEqual({ state: "listening", word: "Pending", notes: [] });
  });

  it("superseded_unproven is an error: 'Status unknown' with the unproven statement as the title", () => {
    expect(
      tokenHistoryOutcome(swapEntry({ id: "s", status: "superseded_unproven" })),
    ).toEqual({
      state: "error",
      word: "Status unknown",
      notes: [
        {
          text: "superseded",
          title:
            "Another transaction from this wallet used this one's nonce; what it did has not been checked. Vex has stopped tracking this as in flight - the outcome is unproven.",
        },
      ],
    });
  });

  it("a null status (a legacy capture) is idle: 'Recorded'", () => {
    expect(tokenHistoryOutcome(swapEntry({ id: "s", status: null }))).toEqual({
      state: "idle",
      word: "Recorded",
      notes: [],
    });
  });
});

describe("tokenHistoryOutcome - bridge", () => {
  const CHECKED_AT = "2026-07-20T08:00:00+00:00";
  const checkedMs = Date.parse(CHECKED_AT);
  const MINUTE = 60 * 1000;

  it("pending and freshly checked is listening: 'Settling', tracked automatically", () => {
    expect(
      tokenHistoryOutcome(
        bridgeEntry({ id: "b", status: "pending", createdAt: CHECKED_AT, lastCheckedAt: CHECKED_AT }),
        checkedMs + 9 * MINUTE,
      ),
    ).toEqual({
      state: "listening",
      word: "Settling",
      notes: [
        {
          text: "tracked automatically",
          title: "Still settling - tracked automatically",
        },
      ],
    });
  });

  it("pending and stale is an error: 'Status unknown', tracking delayed with the last check on its title", () => {
    const outcome = tokenHistoryOutcome(
      bridgeEntry({ id: "b", status: "pending", createdAt: CHECKED_AT, lastCheckedAt: CHECKED_AT }),
      checkedMs + 11 * MINUTE,
    );
    const checked = entryDateText(CHECKED_AT);
    expect(checked).not.toBeNull();
    expect(outcome).toEqual({
      state: "error",
      word: "Status unknown",
      notes: [
        {
          text: "tracking delayed",
          title: `Tracking delayed - last checked ${String(checked)}`,
        },
        { text: "checked again automatically" },
      ],
    });
  });

  it("pending, never checked and older than the window: the title says it was not yet checked", () => {
    const outcome = tokenHistoryOutcome(
      bridgeEntry({ id: "b", status: "pending", createdAt: CHECKED_AT, lastCheckedAt: null }),
      checkedMs + 11 * MINUTE,
    );
    expect(outcome.state).toBe("error");
    expect(outcome.word).toBe("Status unknown");
    expect(outcome.notes).toEqual([
      {
        text: "tracking delayed",
        title: "Tracking delayed - not yet checked since the bridge started",
      },
      { text: "checked again automatically" },
    ]);
  });

  it("pending, never checked but still inside the window: 'Settling'", () => {
    expect(
      tokenHistoryOutcome(
        bridgeEntry({ id: "b", status: "pending", createdAt: CHECKED_AT, lastCheckedAt: null }),
        checkedMs + 5 * MINUTE,
      ).word,
    ).toBe("Settling");
  });

  it("failed with the refund code is idle: 'Refunded', funds returned to the origin chain", () => {
    expect(
      tokenHistoryOutcome(
        bridgeEntry({ id: "b", status: "failed", failureCode: "bridge_refunded" }),
      ),
    ).toEqual({
      state: "idle",
      word: "Refunded",
      notes: [
        {
          text: "returned to the origin chain",
          title: "Funds returned to the origin chain - not a completed bridge",
        },
      ],
    });
  });

  it("any other failure is an error: 'Failed' with the code as the title", () => {
    expect(
      tokenHistoryOutcome(
        bridgeEntry({ id: "b", status: "failed", failureCode: "bridge_failed" }),
      ),
    ).toEqual({
      state: "error",
      word: "Failed",
      notes: [{ text: "ask Vex what happened", title: "bridge_failed" }],
    });
  });

  it("a failure with no code is still 'Failed', never 'Refunded'", () => {
    const outcome = tokenHistoryOutcome(
      bridgeEntry({ id: "b", status: "failed", failureCode: null }),
    );
    expect(outcome.state).toBe("error");
    expect(outcome.word).toBe("Failed");
  });

  it("confirmed is done: 'Confirmed'", () => {
    expect(tokenHistoryOutcome(bridgeEntry({ id: "b", status: "confirmed" }))).toEqual({
      state: "done",
      word: "Confirmed",
      notes: [],
    });
  });

  it("a null status is idle: 'Recorded'", () => {
    expect(tokenHistoryOutcome(bridgeEntry({ id: "b", status: null }))).toEqual({
      state: "idle",
      word: "Recorded",
      notes: [],
    });
  });

  it("superseded_unproven is an error: 'Status unknown', never 'Failed'", () => {
    const outcome = tokenHistoryOutcome(
      bridgeEntry({ id: "b", status: "superseded_unproven" }),
    );
    expect(outcome.state).toBe("error");
    expect(outcome.word).toBe("Status unknown");
    expect(outcome.notes.map((note) => note.text)).toEqual(["superseded"]);
  });
});

describe("tokenHistoryOutcome - transfer", () => {
  function transferEntry(status: string): TokenHistoryEntry {
    return {
      kind: "transfer",
      id: "t-outcome",
      createdAt: "2026-06-20T08:00:00+00:00",
      chain: "base",
      toAddress: "0x9999888877776666555544443333222211110000",
      amount: { value: "0.25", unitProvenance: "human" },
      token: USDC_BASE,
      status,
      txRefs: [],
    };
  }

  it.each([
    ["executed", "Executed"],
    ["confirmed", "Confirmed"],
    ["completed", "Completed"],
  ])("'%s' is done and reads '%s'", (status, word) => {
    expect(tokenHistoryOutcome(transferEntry(status))).toEqual({
      state: "done",
      word,
      notes: [],
    });
  });

  it("'failed' is an error and reads 'Failed'", () => {
    expect(tokenHistoryOutcome(transferEntry("failed"))).toEqual({
      state: "error",
      word: "Failed",
      notes: [],
    });
  });

  it.each([
    ["pending", "Pending"],
    ["submitted", "Submitted"],
    ["broadcast", "Broadcast"],
  ])("'%s' is listening and reads '%s'", (status, word) => {
    expect(tokenHistoryOutcome(transferEntry(status))).toEqual({
      state: "listening",
      word,
      notes: [],
    });
  });

  it("any other status is idle and keeps its own word in sentence case", () => {
    expect(tokenHistoryOutcome(transferEntry("QUEUED_FOR_REVIEW"))).toEqual({
      state: "idle",
      word: "Queued for review",
      notes: [],
    });
  });

  it("an empty status is idle: 'Recorded'", () => {
    expect(tokenHistoryOutcome(transferEntry(""))).toEqual({
      state: "idle",
      word: "Recorded",
      notes: [],
    });
  });
});
