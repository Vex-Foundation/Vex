/**
 * Tests for the shared low-level secret detectors
 * (src/lib/diagnostics/secret-detectors.ts).
 *
 * The Tier 1 / Tier 2 shape regexes (private key, API key, JWT, BIP39,
 * EVM/Solana address, tx hash) are exercised indirectly and exhaustively
 * through `text-redaction.test.ts` (this module is their canonical source
 * after the move-only extraction — see that file's header comment). This
 * suite focuses on what is NEW here: the open-ended base64 candidate
 * detector and its `looksLikeBase64Secret` classifier, including the
 * precision cases (Solana addresses, tx hashes, short/benign base64-like
 * payloads, normal prose) that the fixed-length pattern it replaces could
 * not resolve correctly.
 */

import { describe, it, expect } from "vitest";
import {
  looksLikeBase64Secret,
  OPEN_ENDED_BASE64_CANDIDATE_RE,
} from "../../../lib/diagnostics/secret-detectors.js";

/** All-0xFF bytes base64-encode to a run of `/` characters for every full
 *  3-byte group — a deterministic way to guarantee the encoded string
 *  contains a base64-only character (satisfying `looksLikeBase64Secret`)
 *  regardless of byte length, without relying on random byte luck. */
function base64Secret(byteLength: number): string {
  return Buffer.alloc(byteLength, 0xff).toString("base64");
}

function candidatesIn(text: string): string[] {
  return Array.from(text.matchAll(OPEN_ENDED_BASE64_CANDIDATE_RE)).map(
    (m) => m[0],
  );
}

describe("secret-detectors — open-ended base64 recall", () => {
  // 16..72 raw bytes: the byte-length matrix from the WP-K plan. The old
  // fixed-length {86} pattern it replaces only matched the 64-byte case.
  const BYTE_LENGTHS = [16, 24, 32, 40, 48, 56, 64, 72];

  for (const byteLength of BYTE_LENGTHS) {
    it(`catches a base64-encoded ${byteLength}-byte secret`, () => {
      const secret = base64Secret(byteLength);
      const prose = `Here is the key: ${secret} — please keep it safe.`;
      const candidates = candidatesIn(prose);
      expect(candidates).toContain(secret);
      expect(candidates.some((c) => looksLikeBase64Secret(c))).toBe(true);
    });
  }

  it("catches a base64 secret immediately after an assignment delimiter", () => {
    const secret = base64Secret(32);
    expect(candidatesIn(`token=${secret}`)).toContain(secret);
  });
});

describe("secret-detectors — precision (false positives must not fire)", () => {
  it("does not flag an ordinary Solana address as a base64 secret", () => {
    // 44-char base58 — no 0/O/I/l/+//=, so it is structurally NOT base64-only.
    const solanaAddress = "3Nh6zJvJK6jY8t9LnGN9EmqCcTZbHVRRWkpBz1FEz1Zt";
    expect(solanaAddress.length).toBeGreaterThanOrEqual(32);
    for (const candidate of candidatesIn(`Send to ${solanaAddress} please`)) {
      expect(looksLikeBase64Secret(candidate)).toBe(false);
    }
  });

  it("does not flag a real EVM tx hash / address as a base64 secret", () => {
    const txHash =
      "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const address = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
    for (const candidate of candidatesIn(`tx ${txHash} from ${address}`)) {
      expect(looksLikeBase64Secret(candidate)).toBe(false);
    }
  });

  it("does not treat a short benign base64-like payload as a candidate", () => {
    // "hello" base64-encoded — 8 chars, well under the 20-char core floor.
    const benign = "aGVsbG8=";
    expect(candidatesIn(`token=${benign}`)).toEqual([]);
  });

  it("does not form a candidate out of ordinary prose", () => {
    const prose =
      "I want to buy some tokens on the exchange today for my portfolio, please help me decide.";
    expect(candidatesIn(prose)).toEqual([]);
  });
});
