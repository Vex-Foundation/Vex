/**
 * Tests for the shared two-tier text redactor (src/lib/diagnostics/text-redaction.ts).
 *
 * The legacy entry point at `src/vex-agent/memory/redaction.ts` is a thin
 * re-export of this module — its tests at
 * `src/__tests__/vex-agent/memory/redaction.test.ts` continue to exercise the
 * same code path through the agent-side import. This test suite imports the
 * canonical module directly so a future bifurcation (someone adding a parallel
 * implementation) would surface here too.
 */

import { describe, it, expect } from "vitest";
import {
  redact,
  redactObject,
} from "../../../lib/diagnostics/text-redaction.js";

describe("text-redaction — Tier 1 hard redact", () => {
  it("redacts a labelled private key in hex form", () => {
    const r = redact(
      "private_key: 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
    );
    expect(r.text).toContain("[REDACTED:private_key]");
    expect(r.hardRedactCount).toBe(1);
    expect(r.text).not.toContain("0x4c0883a6");
  });

  it("redacts an OpenRouter API key", () => {
    const r = redact("Using key sk-or-v1-abc123xyz789defGHI012JKL345MNO678PQR");
    expect(r.text).toContain("[REDACTED:api_key]");
    expect(r.hardRedactCount).toBe(1);
  });

  it("redacts a JWT", () => {
    const r = redact(
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
    expect(r.text).toContain("[REDACTED:jwt]");
    expect(r.hardRedactCount).toBe(1);
  });

  it("redacts a 12-word BIP39-shaped phrase", () => {
    const r = redact(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(r.text).toContain("[REDACTED:mnemonic]");
    expect(r.hardRedactCount).toBe(1);
  });

  it("redacts a real mnemonic that ordinary prose runs into", () => {
    const r = redact(
      "here the seed abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(r.text).toContain("[REDACTED:mnemonic]");
    expect(r.text).not.toContain("abandon");
    expect(r.hardRedactCount).toBe(1);
  });

  it("leaves a long unpunctuated ordinary English sentence untouched", () => {
    const prose =
      "I want stable quotes here before agent tries again since kyber gave that pre-sign gas estimate error";
    const r = redact(prose);
    expect(r.text).toBe(prose);
    expect(r.hardRedactCount).toBe(0);
  });
});

describe("text-redaction — Tier 2 mask", () => {
  it("masks an EVM address", () => {
    const r = redact("Send to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
    expect(r.text).toContain("0x742d…f44e");
    expect(r.maskCount).toBe(1);
  });

  it("masks a 0x-prefixed 64-hex transaction hash", () => {
    const r = redact(
      "tx 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(r.text).toContain("0xabcd…6789");
    expect(r.maskCount).toBe(1);
  });

  it("returns counts of zero for empty strings", () => {
    const r = redact("");
    expect(r.text).toBe("");
    expect(r.hardRedactCount).toBe(0);
    expect(r.maskCount).toBe(0);
  });
});

describe("text-redaction — redactObject", () => {
  it("applies redaction across string fields and sums counts", () => {
    const r = redactObject({
      a: "private_key: 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      b: "to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      c: 42,
      d: ["sk-or-v1-zzzzzzzzzzzzzzzzzzzzz999999", "harmless"],
    });
    expect(r.hardRedactCount).toBeGreaterThanOrEqual(2);
    expect(r.maskCount).toBeGreaterThanOrEqual(1);
    expect(r.value.c).toBe(42);
  });
});
