/**
 * THE LEG HAS A DEADLINE, and the deadline is what the sweep's other queues get
 * back.
 *
 * The defect this pins (external review of PR #142, blocker 2): every candidate
 * had a 15 s transport timeout AND one transport retry, and the widened
 * candidate list made six candidates realistic, so ONE leg of ONE row could hold
 * the shared sync worker for three minutes while balance and settlement sync
 * waited behind the same drain. The sweep takes 25 rows per run at a 120 s
 * cadence, so the row was the wrong unit to leave unbounded.
 *
 * Time is FAKE here on purpose (VS Code's `runWithFakedTimers` deadline tests,
 * `src/vs/base/test/common/async.test.ts`, are the pattern): a deadline that can
 * only be proven by waiting 20 real seconds would never be run.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

import {
  BRIDGE_LEG_VERIFICATION_DEADLINE_MS,
  BRIDGE_RPC_CANDIDATE_TIMEOUT_MS,
  VERIFICATION_REASONS,
} from "@vex-agent/sync/bridge-activity-repair-contracts.js";

/** What each candidate URL does when it is probed, in candidate order. */
type CandidateScript = { readonly hangs: true } | { readonly hangs: false; readonly receiptStatus: string };

let script: CandidateScript[] = [];
let rpcUrls: string[] = [];
/** How long the provider registry takes to answer, in fake milliseconds. */
let registryDelayMs = 0;
const probed: string[] = [];

vi.mock("viem", () => ({
  http: (url: string) => url,
  createPublicClient: ({ transport }: { transport: string }) => {
    probed.push(transport);
    const step = script.shift() ?? { hangs: true as const };
    const hang = <T,>(): Promise<T> => new Promise<T>(() => undefined);
    return {
      getChainId: async () => (step.hangs ? hang<number>() : 42161),
      getTransactionReceipt: async () => (step.hangs ? hang<{ status: string }>() : { status: step.receiptStatus }),
    };
  },
}));

vi.mock("@vex-agent/sync/solana-rpc-safety.js", () => ({
  SOLANA_MAINNET_GENESIS: "genesis",
  selectVerificationRpcUrls: () => rpcUrls,
  solanaRpcCall: vi.fn(),
}));

vi.mock("@config/chain-rpc-overrides.js", () => ({ getUserRpcOverridesForChain: () => [] }));
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: () => null,
  getLocalChainRpcUrl: () => "",
}));
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () => {
    // A registry that is slow rather than broken: the old code awaited it with
    // no budget at all, before any RPC timeout applied.
    await new Promise<void>((resolve) => setTimeout(resolve, registryDelayMs));
    return [];
  },
}));
vi.mock("@tools/relay/client.js", () => ({ getCachedRelayChains: async () => [] }));

const { verifyBridgeLegOnChain } = await import("@vex-agent/sync/bridge-activity-repair-verification.js");

const HASH = `0x${"b".repeat(64)}`;

function input() {
  return {
    txHash: HASH,
    expectedChainId: 42161,
    chainFamily: "eip155" as const,
    protocol: "relay",
    tokenOutAddress: null,
    recipient: null,
  };
}

/**
 * Run one verification against the fake clock and report how much VIRTUAL time
 * it consumed. The generous advance (three deadlines) is what makes an
 * unbounded leg fail this test instead of hanging it.
 */
async function measureLegVerification(): Promise<{ elapsedMs: number; result: Awaited<ReturnType<typeof verifyBridgeLegOnChain>> }> {
  const startedAt = Date.now();
  let elapsedMs = -1;
  const pending = verifyBridgeLegOnChain(input()).then((result) => {
    elapsedMs = Date.now() - startedAt;
    return result;
  });
  await vi.advanceTimersByTimeAsync(BRIDGE_LEG_VERIFICATION_DEADLINE_MS * 3);
  return { elapsedMs, result: await pending };
}

/**
 * Load every dynamically imported module (viem, the three registries) BEFORE the
 * fake clock starts. A module load settles on a real I/O turn, which a fake
 * clock does not wait for, so a cold import inside a measured run would be
 * overtaken by the virtual deadline and measure nothing.
 */
beforeAll(async () => {
  rpcUrls = ["https://warm-up"];
  script = [{ hangs: false, receiptStatus: "success" }];
  await verifyBridgeLegOnChain(input());
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  script = [];
  rpcUrls = [];
  registryDelayMs = 0;
  probed.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one leg of one row cannot occupy the shared sync worker", () => {
  it("six unresponsive candidates behind a slow registry still finish inside the leg deadline", async () => {
    registryDelayMs = 3_000;
    rpcUrls = ["https://a", "https://b", "https://c", "https://d", "https://e", "https://f"];
    script = Array.from({ length: 6 }, () => ({ hangs: true as const }));

    const { elapsedMs, result } = await measureLegVerification();

    expect(elapsedMs).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThanOrEqual(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
    expect(result.verified).toBe(false);
    // Typed, in the stored vocabulary, and terminalizes nothing: the row stays
    // pending and is retried on the next tick.
    expect(VERIFICATION_REASONS).toContain(result.reason);
    expect(result.reason).toBe("rpc_unreachable");
  });

  it("abandons a hung candidate at its own timeout rather than at the leg deadline", async () => {
    rpcUrls = ["https://a", "https://b"];
    script = [{ hangs: true }, { hangs: false, receiptStatus: "success" }];

    const { elapsedMs, result } = await measureLegVerification();

    expect(result).toEqual({ verified: true });
    expect(probed).toEqual(["https://a", "https://b"]);
    // One candidate timeout, not one leg deadline: the second candidate got its
    // turn with the rest of the budget intact.
    expect(elapsedMs).toBeGreaterThanOrEqual(BRIDGE_RPC_CANDIDATE_TIMEOUT_MS);
    expect(elapsedMs).toBeLessThan(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
  });

  it("a settlement found on candidate three still wins", async () => {
    rpcUrls = ["https://a", "https://b", "https://c", "https://d"];
    script = [{ hangs: true }, { hangs: true }, { hangs: false, receiptStatus: "success" }];

    const { elapsedMs, result } = await measureLegVerification();

    expect(result).toEqual({ verified: true });
    expect(probed).toEqual(["https://a", "https://b", "https://c"]);
    expect(elapsedMs).toBeLessThanOrEqual(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
  });

  it("a registry that outlasts the whole budget reports a typed reason and no candidates", async () => {
    registryDelayMs = BRIDGE_LEG_VERIFICATION_DEADLINE_MS * 2;
    rpcUrls = ["https://a"];

    const { elapsedMs, result } = await measureLegVerification();

    expect(elapsedMs).toBeLessThanOrEqual(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
    expect(probed).toEqual([]);
    expect(result.verified).toBe(false);
    // Nothing was observed, so nothing more specific can honestly be claimed.
    expect(result.reason).toBe("verification_failed");
    expect(VERIFICATION_REASONS).toContain(result.reason);
  });
});
