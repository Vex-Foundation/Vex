/**
 * `khalani.tokens.balances` discloses the balance entries the boundary REFUSED.
 *
 * WHY THIS FILE EXISTS. The balances endpoint is the one Khalani surface an
 * attacker can reach without our consent: anyone can mint a token with hostile
 * `decimals` and airdrop it into a wallet. The boundary therefore refuses per
 * entry instead of failing the chain, and this tool is one of the two live
 * readers that has to say what was refused. Silence here would be the exact
 * failure the strict boundary was built to avoid: a holding that exists,
 * missing from the answer, indistinguishable from one the wallet does not have.
 *
 * The handler under test is the REAL one; only the scan boundary is scripted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeProtocolContext } from "../_test-context.js";

const EVM_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return { ...original, getTokenBalancesAcrossChains: (...args: unknown[]) => mockScan(...args) };
});

vi.mock("../../../../vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../vex-agent/tools/internal/wallet/resolve.js")
  >();
  return { ...actual, resolveSelectedAddress: () => EVM_WALLET };
});

const { handleTokenBalances } = await import(
  "@vex-agent/tools/protocols/khalani/handlers/read.js"
);

const CONTEXT = makeProtocolContext();

function rejected(index: number, balanceRaw: string | null) {
  return {
    entryIndex: index,
    chainId: 1,
    address: `0xr${index}`,
    name: `Rejected ${index}`,
    symbol: `R${index}`,
    balanceRaw,
    reason: "token_decimals_invalid" as const,
  };
}

function scan(rejectedEntries: ReturnType<typeof rejected>[]) {
  return {
    address: EVM_WALLET,
    family: "eip155" as const,
    tokens: [],
    scannedChainIds: [1],
    chainErrors: [],
    totalUsd: 0,
    rejectedEntries,
  };
}

async function readBalances() {
  const result = await handleTokenBalances({ walletFamily: "eip155" }, CONTEXT);
  expect(result.success).toBe(true);
  return {
    data: result.data as Record<string, unknown>,
    output: JSON.parse(result.output) as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("khalani.tokens.balances - refused balance entries", () => {
  it("reports an empty, PRESENT disclosure when nothing was refused", async () => {
    mockScan.mockResolvedValue(scan([]));

    const { data, output } = await readBalances();

    // Present and empty, never absent: an absent field reads as "no answer".
    for (const payload of [data, output]) {
      expect(payload.rejectedEntryCount).toBe(0);
      expect(payload.rejectedEntries).toEqual([]);
      expect(payload.truncated).toBe(false);
      expect(payload).not.toHaveProperty("rejectedEntriesOmitted");
      expect(payload).not.toHaveProperty("truncationNote");
    }
  });

  it("carries each refused entry verbatim, and never the decimals that failed", async () => {
    mockScan.mockResolvedValue(scan([rejected(0, "500"), rejected(1, null)]));

    const { data, output } = await readBalances();

    for (const payload of [data, output]) {
      expect(payload.rejectedEntryCount).toBe(2);
      expect(payload.rejectedEntries).toEqual([rejected(0, "500"), rejected(1, null)]);
      expect(payload.rejectedEntries).not.toHaveProperty("0.decimals");
    }
  });

  it("bounds the list at 20 and names both the surplus and the recovery", async () => {
    mockScan.mockResolvedValue(
      scan(Array.from({ length: 31 }, (_unused, index) => rejected(index, "1"))),
    );

    const { data } = await readBalances();

    expect(data.rejectedEntryCount).toBe(31);
    expect(data.rejectedEntries).toHaveLength(20);
    expect(data.rejectedEntriesOmitted).toBe(11);
    // A bound that cannot say what it left out is a silent cut.
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("rejectedEntryCount");
    expect(String(data.truncationNote)).toContain("no parameter widens this list");
  });

  it("reads a scan result that carries no rejectedEntries field as none refused", async () => {
    const { rejectedEntries: _dropped, ...withoutField } = scan([]);
    mockScan.mockResolvedValue(withoutField);

    const { data } = await readBalances();

    expect(data.rejectedEntryCount).toBe(0);
    expect(data.truncated).toBe(false);
  });
});
