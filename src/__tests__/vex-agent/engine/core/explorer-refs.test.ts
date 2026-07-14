/**
 * Stage 2 — `deriveExplorerRefs` unit coverage.
 *
 * Locks the coherent pairing contract (chain + txRef from the SAME capture),
 * the items-vs-single source selection, normalization, bounds, dedupe, and the
 * refusal to combine a capture's chain with an unrelated top-level hash.
 */

import { describe, it, expect } from "vitest";
import { deriveExplorerRefs } from "@vex-agent/engine/core/explorer-refs.js";

describe("deriveExplorerRefs", () => {
  it("returns [] for undefined data / no captures", () => {
    expect(deriveExplorerRefs(undefined)).toEqual([]);
    expect(deriveExplorerRefs({})).toEqual([]);
    expect(deriveExplorerRefs({ txHash: "0xdead", chain: "ethereum" })).toEqual([]);
  });

  it("derives a coherent ref from a single _tradeCapture (EVM signature=hash)", () => {
    const refs = deriveExplorerRefs({
      txHash: "0xtop",
      _tradeCapture: { chain: "Base", signature: "0xabc", walletAddress: "0xw" },
    });
    // Chain lowercased; txRef = capture.signature (case preserved); the
    // unrelated top-level `txHash` is NEVER used.
    expect(refs).toEqual([{ chain: "base", txRef: "0xabc" }]);
  });

  it("prefers capture.txHash over capture.signature", () => {
    const refs = deriveExplorerRefs({
      _tradeCapture: { chain: "solana", txHash: "hashwins", signature: "sigloses" },
    });
    expect(refs).toEqual([{ chain: "solana", txRef: "hashwins" }]);
  });

  it("derives one ref per _tradeCaptureItems entry (coherent per item)", () => {
    const refs = deriveExplorerRefs({
      txHash: "0xtop",
      _tradeCapture: { chain: "base", signature: "0xsummary" },
      _tradeCaptureItems: [
        { chain: "base", signature: "0xleg1" },
        { chain: "arbitrum", txHash: "0xleg2" },
      ],
    });
    // Items win over the single capture; each pairs its OWN chain.
    expect(refs).toEqual([
      { chain: "base", txRef: "0xleg1" },
      { chain: "arbitrum", txRef: "0xleg2" },
    ]);
  });

  it("dedupes items that share a chain+txRef (e.g. pendle PT/YT legs)", () => {
    const refs = deriveExplorerRefs({
      _tradeCaptureItems: [
        { chain: "base", signature: "0xsame" },
        { chain: "base", signature: "0xsame" },
      ],
    });
    expect(refs).toEqual([{ chain: "base", txRef: "0xsame" }]);
  });

  it("falls back to the single capture when items is an empty array", () => {
    const refs = deriveExplorerRefs({
      _tradeCapture: { chain: "solana", signature: "onlysig" },
      _tradeCaptureItems: [],
    });
    expect(refs).toEqual([{ chain: "solana", txRef: "onlysig" }]);
  });

  it("skips captures missing a chain or a txRef (e.g. HyperCore perps)", () => {
    const refs = deriveExplorerRefs({
      _tradeCapture: {
        chain: "hyperliquid",
        positionKey: "hyperliquid:perp:BTC:0xw",
        // no txHash / signature
      },
    });
    expect(refs).toEqual([]);
  });

  it("ignores non-string chain/txRef values", () => {
    expect(
      deriveExplorerRefs({ _tradeCapture: { chain: 999, signature: "0xabc" } }),
    ).toEqual([]);
    expect(
      deriveExplorerRefs({ _tradeCapture: { chain: "base", signature: 12345 } }),
    ).toEqual([]);
  });

  it("trims and normalizes chain case; trims txRef", () => {
    const refs = deriveExplorerRefs({
      _tradeCapture: { chain: "  Solana ", signature: "  sig123  " },
    });
    expect(refs).toEqual([{ chain: "solana", txRef: "sig123" }]);
  });

  it("skips blank-after-trim values", () => {
    expect(
      deriveExplorerRefs({ _tradeCapture: { chain: "   ", signature: "0xabc" } }),
    ).toEqual([]);
    expect(
      deriveExplorerRefs({ _tradeCapture: { chain: "base", signature: "   " } }),
    ).toEqual([]);
  });

  it("skips over-long chain (>64) or txRef (>128)", () => {
    expect(
      deriveExplorerRefs({
        _tradeCapture: { chain: "c".repeat(65), signature: "0xabc" },
      }),
    ).toEqual([]);
    expect(
      deriveExplorerRefs({
        _tradeCapture: { chain: "base", signature: "a".repeat(129) },
      }),
    ).toEqual([]);
  });

  it("caps the output at 8 refs", () => {
    const refs = deriveExplorerRefs({
      _tradeCaptureItems: Array.from({ length: 20 }, (_, i) => ({
        chain: "base",
        signature: `0x${i}`,
      })),
    });
    expect(refs).toHaveLength(8);
    expect(refs[0]).toEqual({ chain: "base", txRef: "0x0" });
    expect(refs[7]).toEqual({ chain: "base", txRef: "0x7" });
  });

  // ── Explicit `_explorerRefs` merge (relay multi-hop, wallet-send failure) ──

  it("merges explicit `_explorerRefs` with capture refs, deduped", () => {
    const refs = deriveExplorerRefs({
      _tradeCapture: { chain: "8453", signature: "0xorigin" },
      _explorerRefs: [
        { chain: "8453", txRef: "0xorigin" }, // dupes the capture → collapses
        { chain: "4663", txRef: "0xdest" }, // destination hop → added
      ],
    });
    expect(refs).toEqual([
      { chain: "8453", txRef: "0xorigin" },
      { chain: "4663", txRef: "0xdest" },
    ]);
  });

  it("derives refs from `_explorerRefs` alone (wallet-send failure path)", () => {
    // A broadcast-but-failed transfer has no `_tradeCapture`, only the ref.
    const refs = deriveExplorerRefs({
      _explorerRefs: [{ chain: "Base", txRef: "0xreverted" }],
    });
    // Chain lowercased/trimmed exactly like capture refs.
    expect(refs).toEqual([{ chain: "base", txRef: "0xreverted" }]);
  });

  it("validates `_explorerRefs` entries with the same bounds (skips junk)", () => {
    const refs = deriveExplorerRefs({
      _explorerRefs: [
        { chain: 8453, txRef: "0xa" }, // non-string chain → skipped
        { chain: "base", txRef: "" }, // blank txRef → skipped
        { chain: "base", txRef: "c".repeat(129) }, // oversize → skipped
        { chain: "  arbitrum ", txRef: "  0xok  " }, // trimmed + kept
        "not-an-object", // non-record → skipped
      ],
    });
    expect(refs).toEqual([{ chain: "arbitrum", txRef: "0xok" }]);
  });

  it("bounds the candidate SCAN (a pathological array is not walked in full)", () => {
    // 100 leading junk entries exhaust the 32-entry scan budget before the
    // valid tail is ever reached — inspection cost stays bounded.
    const items = [
      ...Array.from({ length: 100 }, () => ({ chain: "base" })), // no txRef → junk
      { chain: "base", signature: "0xnever_reached" },
    ];
    expect(deriveExplorerRefs({ _tradeCaptureItems: items })).toEqual([]);
  });

  it("ignores a non-array `_explorerRefs`", () => {
    expect(
      deriveExplorerRefs({ _explorerRefs: { chain: "base", txRef: "0xa" } }),
    ).toEqual([]);
  });
});
