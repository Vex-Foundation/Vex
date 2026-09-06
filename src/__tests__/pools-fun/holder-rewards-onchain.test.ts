/**
 * `readPoolsHolderRewardsOnChain` - the five outcomes, and the two absences that
 * must never be rendered as zero.
 *
 * The chain is stubbed at the CLIENT-FACTORY seam, so the log filter, the
 * multicall index arithmetic, the ordinal mapping and the paired-leg decision
 * are the code under test. The replayed values come from the committed chain
 * capture rather than from numbers invented here.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import * as evmClient from "@tools/evm-chains/evm-client.js";
import { readPoolsHolderRewardsOnChain } from "@tools/pools-fun/holder-rewards/read.js";
import { POOLS_SUITES } from "@tools/pools-fun/constants.js";
import { captureResponse, CAPTURES } from "./_captures.js";

const TOKEN = "0x07801a668adf02e806ef8ef5a54804747afdfdf7" as const;
const WALLET = "0xca11bde05977b3631167028862be2a173976ca11" as const;

const ordinals = captureResponse(CAPTURES.chainRewardModeOrdinals) as {
  events: Record<string, { token: string; logs: { distributor: string; rewardModeWire: number }[] }>;
};

interface StubOptions {
  readonly logs?: { distributor: string; rewardModeWire: number }[];
  readonly logsThrow?: boolean;
  readonly failing?: readonly string[];
}

function stubChain(options: StubOptions = {}) {
  const logs = options.logs ?? ordinals.events.both!.logs;
  const failing = new Set(options.failing ?? []);
  const values: Record<string, unknown> = {
    earned: 1500000000000000000n,
    earnedPaired: 250000000000000000n,
    rewardExcluded: false,
    rewardMode: 2,
    token: TOKEN,
    pairedAsset: `0x${"9".repeat(40)}`,
    factory: POOLS_SUITES[2]!.factory,
    eligibleSupply: 1322257129358659407244569n,
    periodFinish: 1788607809n,
    rewardRate: 0n,
    remainingStream: 0n,
    isStockPair: true,
    decimals: 18,
    symbol: "DRBRH",
  };
  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
    getBlockNumber: async () => 54467839n,
    getLogs: async () => {
      if (options.logsThrow === true) throw new Error("log range refused");
      return logs.map((log) => ({ args: { distributor: log.distributor, rewardMode: log.rewardModeWire } }));
    },
    multicall: async (args: { contracts: { functionName: string }[] }) =>
      args.contracts.map((call) =>
        failing.has(call.functionName)
          ? { status: "failure", error: new Error("no data") }
          : { status: "success", result: values[call.functionName] }),
  } as never);
}

afterEach(() => vi.restoreAllMocks());

describe("readPoolsHolderRewardsOnChain", () => {
  it("takes the distributor and the mode from the deployer's event", async () => {
    stubChain();
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.distributor.toLowerCase()).toBe(ordinals.events.both!.logs[0]!.distributor.toLowerCase());
    expect(result.rewardMode).toBe("both");
    expect(result.rewardModeWire).toBe(2);
    expect(result.blockNumber).toBe("54467839");
    expect(result.tokenLeg.earnedRaw).toBe("1500000000000000000");
    expect(result.pairedLeg?.earnedRaw).toBe("250000000000000000");
  });

  it("a distributor without earnedPaired has NO paired leg, not a zero one", async () => {
    stubChain({ failing: ["earnedPaired"] });
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pairedLeg).toBeNull();
  });

  it("a distributor without rewardMode() still reports the event's mode", async () => {
    stubChain({ failing: ["rewardMode"] });
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.distributorSelfReportedMode).toBeNull();
    expect(result.rewardMode).toBe("both");
  });

  it("no event for the token is a FACT: no holder rewards", async () => {
    stubChain({ logs: [] });
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status).toBe("no_holder_rewards");
  });

  it("suite V1 has no deployer at all, and says so instead of reading nothing", async () => {
    stubChain();
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 1 });
    expect(result.status).toBe("suite_without_holder_rewards");
  });

  it("an unregistered token is a different outcome from having no rewards", async () => {
    stubChain();
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: null });
    expect(result.status).toBe("token_not_registered");
  });

  it("a refused log query proves nothing, and never becomes no_holder_rewards", async () => {
    stubChain({ logsThrow: true });
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.detail).toContain("was NOT established");
  });

  it("an earned() that did not answer is unavailable, never zero", async () => {
    stubChain({ failing: ["earned"] });
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.detail).toContain("not the same as zero");
  });

  it("the token-mode event maps to the token mode, from the same capture", async () => {
    stubChain({ logs: ordinals.events.token!.logs });
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status === "ok" && result.rewardMode).toBe("token");
  });

  it("the paired-mode event maps to the paired mode", async () => {
    stubChain({ logs: ordinals.events.paired!.logs });
    const result = await readPoolsHolderRewardsOnChain({ token: TOKEN, wallet: WALLET, suiteVersion: 3 });
    expect(result.status === "ok" && result.rewardMode).toBe("paired");
  });
});
