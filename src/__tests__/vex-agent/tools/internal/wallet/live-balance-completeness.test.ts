/**
 * GATED live smoke for the completeness axes and the refused-entry disclosure
 * on BOTH balance surfaces (rule 10: a green fixture suite is necessary and
 * never sufficient).
 *
 * Runs ONLY with `VEX_LIVE_EVM=1` and an address in `VEX_LIVE_EVM_ADDRESS`; the
 * address is a public on-chain identifier supplied by the operator and is
 * deliberately NOT committed. Strictly READ-ONLY, and bounded to the politeness
 * budget the brief set: ONE `WalletBalances` scan plus ONE
 * `khalani.tokens.balances` read, sequentially.
 *
 * Only the wallet SELECTION is scripted, because the live address is supplied
 * by the operator rather than by the machine's wallet inventory. Everything the
 * axes are computed from - the Khalani multi-chain scan, the local-chain RPC
 * reads and their scan-set build, the DexScreener pricing, the projection - is
 * the real chain over real bytes.
 *
 * Assertions are INVARIANT only, never a live balance or price: both move
 * between runs, and a test that pinned them would fail for being correct. Set
 * `VEX_LIVE_EVM_ARCHIVE` to a directory path to archive the completeness
 * envelope with provenance; the wallet address is never archived in full.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";

const LIVE_ADDRESS = process.env.VEX_LIVE_EVM_ADDRESS ?? "";
const enabled = process.env.VEX_LIVE_EVM === "1" && LIVE_ADDRESS !== "";

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/internal/wallet/resolve.js")
  >();
  return {
    ...actual,
    resolveSelectedAddressForRead: () => process.env.VEX_LIVE_EVM_ADDRESS ?? "",
    resolveSelectedAddress: () => process.env.VEX_LIVE_EVM_ADDRESS ?? "",
  };
});

interface LiveSnapshot {
  wallet: string;
  address: string;
  tokens: unknown[];
  tokenCount: number;
  totalUsd: number;
  scannedChainIds: number[];
  chainErrors: Array<{ chainId: number; message: string }>;
  inventoryComplete: boolean;
  inventorySources: Array<{
    chainId: number;
    source: string;
    result: string;
    exhaustive: boolean;
    observedAt: string | null;
  }>;
  inventoryIncompleteReason?: string;
  valuationComplete: boolean;
  unpricedHeldCount: number;
  pricedTotalUsd: string;
  totalUsdBasis: string;
  failedChainIds: number[];
  rejectedEntryCount: number;
  rejectedEntries: unknown[];
  truncated: boolean;
}

interface LiveEnvelope extends Omit<LiveSnapshot, "wallet" | "tokenCount" | "rejectedEntryCount" | "rejectedEntries" | "truncated" | "scannedChainIds" | "chainErrors"> {
  walletCount: number;
  wallets: LiveSnapshot[];
}

function archive(name: string, payload: unknown): void {
  const directory = process.env.VEX_LIVE_EVM_ARCHIVE;
  if (!directory) return;
  writeFileSync(
    path.join(directory, name),
    JSON.stringify(
      {
        provenance: {
          probe: name,
          at: new Date().toISOString(),
          addressRedacted: `${LIVE_ADDRESS.slice(0, 6)}...`,
        },
        payload,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe.skipIf(!enabled)("live balance completeness", () => {
  it("WalletBalances reports both axes over the real chain", async () => {
    const { handleWalletBalances } = await import(
      "@vex-agent/tools/internal/wallet/read.js"
    );
    const { makeTestContext } = await import("../../_test-context.js");

    const result = await handleWalletBalances({ walletFamily: "eip155" }, makeTestContext());
    expect(result.success).toBe(true);
    const envelope: LiveEnvelope = JSON.parse(result.output);
    // The archive keeps the completeness evidence and NOT the wallet address or
    // its holdings: the redacted prefix in `provenance` is the only identity it
    // needs to be traceable (privacy rule, data minimisation).
    archive("wallet-balances-completeness.json", {
      ...envelope,
      wallets: envelope.wallets.map(({ tokens: _rows, address: _address, ...snapshot }) => snapshot),
    });

    // INVARIANTS, not values. Every one of these is a claim the axes make about
    // themselves and would be false under the defect they replace.
    expect(typeof envelope.inventoryComplete).toBe("boolean");
    expect(typeof envelope.valuationComplete).toBe("boolean");
    expect(envelope.totalUsdBasis).toBe(
      envelope.inventoryComplete && envelope.valuationComplete ? "complete" : "priced_only",
    );
    expect(Number.isNaN(Number(envelope.pricedTotalUsd))).toBe(false);
    expect(envelope.unpricedHeldCount).toBeGreaterThanOrEqual(0);

    for (const snapshot of envelope.wallets) {
      // A source that failed is never stamped with a fresh observation time.
      for (const source of snapshot.inventorySources) {
        expect(source.observedAt === null).toBe(source.result === "failed");
      }
      // Every failed chain is reachable from the sources, and vice versa.
      expect([...snapshot.failedChainIds].sort((a, b) => a - b)).toEqual(
        [
          ...new Set(
            snapshot.inventorySources
              .filter((source) => source.result === "failed")
              .map((source) => source.chainId),
          ),
        ].sort((a, b) => a - b),
      );
      // A bounded local source can never claim a complete inventory.
      if (snapshot.inventorySources.some((source) => !source.exhaustive)) {
        expect(snapshot.inventoryComplete).toBe(false);
      }
      expect(snapshot.rejectedEntries.length).toBeLessThanOrEqual(20);
      expect(snapshot.rejectedEntries.length).toBeLessThanOrEqual(snapshot.rejectedEntryCount);
    }
  }, 300_000);

  it("khalani.tokens.balances discloses its refused entries over the real chain", async () => {
    const { handleTokenBalances } = await import(
      "@vex-agent/tools/protocols/khalani/handlers/read.js"
    );
    const { makeProtocolContext } = await import("../../_test-context.js");

    const result = await handleTokenBalances({ walletFamily: "eip155" }, makeProtocolContext());
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output) as {
      address: string;
      rejectedEntryCount: number;
      rejectedEntries: unknown[];
      rejectedEntriesOmitted?: number;
      truncated: boolean;
      truncationNote?: string;
      tokens: unknown[];
    };
    const { tokens, address: _address, ...disclosure } = payload;
    archive("khalani-token-balances-rejected.json", { ...disclosure, tokenCount: tokens.length });

    expect(typeof payload.rejectedEntryCount).toBe("number");
    expect(payload.rejectedEntries.length).toBeLessThanOrEqual(20);
    expect(payload.truncated).toBe(payload.rejectedEntriesOmitted !== undefined);
    if (payload.truncated) expect(payload.truncationNote).toBeDefined();
  }, 300_000);
});
