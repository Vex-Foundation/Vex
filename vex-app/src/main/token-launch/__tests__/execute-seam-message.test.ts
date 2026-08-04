/**
 * `readExecutorOutcome` — the sentence a HUMAN reads after a launch.
 *
 * The defect this pins: for a CONFIRMED launch the executor's `output` is
 * `JSON.stringify(data)` (`trench/handlers/launch/execute/broadcast.ts`), so
 * projecting `result.output` printed a raw JSON dump of the user's own spend —
 * internal `_executionId` included — in exactly the case the projection exists
 * to prevent. The confirmed branch therefore reads `data.summary`, and when that
 * is unusable it COMPOSES a bounded sentence from fields this function has
 * already validated. It never reads `output` for `confirmed`.
 *
 * The other three statuses already return prose that names its own transaction,
 * so they pass through verbatim and the renderer appends nothing.
 */

import { describe, expect, it } from "vitest";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { MAX_LAUNCH_MESSAGE_CHARS, readExecutorOutcome } from "../execute-seam.js";

const TX_HASH = `0x${"a".repeat(64)}`;
const TOKEN = `0x${"b".repeat(40)}`;

/** The REAL confirmed shape: `output` is the JSON of `data`. */
function confirmedResult(summary: unknown): ToolResult {
  const data: Record<string, unknown> = {
    summary,
    status: "confirmed",
    txHash: TX_HASH,
    tokenAddress: TOKEN,
    msgValueWei: "51000000000000000",
    _executionId: "exec_secret_1",
  };
  if (summary === undefined) delete data["summary"];
  return { success: true, output: JSON.stringify(data), data } as ToolResult;
}

function broadcastMessage(result: ToolResult): string {
  const outcome = readExecutorOutcome(result);
  if (outcome.kind !== "broadcast") throw new Error("expected a broadcast outcome");
  return outcome.message;
}

describe("readExecutorOutcome — a confirmed launch never renders as JSON", () => {
  it("projects the executor's own summary when it is usable", () => {
    const message = broadcastMessage(
      confirmedResult(`Launched RKT on Robinhood Chain: ${TOKEN}. Tx: ${TX_HASH}`),
    );
    expect(message).toContain("Launched RKT");
    expect(message).not.toContain("_executionId");
  });

  it.each([
    ["a MISSING summary", undefined],
    ["a NON-STRING summary", 42],
    ["an EMPTY summary", ""],
    ["a WHITESPACE-ONLY summary", "   "],
  ])("composes a sentence for %s — and never the JSON blob", (_label, summary) => {
    const message = broadcastMessage(confirmedResult(summary));

    // Positively: the composed sentence, from already-validated fields.
    expect(message).toBe(`Your launch confirmed. Transaction ${TX_HASH}. Token ${TOKEN}.`);

    // Negatively: it is not the JSON dump, on four independent grounds.
    expect(message.startsWith("{")).toBe(false);
    expect(() => JSON.parse(message)).toThrow();
    expect(message).not.toContain("_executionId");
    expect(message).not.toContain("msgValueWei");
  });

  it("omits the token clause when the address is not decoded", () => {
    const result = confirmedResult(undefined);
    (result.data as Record<string, unknown>)["tokenAddress"] = null;
    expect(broadcastMessage(result)).toBe(`Your launch confirmed. Transaction ${TX_HASH}.`);
  });

  it("falls back to the bare sentence when even the hash is missing", () => {
    const result = confirmedResult(undefined);
    (result.data as Record<string, unknown>)["txHash"] = null;
    (result.data as Record<string, unknown>)["tokenAddress"] = null;
    expect(broadcastMessage(result)).toBe("Your launch confirmed.");
  });

  it("bounds the message at exactly the cap", () => {
    const atCap = "L".repeat(MAX_LAUNCH_MESSAGE_CHARS);
    expect(broadcastMessage(confirmedResult(atCap))).toHaveLength(
      MAX_LAUNCH_MESSAGE_CHARS,
    );
    const overCap = "L".repeat(MAX_LAUNCH_MESSAGE_CHARS + 1);
    expect(broadcastMessage(confirmedResult(overCap))).toHaveLength(
      MAX_LAUNCH_MESSAGE_CHARS,
    );
  });
});

describe("readExecutorOutcome — the other statuses keep the executor's prose", () => {
  it.each(["pending", "reverted", "confirmed_pending_identity"])(
    "passes %s output through verbatim, with its hash stated once",
    (status) => {
      const output = `Your launch could not be confirmed yet. Tx: ${TX_HASH}`;
      const message = broadcastMessage({
        success: false,
        output,
        data: { status, txHash: TX_HASH, tokenAddress: null },
      } as ToolResult);
      expect(message).toBe(output);
      expect(message.split(TX_HASH)).toHaveLength(2); // the hash appears once
    },
  );

  it("keeps a REFUSAL's prose verbatim — nothing was signed", () => {
    const outcome = readExecutorOutcome({
      success: false,
      output: "Vex did not sign anything: the anchored fee moved.",
      data: {},
    } as ToolResult);
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toBe("Vex did not sign anything: the anchored fee moved.");
  });
});
