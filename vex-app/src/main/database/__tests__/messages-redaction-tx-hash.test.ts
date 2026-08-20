/**
 * `sanitizeToolArgs` — the hash-key exemption to the 32-byte-hex value rule.
 *
 * `agent_scan`, `chain_read` and the bridge-status flows legitimately take a
 * transaction hash as a PARAMETER, and a tx hash is public on-chain data. The
 * blanket HEX32 value rule turned those into `[redacted:key]` in the UI. The
 * exemption is deliberately narrow: it needs BOTH a key whose word-split
 * contains `hash` AND the exact `0x`+64-hex shape. Any other value under that
 * key still runs the full value ladder, and the key-name secret drop (layer 1)
 * still applies.
 */

import { describe, expect, it } from "vitest";
import { sanitizeToolArgs } from "../messages/redaction.js";

const HEX32 = `0x${"a".repeat(64)}`;

describe("sanitizeToolArgs - tx-hash args survive", () => {
  it.each(["txHash", "transactionHash", "hash", "tx_hash", "originTxHash"])(
    "keeps a 32-byte hex under the hash-shaped key %s",
    (key) => {
      const out = sanitizeToolArgs({ [key]: HEX32 });
      expect(out).toContain(HEX32);
      expect(out).not.toContain("[redacted:key]");
    },
  );

  it("still redacts a bare 32-byte hex under a NON-hash key", () => {
    const out = sanitizeToolArgs({ data: HEX32 });
    expect(out).toContain("[redacted:key]");
    expect(out).not.toContain(HEX32);
  });

  it("does not exempt a key that merely contains the letters 'hash'", () => {
    // `hashish` is one word and is NOT `hash` — word-split, not substring.
    const out = sanitizeToolArgs({ hashish: HEX32 });
    expect(out).toContain("[redacted:key]");
  });

  it("exempts ONLY the tx-hash SHAPE - other secret shapes still redact", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop";
    expect(sanitizeToolArgs({ txHash: jwt })).toContain("[redacted:jwt]");
    expect(sanitizeToolArgs({ hash: "b".repeat(70) })).toContain(
      "[redacted:secret]",
    );
  });

  it("still drops a secret-named key even when it also says hash", () => {
    const out = sanitizeToolArgs({ secretHash: HEX32, chain: "arbitrum" });
    expect(out).not.toContain("secretHash");
    expect(out).not.toContain(HEX32);
  });

  it("applies the exemption to a nested hash-shaped key", () => {
    expect(sanitizeToolArgs({ filter: { txHash: HEX32 } })).toContain(HEX32);
  });

  it("keeps a Solana-signature-length base58 under a hash-named key", () => {
    const sig87 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU";
    const sig88 = `${sig87}W`;
    expect(sanitizeToolArgs({ txHash: sig87 })).toContain(sig87);
    expect(sanitizeToolArgs({ hash: sig88 })).toContain(sig88);
  });

  it("still redacts a Solana-signature-length base58 under a NON-hash key", () => {
    const sig88 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const out = sanitizeToolArgs({ blob: sig88 });
    expect(out).toContain("[redacted:secret]");
    expect(out).not.toContain(sig88);
  });

  it("still redacts an out-of-window base58 under a hash-named key", () => {
    const short60 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKh";
    expect(short60).toHaveLength(60);
    expect(sanitizeToolArgs({ txHash: short60 })).toContain("[redacted:secret]");
  });

  it("does NOT inherit the exemption into array elements (known narrow scope)", () => {
    // An array element carries no key of its own, so the value rules apply
    // unchanged. A plural `txHashes` arg still redacts — accepted for now;
    // widening this is a separate, explicit decision.
    expect(sanitizeToolArgs({ hash: [HEX32] })).toContain("[redacted:key]");
  });
});
