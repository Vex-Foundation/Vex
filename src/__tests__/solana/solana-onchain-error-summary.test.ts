/**
 * `summarizeSolanaOnChainError` — the serializer that turns a STRUCTURED
 * Solana chain error (`getSignatureStatuses`' `err`, `meta.err`, a
 * simulation's `value.err`) into bounded, deterministic text.
 *
 * WHY THESE CASES. The live defect (execution 209, signature
 * `5RGuPzqE…tbS11gW`) recorded `failure_reason="Solana activity sweep:
 * getSignatureStatuses reported an on-chain error."` and DISCARDED
 * `{"InstructionError":[3,"ProgramFailedToComplete"]}` — the only thing that
 * said what actually happened. This value is chain-controlled input on its way
 * to a DB column and then to the agent, so it must be deterministic (a stable
 * row is diffable), bounded (a hostile/oversized `err` cannot eat the
 * `failure_reason` budget), and total (a serializer that throws on the failure
 * path would replace a decoded failure with an undecoded crash).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_SOLANA_ONCHAIN_ERROR_CHARS,
  summarizeSolanaOnChainError,
} from "@tools/solana-ecosystem/shared/solana-transaction/onchain-error-summary.js";

describe("summarizeSolanaOnChainError", () => {
  it("renders the LIVE defect's error compactly, exactly as it must appear in failure_reason", () => {
    expect(summarizeSolanaOnChainError({ InstructionError: [3, "ProgramFailedToComplete"] })).toBe(
      '{"InstructionError":[3,"ProgramFailedToComplete"]}',
    );
  });

  it("renders a nested custom program error without whitespace", () => {
    expect(summarizeSolanaOnChainError({ InstructionError: [2, { Custom: 6001 }] })).toBe(
      '{"InstructionError":[2,{"Custom":6001}]}',
    );
  });

  it("is deterministic: two differently-ordered equivalent objects give the SAME text", () => {
    const a = { InstructionError: [0, { Custom: 1 }], extra: { z: 1, a: 2 } };
    const b = { extra: { a: 2, z: 1 }, InstructionError: [0, { Custom: 1 }] };
    expect(summarizeSolanaOnChainError(a)).toBe(summarizeSolanaOnChainError(b));
    expect(summarizeSolanaOnChainError(a)).toBe('{"InstructionError":[0,{"Custom":1}],"extra":{"a":2,"z":1}}');
  });

  it("preserves ARRAY order (an InstructionError's index must not be sorted away)", () => {
    expect(summarizeSolanaOnChainError({ InstructionError: [7, "AccountInUse"] })).toBe(
      '{"InstructionError":[7,"AccountInUse"]}',
    );
  });

  it("caps an over-long error at MAX_SOLANA_ONCHAIN_ERROR_CHARS and says it truncated", () => {
    const summary = summarizeSolanaOnChainError({ InstructionError: [0, { Custom: "x".repeat(2_000) }] });
    expect(summary.length).toBeLessThanOrEqual(MAX_SOLANA_ONCHAIN_ERROR_CHARS);
    expect(summary.endsWith("…[truncated]")).toBe(true);
  });

  it("caps an over-long STRING error too", () => {
    const summary = summarizeSolanaOnChainError("y".repeat(2_000));
    expect(summary.length).toBeLessThanOrEqual(MAX_SOLANA_ONCHAIN_ERROR_CHARS);
    expect(summary.endsWith("…[truncated]")).toBe(true);
  });

  it("passes a short string error through unquoted (Solana sends bare-string errors too)", () => {
    expect(summarizeSolanaOnChainError("AccountInUse")).toBe("AccountInUse");
  });

  it("never throws and never returns an empty descriptor for null/undefined", () => {
    expect(summarizeSolanaOnChainError(null)).toBe("unspecified error");
    expect(summarizeSolanaOnChainError(undefined)).toBe("unspecified error");
  });

  it("never throws on a CIRCULAR error object — it degrades to a safe descriptor", () => {
    const circular: Record<string, unknown> = { InstructionError: [1, "Custom"] };
    circular.self = circular;
    expect(() => summarizeSolanaOnChainError(circular)).not.toThrow();
    expect(summarizeSolanaOnChainError(circular)).toBe("unserializable error");
  });

  it("never throws on a BigInt-bearing error object (JSON.stringify would)", () => {
    expect(() => summarizeSolanaOnChainError({ units: 1n })).not.toThrow();
    expect(summarizeSolanaOnChainError({ units: 1n })).toBe("unserializable error");
  });
});
