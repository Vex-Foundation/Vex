/**
 * The Studio settlement codec - the one owner of "a `ToolResult` as durable
 * JSON".
 *
 * Three properties, and the third is the one the forbidden-truncation rule
 * cares about:
 *
 *   1. every field round-trips, including ones the codec has never heard of;
 *   2. a value JSON cannot represent is TAGGED, never dropped and never
 *      silently rewritten;
 *   3. `settlement_bytes` equals the byte length of the body actually stored,
 *      and `output` is never cut at any size.
 */

import { describe, it, expect } from "vitest";

import {
  encodeStudioSettlement,
  extractSettlementOutput,
  NON_JSON_TAG,
  STUDIO_SETTLEMENT_CODEC_VERSION,
} from "@vex-agent/engine/core/approval-runtime/studio/settlement-codec.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

describe("encodeStudioSettlement", () => {
  it("round-trips every declared ToolResult field", () => {
    const result: ToolResult = {
      success: true,
      output: "swap submitted",
      data: { txHash: "0xabc", legs: [{ chain: "base", amount: "1.5" }] },
      durationMs: 1234,
      actionKind: "user_wallet_broadcast",
      pendingApproval: false,
      prequote: { verdict: "pass" } as ToolResult["prequote"],
    };
    const encoded = encodeStudioSettlement(result);
    expect(encoded.body.v).toBe(STUDIO_SETTLEMENT_CODEC_VERSION);
    const parsed = JSON.parse(encoded.json) as {
      v: number;
      result: Record<string, unknown>;
    };
    expect(parsed.result).toEqual({
      success: true,
      output: "swap submitted",
      data: { txHash: "0xabc", legs: [{ chain: "base", amount: "1.5" }] },
      durationMs: 1234,
      actionKind: "user_wallet_broadcast",
      pendingApproval: false,
      prequote: { verdict: "pass" },
    });
  });

  it("stores a field the codec has never heard of rather than dropping it", () => {
    // The projection walks keys, so a field added to `ToolResult` later is
    // stored without this module changing.
    const result = {
      success: false,
      output: "no",
      somethingNewNextQuarter: { nested: [1, 2, 3] },
    } as unknown as ToolResult;
    const encoded = encodeStudioSettlement(result);
    expect(encoded.body.result.somethingNewNextQuarter).toEqual({
      nested: [1, 2, 3],
    });
  });

  it("tags a non-JSON `data` value explicitly instead of dropping it", () => {
    const result = {
      success: true,
      output: "ok",
      data: {
        amountRaw: 123456789012345678901234567890n,
        seen: new Map([["a", 1]]),
        when: new Date("2026-08-23T10:00:00.000Z"),
        missing: undefined,
      },
    } as unknown as ToolResult;
    const encoded = encodeStudioSettlement(result);
    const data = encoded.body.result.data as Record<string, unknown>;

    const amount = data.amountRaw as Record<string, { reason: string; text: string }>;
    expect(amount[NON_JSON_TAG]?.reason).toBe("unsupported_bigint");
    // The VALUE survives as text: a raw token amount is exactly the thing that
    // must never vanish from a money-path record.
    expect(amount[NON_JSON_TAG]?.text).toBe("123456789012345678901234567890");

    const seen = data.seen as Record<string, { reason: string }>;
    expect(seen[NON_JSON_TAG]?.reason).toBe("map");
    // A Date is representable, so it is kept as an instant rather than tagged.
    expect(data.when).toBe("2026-08-23T10:00:00.000Z");
    // A declared-but-empty field stays VISIBLE as a tagged absence.
    const missing = data.missing as Record<string, { reason: string }>;
    expect(missing[NON_JSON_TAG]?.reason).toBe("unsupported_undefined");
  });

  it("tags a circular reference instead of throwing", () => {
    const data: Record<string, unknown> = { name: "loop" };
    data.self = data;
    const encoded = encodeStudioSettlement({
      success: true,
      output: "ok",
      data,
    } as ToolResult);
    const stored = encoded.body.result.data as Record<string, unknown>;
    const self = stored.self as Record<string, { reason: string }>;
    expect(self[NON_JSON_TAG]?.reason).toBe("circular_reference");
  });

  it("never cuts `output`, and reports the exact byte size of the stored body", () => {
    const output = "x".repeat(500_000);
    const encoded = encodeStudioSettlement({ success: true, output } as ToolResult);
    expect(encoded.body.result.output).toBe(output);
    expect((encoded.body.result.output as string).length).toBe(500_000);
    // The recorded size describes the body that is written, not an estimate.
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.json, "utf8"));
    expect(encoded.bytes).toBe(Buffer.byteLength(JSON.stringify(encoded.body), "utf8"));
  });

  it("counts BYTES, not characters, for multi-byte output", () => {
    const encoded = encodeStudioSettlement({
      success: true,
      output: "ééé",
    } as ToolResult);
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.json, "utf8"));
  });
});

describe("extractSettlementOutput", () => {
  it("preserves the whole textual output for the indeterminate path", () => {
    const output = "broadcast sent, receipt unknown";
    expect(
      extractSettlementOutput({ success: true, output } as ToolResult),
    ).toBe(output);
  });
});
