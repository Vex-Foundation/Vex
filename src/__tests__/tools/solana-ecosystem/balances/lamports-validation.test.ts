/**
 * `getBalance` lamports are UNTRUSTED input, and the sync owner WRITES them.
 *
 * The RPC answers lamports as a JSON number, so the wire can deliver a float, a
 * negative, a value past 2^53, or (from a malformed body) NaN. Any of those
 * used to reach `String(lamports)` and become a `proj_balances` row: "NaN" as a
 * balance, or a silently rounded one. The reader now refuses the whole read
 * instead, which the sync owner treats as a skip and therefore keeps the
 * last-good rows. Failing closed is the only safe direction on a money path.
 *
 * The token-account calls are scripted to return nothing, so each case isolates
 * exactly one thing: what the reader does with the lamports value.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockReadTokensPairs = vi.fn().mockResolvedValue([]);
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
}));

const mockKhalaniScan = vi.fn().mockResolvedValue({ tokens: [], scannedChainIds: [], chainErrors: [] });
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...args: unknown[]) => mockKhalaniScan(...args),
}));

const { readSolanaWalletBalances } = await import(
  "@tools/solana-ecosystem/balances/read-wallet-balances.js"
);

const OWNER = "BfvP43eVzM7xAu6Pm7yYbqp8RVkbP8R8dCfTvgPp64Pg";

function rpcReturning(lamports: number) {
  return {
    getBalance: (_publicKey: PublicKey) => Promise.resolve(lamports),
    getParsedTokenAccountsByOwner: () =>
      Promise.resolve({ value: [] as ReadonlyArray<{ pubkey: PublicKey; account: { data: unknown } }> }),
  };
}

describe("lamports validation", () => {
  it("accepts the probed live value and keeps it an exact decimal string", async () => {
    // 96740111 lamports: the value the 2026-08-26 live getBalance probe returned
    // (`fixtures/solana/getBalance-response.json`).
    const read = await readSolanaWalletBalances(OWNER, { rpc: rpcReturning(96740111) });
    expect(read.lamports).toBe("96740111");
    expect(read.accountFailures).toEqual([]);
  });

  it("accepts a zero balance", async () => {
    const read = await readSolanaWalletBalances(OWNER, { rpc: rpcReturning(0) });
    expect(read.lamports).toBe("0");
  });

  const refused: ReadonlyArray<readonly [string, number]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative balance", -1],
    ["a fractional lamport", 1.5],
    ["a value past the safe-integer range", Number.MAX_SAFE_INTEGER + 2],
  ];

  for (const [label, value] of refused) {
    it(`refuses ${label} with a typed failure instead of writing it`, async () => {
      const err = await readSolanaWalletBalances(OWNER, { rpc: rpcReturning(value) }).catch(
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("SolanaRpcResponseInvalidError");
      // The message names the call and the reason, and carries no response body
      // and no RPC URL: this string reaches a log line.
      expect((err as Error).message).toContain("getBalance");
      expect((err as Error).message).not.toContain("http");
    });
  }

  it("never lets an invalid value through as the string 'NaN'", async () => {
    const read = await readSolanaWalletBalances(OWNER, { rpc: rpcReturning(Number.NaN) }).catch(
      () => null,
    );
    expect(read).toBeNull();
  });
});
