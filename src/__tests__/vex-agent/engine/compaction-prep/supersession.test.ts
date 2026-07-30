import { describe, it, expect } from "vitest";

import {
  SUPERSEDE_MIN_NEW_BYTES,
  SUPERSEDE_MIN_NEW_MESSAGES,
  computeWatermarkMessageId,
  decideSupersession,
} from "@vex-agent/engine/compaction-prep/supersession.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages/types.js";

function message(id: number, content = "x"): MessageWithId {
  return {
    id,
    role: "user",
    content,
    timestamp: new Date(0).toISOString(),
  };
}

function messagesAfter(count: number, content = "x"): MessageWithId[] {
  return Array.from({ length: count }, (_, i) => message(100 + i, content));
}

describe("computeWatermarkMessageId", () => {
  it("returns the maximum id even when created_at ordering disagrees with id ordering", () => {
    // Rows arrive ordered `created_at ASC, id ASC`. `created_at` is
    // caller-supplied, so a row with a HIGHER id can carry an EARLIER
    // timestamp and sort first. Taking the last sorted element would freeze a
    // watermark that leaves higher-id rows below the cutoff.
    const rowsAsOrderedByTheQuery: MessageWithId[] = [
      message(41), // backdated created_at, highest id
      message(7),
      message(9),
    ];
    expect(computeWatermarkMessageId(rowsAsOrderedByTheQuery)).toBe(41);
    expect(
      rowsAsOrderedByTheQuery[rowsAsOrderedByTheQuery.length - 1].id,
    ).toBe(9);
  });

  it("returns the last id when the two orderings agree", () => {
    expect(computeWatermarkMessageId([message(1), message(2), message(3)])).toBe(
      3,
    );
  });

  it("returns null for an empty row set", () => {
    expect(computeWatermarkMessageId([])).toBeNull();
  });
});

describe("decideSupersession — forbidden statuses", () => {
  it("never supersedes apply_requested or applying, even far past both thresholds", () => {
    for (const liveStatus of ["apply_requested", "applying"] as const) {
      expect(
        decideSupersession({
          liveStatus,
          liveWatermarkMessageId: 10,
          rowsAfterWatermark: messagesAfter(
            SUPERSEDE_MIN_NEW_MESSAGES * 10,
            "y".repeat(SUPERSEDE_MIN_NEW_BYTES),
          ),
        }),
      ).toEqual({ kind: "keep", reason: "terminal_status_forbidden" });
    }
  });
});

describe("decideSupersession — message-count threshold", () => {
  it("keeps at one below N and supersedes at N", () => {
    const below = decideSupersession({
      liveStatus: "preparing",
      liveWatermarkMessageId: 10,
      rowsAfterWatermark: messagesAfter(SUPERSEDE_MIN_NEW_MESSAGES - 1),
    });
    expect(below).toEqual({ kind: "keep", reason: "not_material" });

    const at = decideSupersession({
      liveStatus: "summary_ready",
      liveWatermarkMessageId: 10,
      rowsAfterWatermark: messagesAfter(SUPERSEDE_MIN_NEW_MESSAGES),
    });
    expect(at.kind).toBe("supersede");
    if (at.kind === "supersede") {
      expect(at.newMessages).toBe(SUPERSEDE_MIN_NEW_MESSAGES);
    }
  });

  it("supersedes above N", () => {
    expect(
      decideSupersession({
        liveStatus: "preparing",
        liveWatermarkMessageId: 10,
        rowsAfterWatermark: messagesAfter(SUPERSEDE_MIN_NEW_MESSAGES + 5),
      }).kind,
    ).toBe("supersede");
  });
});

describe("decideSupersession — byte threshold", () => {
  it("keeps at one byte below M and supersedes at M with few messages", () => {
    const almost = message(200, "a".repeat(SUPERSEDE_MIN_NEW_BYTES - 1));
    expect(
      decideSupersession({
        liveStatus: "preparing",
        liveWatermarkMessageId: 10,
        rowsAfterWatermark: [almost],
      }),
    ).toEqual({ kind: "keep", reason: "not_material" });

    const exact = message(200, "a".repeat(SUPERSEDE_MIN_NEW_BYTES));
    const decision = decideSupersession({
      liveStatus: "preparing",
      liveWatermarkMessageId: 10,
      rowsAfterWatermark: [exact],
    });
    expect(decision.kind).toBe("supersede");
    if (decision.kind === "supersede") {
      expect(decision.newMessages).toBe(1);
      expect(decision.newBytes).toBe(SUPERSEDE_MIN_NEW_BYTES);
    }
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // A 4-byte emoji is 2 UTF-16 code units. Counting `.length` would
    // undercount by half against every other byte bound in this wave.
    const emojiCount = SUPERSEDE_MIN_NEW_BYTES / 4;
    const content = "🙂".repeat(emojiCount);
    expect(content.length).toBe(emojiCount * 2);

    const decision = decideSupersession({
      liveStatus: "preparing",
      liveWatermarkMessageId: 10,
      rowsAfterWatermark: [message(200, content)],
    });
    expect(decision.kind).toBe("supersede");
    if (decision.kind === "supersede") {
      expect(decision.newBytes).toBe(SUPERSEDE_MIN_NEW_BYTES);
    }
  });
});

describe("decideSupersession — row filtering", () => {
  it("ignores rows at or below the live watermark", () => {
    const stale = Array.from({ length: SUPERSEDE_MIN_NEW_MESSAGES }, (_, i) =>
      message(i + 1),
    );
    expect(
      decideSupersession({
        liveStatus: "preparing",
        liveWatermarkMessageId: SUPERSEDE_MIN_NEW_MESSAGES,
        rowsAfterWatermark: stale,
      }),
    ).toEqual({ kind: "keep", reason: "not_material" });
  });

  it("keeps a live preparation with no new rows at all", () => {
    expect(
      decideSupersession({
        liveStatus: "summary_ready",
        liveWatermarkMessageId: 10,
        rowsAfterWatermark: [],
      }),
    ).toEqual({ kind: "keep", reason: "not_material" });
  });
});
