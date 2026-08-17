/**
 * `morpho.wallet.balance` - the on-chain balance and Morpho-allowance read.
 *
 * THE READS ARE DRIVEN BY A STUB CLIENT, deliberately, and the numbers in it are
 * not invented. They are the LIVE CAPTURE of 2026-08-14 against Base
 * (`https://base-rpc.publicnode.com`, Multicall3 at the canonical address) for
 * wallet 0x245f...f02e, reproduced here so the suite is deterministic and
 * offline. The regeneration path is
 * `readMorphoWalletSnapshot(8453, "0x245fcfd93908A7a52F584AAc67B7F47657ADf02e",
 * [USDC, WETH])`.
 *
 * A stub rather than a recorded HTTP body is the right shape for exactly one
 * reason: the behaviour most worth pinning here is a MIXED multicall result, one
 * contract failing while its neighbours succeed. A live capture cannot be relied
 * on to produce that on demand, and it is the case where reporting a failure as
 * a zero would be most damaging.
 *
 * THE HEADLINE FIXTURE VALUE IS THE ONE THAT CHANGED THE CODE. The USDC approval
 * to Morpho Blue reads `...911329639935` against a true maximum of
 * `...913129639935`: an approval set to the maximum from which 1,800 USDC has
 * since been drawn. Exact matching alone reports it as bounded, which under-warns
 * by roughly 1e71 tokens, which is why `effectivelyUnlimited` exists beside
 * `unlimited`.
 */

import { describe, it, expect } from "vitest";

import type { PublicClient } from "viem";

import { readMorphoWalletSnapshot, resolveMorphoSpenders } from "@tools/morpho/wallet-reads.js";
import { UINT256_MAX } from "@tools/morpho/constants.js";
import { projectWalletSnapshot, countUnlimitedApprovals } from "@vex-agent/tools/protocols/morpho/projectors.js";
import { parseMorphoWalletBalanceParams } from "@vex-agent/tools/protocols/morpho/read-params.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";

const WALLET = "0x245fcfd93908A7a52F584AAc67B7F47657ADf02e";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

/** Live Base capture: max approval MINUS 1,800 USDC already drawn. */
const PARTLY_DRAWN_MAX = 115792089237316195423570985008687907853269984665640564039457584007911329639935n;

type Read = { status: "success"; result: unknown } | { status: "failure" };

function ok(result: unknown): Read {
  return { status: "success", result };
}

/**
 * A client whose multicall answers a caller-supplied script, in the flat order
 * `readMorphoWalletSnapshot` builds: decimals, symbol, balanceOf, then one
 * allowance per available spender, per token.
 */
function stubClient(options: { native?: bigint | Error; reads: Read[] }): PublicClient {
  return {
    getBalance: async () => {
      if (options.native instanceof Error) throw options.native;
      return options.native ?? 211088872510200n;
    },
    multicall: async () => options.reads,
  } as unknown as PublicClient;
}

/** The captured Base reads for USDC then WETH, four spenders each. */
function capturedBaseReads(): Read[] {
  return [
    ok(6),
    ok("USDC"),
    ok(18062n),
    ok(PARTLY_DRAWN_MAX),
    ok(0n),
    ok(0n),
    ok(BigInt(UINT256_MAX)),
    ok(18),
    ok("WETH"),
    ok(0n),
    ok(0n),
    ok(0n),
    ok(0n),
    ok(0n),
  ];
}

describe("morpho spender registry", () => {
  it("gives Base all four spenders, with the cross-checked Blue and Bundler3 addresses", () => {
    const { available, gaps } = resolveMorphoSpenders(8453);
    expect(gaps).toEqual([]);
    expect(available.map((s) => s.role)).toEqual(["morphoBlue", "bundler3", "generalAdapter1", "permit2"]);
    expect(available[0]?.address).toBe("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
    expect(available[1]?.address).toBe("0x6BFd8137e702540E7A42B74178A4a49Ba43920C4");
  });

  it("pins the Ethereum values recorded independently in the integration plan", () => {
    const { available } = resolveMorphoSpenders(1);
    expect(available[0]?.address).toBe("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
    expect(available[1]?.address).toBe("0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245");
    expect(available[3]?.address).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });

  it("REFUSES Permit2 by name on the two chains the registry has no address for", () => {
    for (const chainId of [143, 999]) {
      const { available, gaps } = resolveMorphoSpenders(chainId);
      expect(available.map((s) => s.role)).not.toContain("permit2");
      expect(gaps).toHaveLength(1);
      expect(gaps[0]?.role).toBe("permit2");
      // The gap must SAY why, so an agent cannot read the absence as "not approved".
      expect(gaps[0]?.reason).toContain("refuses");
    }
  });
});

describe("morpho.wallet.balance on-chain read", () => {
  it("reads the captured Base balances with their decimals", async () => {
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [USDC, WETH], {
      client: stubClient({ reads: capturedBaseReads() }),
    });
    expect(snapshot.native?.symbol).toBe("ETH");
    expect(snapshot.native?.balanceRaw).toBe("211088872510200");
    expect(snapshot.tokens).toHaveLength(2);
    expect(snapshot.tokens[0]).toMatchObject({ symbol: "USDC", decimals: 6, balanceRaw: "18062" });
    expect(snapshot.tokens[1]).toMatchObject({ symbol: "WETH", decimals: 18, balanceRaw: "0" });
    expect(snapshot.failures).toEqual([]);
  });

  it("separates an EXACT maximum approval from one that was partly drawn", async () => {
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [USDC, WETH], {
      client: stubClient({ reads: capturedBaseReads() }),
    });
    const usdc = snapshot.tokens[0];
    const blue = usdc?.allowances.find((a) => a.role === "morphoBlue");
    const permit2 = usdc?.allowances.find((a) => a.role === "permit2");

    // Partly drawn: no longer the exact maximum, still unbounded in practice.
    expect(blue?.raw).toBe(PARTLY_DRAWN_MAX.toString());
    expect(blue?.unlimited).toBe(false);
    expect(blue?.effectivelyUnlimited).toBe(true);

    // Pristine maximum: both flags.
    expect(permit2?.raw).toBe(UINT256_MAX);
    expect(permit2?.unlimited).toBe(true);
    expect(permit2?.effectivelyUnlimited).toBe(true);

    // A real zero is neither.
    const bundler = usdc?.allowances.find((a) => a.role === "bundler3");
    expect(bundler?.effectivelyUnlimited).toBe(false);
  });

  it("counts the partly-drawn approval, so the headline cannot read as zero risk", async () => {
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [USDC, WETH], {
      client: stubClient({ reads: capturedBaseReads() }),
    });
    expect(countUnlimitedApprovals(projectWalletSnapshot(snapshot, "base"))).toBe(2);
  });

  it("reports a FAILED balance read as unreadable, never as a zero balance", async () => {
    const reads = capturedBaseReads();
    reads[2] = { status: "failure" };
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [USDC, WETH], {
      client: stubClient({ reads }),
    });
    expect(snapshot.tokens.map((t) => t.symbol)).toEqual(["WETH"]);
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]?.reason).toContain("UNKNOWN, not zero");
  });

  it("drops a token whose decimals failed, because its amount has no scale", async () => {
    const reads = capturedBaseReads();
    reads[0] = { status: "failure" };
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [USDC, WETH], {
      client: stubClient({ reads }),
    });
    expect(snapshot.failures[0]?.reason).toContain("decimals()");
  });

  it("reports a FAILED allowance read as unknown, never as no approval", async () => {
    const reads = capturedBaseReads();
    reads[3] = { status: "failure" };
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [USDC, WETH], {
      client: stubClient({ reads }),
    });
    const usdc = snapshot.tokens[0];
    expect(usdc?.allowances.map((a) => a.role)).not.toContain("morphoBlue");
    expect(usdc?.allowanceGaps).toHaveLength(1);
    expect(usdc?.allowanceGaps[0]?.reason).toContain("UNKNOWN, not absent");
  });

  it("keeps a symbol failure cosmetic rather than dropping the row", async () => {
    const reads = capturedBaseReads();
    reads[1] = { status: "failure" };
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [USDC, WETH], {
      client: stubClient({ reads }),
    });
    expect(snapshot.tokens[0]?.symbol).toBeNull();
    expect(snapshot.tokens[0]?.balanceRaw).toBe("18062");
  });

  it("reports a failed NATIVE read as unavailable rather than as no gas", async () => {
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [], {
      client: stubClient({ native: new Error("connect ECONNREFUSED https://base-rpc.publicnode.com"), reads: [] }),
    });
    expect(snapshot.native).toBeNull();
    expect(snapshot.nativeFailure).not.toBeNull();
    // The RPC URL is scrubbed out of the agent-facing reason.
    expect(snapshot.nativeFailure).not.toContain("publicnode");
  });

  it("folds the native sentinel into the native read instead of calling it as an ERC-20", async () => {
    const snapshot = await readMorphoWalletSnapshot(8453, WALLET, [NATIVE_TOKEN_ADDRESS.toLowerCase()], {
      client: stubClient({ reads: [] }),
    });
    expect(snapshot.tokens).toEqual([]);
    expect(snapshot.native?.symbol).toBe("ETH");
  });

  it("names the chain's own native symbol rather than assuming ETH everywhere", async () => {
    const monad = await readMorphoWalletSnapshot(143, WALLET, [], { client: stubClient({ reads: [] }) });
    expect(monad.native?.symbol).toBe("MON");
    expect(monad.chainSpenderGaps.map((g) => g.role)).toEqual(["permit2"]);
  });
});

describe("morpho.wallet.balance params", () => {
  it("requires walletAddress and chain", () => {
    expect(parseMorphoWalletBalanceParams({}).ok).toBe(false);
    const noChain = parseMorphoWalletBalanceParams({ walletAddress: WALLET });
    expect(noChain.ok).toBe(false);
    if (!noChain.ok) expect(noChain.rejection.param).toBe("chain");
  });

  it("rejects a SYMBOL in tokenAddress by name", () => {
    const parsed = parseMorphoWalletBalanceParams({ walletAddress: WALLET, chain: "base", tokenAddress: "USDC" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection.param).toBe("tokenAddress");
  });

  it("rejects an unsupported chain with the supported list", () => {
    const parsed = parseMorphoWalletBalanceParams({ walletAddress: WALLET, chain: "katana" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection.message).toContain("base");
  });

  it("refuses an over-long token list rather than trimming it", () => {
    const many = Array.from({ length: 13 }, (_, i) => `0x${String(i).padStart(40, "0")}`).join(",");
    const parsed = parseMorphoWalletBalanceParams({ walletAddress: WALLET, chain: "base", tokenAddress: many });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection.message).toContain("at most");
  });

  it("echoes nativeOnly so an empty token list is visible rather than implied", () => {
    const parsed = parseMorphoWalletBalanceParams({ walletAddress: WALLET, chain: "base" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.echo["nativeOnly"]).toBe(true);
  });
});
