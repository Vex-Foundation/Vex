/**
 * `readPoolsOnChainSnapshot` gives every multicall member its OWN outcome.
 *
 * The defect this pins: a FAILED `getPoolInfo` call was mapped to
 * `registered: false`, which is the locker's answer for a token it never
 * registered. An RPC error and a real "not registered with pools.fun" then
 * looked identical to the handler, and the tool told the agent the second when
 * only the first had happened. The same collapse turned a failed `decimals()`
 * into `null`, indistinguishable from a value that is genuinely absent.
 *
 * `allowFailure` is on in the batch, so every member can fail independently -
 * which is exactly why every member needs its own outcome.
 *
 * SCOPE. This file owns the PER-MEMBER outcomes: the token's own reads, the fee
 * splits, and silence versus an answer. WHICH SUITE holds a token - the
 * cross-check between each suite's locker and its gateway, and the four verdicts
 * it can produce - is `suite-detection.test.ts`. The two were one question while
 * there was one locker; they are two questions now, and keeping them in one file
 * would mean every token-read case had to restate a whole suite table.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { readPoolsOnChainSnapshot } from "@tools/pools-fun/evm/token-registration.js";
import * as registry from "@tools/evm-chains/registry.js";
import * as evmClient from "@tools/evm-chains/evm-client.js";
import type { Address } from "viem";

const TOKEN = "0x0ab8d01664d4bb625705f9f3c595a8a19b3dcfb0" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = "0x50136d4174129585ec766eacf2f00cd1856690ca";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const CREATOR = "0x5793b76e33669334701c60297500fd05300e13af";

type Result = { status: "success"; result: unknown } | { status: "failure" };

const ok = (result: unknown): Result => ({ status: "success", result });
const failed: Result = { status: "failure" };

/** The locker's answer for a token it holds. */
const REGISTERED_POOL_INFO = ok([WETH, POOL, CREATOR, CREATOR, [123n]]);
/** The locker's all-zero answer for a token it never registered. */
const UNREGISTERED_POOL_INFO = ok([ZERO, ZERO, ZERO, ZERO, []]);
const SPLITS = ok([2000, 2500, 3000, 2500, 2000, 8000]);

/**
 * The batch, with one suite dialled and the other two answering "not mine".
 *
 * The module asks every known suite three questions (getPoolInfo, getPoolSplits,
 * launcherOf) before the token's own two reads, so a fixture that supplied only
 * four results would leave the real suites unanswered - and correctly produce
 * `unavailable`. These helpers keep the cases below about the member outcomes
 * they are actually testing.
 */
function suiteSlot(poolInfo: Result, splits: Result, launcher: Result): Result[] {
  return [poolInfo, splits, launcher];
}
/** A suite that answered and does not hold the token. */
const NOT_MINE = suiteSlot(UNREGISTERED_POOL_INFO, UNREGISTERED_POOL_INFO, ok(ZERO));
/** A suite that answered and holds it, with the given splits. */
const holds = (splits: Result): Result[] => suiteSlot(REGISTERED_POOL_INFO, splits, ok(CREATOR));
/** A suite that said nothing at all. */
const SILENT = suiteSlot(failed, failed, failed);

/**
 * One batch: three suite slots (V1, V2, V3 in table order) then decimals and
 * metadataUri. Written positionally so a reordered batch fails loudly rather
 * than quietly describing different questions.
 */
function batch(suites: Result[][], decimals: Result, metadataUri: Result): Result[] {
  return [...suites.flat(), decimals, metadataUri];
}

/** Stub the batch so each member can be dialled independently. */
function stubMulticall(results: Result[]): ReturnType<typeof vi.fn> {
  const multicall = vi.fn().mockResolvedValue(results);
  vi.spyOn(registry, "getLocalChain").mockReturnValue({ chainId: 4663 } as never);
  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
    getBlockNumber: () => Promise.resolve(39_620_464n),
    multicall,
  } as never);
  return multicall;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("the locker registration is tri-state", () => {
  it("registered: the locker answered with a real pool", async () => {
    stubMulticall(batch([NOT_MINE, NOT_MINE, holds(SPLITS)], ok(18), ok("ipfs://x")));
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);

    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") throw new Error("narrowing");
    expect(snapshot.locker.info.pool).toBe(POOL);
    expect(snapshot.locker.info.feeSplitBps?.creator).toBe(2000);
    expect(snapshot.locker.info.feeSplitAvailable).toBe(true);
    expect(snapshot.blockNumber).toBe("39620464");
  });

  it("unregistered: EVERY suite answered, and none holds it", async () => {
    stubMulticall(batch([NOT_MINE, NOT_MINE, NOT_MINE], ok(18), ok("")));
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);
    // A fact about the token, and it now takes three answers rather than one:
    // an all-zero row from the V1 locker alone is what made every V2 and V3
    // token look unregistered.
    expect(snapshot.locker.status).toBe("unregistered");
  });

  it("unavailable: a call FAILED, which proves nothing about the token", async () => {
    stubMulticall(batch([SILENT, NOT_MINE, NOT_MINE], ok(18), ok("ipfs://x")));
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);
    // The whole point: this must NOT come back as "unregistered".
    expect(snapshot.locker.status).toBe("unavailable");
  });
});

describe("each member of the batch carries its own outcome", () => {
  it("keeps the registration when only the SPLITS call fails", async () => {
    stubMulticall(batch([NOT_MINE, NOT_MINE, holds(failed)], ok(18), ok("ipfs://x")));
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);

    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") throw new Error("narrowing");
    expect(snapshot.locker.info.feeSplitAvailable).toBe(false);
    expect(snapshot.locker.info.feeSplitBps).toBeNull();
  });

  it("reports a failed decimals() as unavailable, never as an absent value", async () => {
    stubMulticall(batch([NOT_MINE, NOT_MINE, holds(SPLITS)], failed, ok("ipfs://x")));
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);
    expect(snapshot.decimals.status).toBe("unavailable");
  });

  it("separates a failed metadataUri() from a contract that has none", async () => {
    stubMulticall(batch([NOT_MINE, NOT_MINE, holds(SPLITS)], ok(18), failed));
    expect((await readPoolsOnChainSnapshot(TOKEN)).metadataUri.status).toBe("unavailable");

    stubMulticall(batch([NOT_MINE, NOT_MINE, holds(SPLITS)], ok(18), ok("")));
    const empty = await readPoolsOnChainSnapshot(TOKEN);
    // The contract ANSWERED with no URI - a fact, reported as `ok` + null.
    expect(empty.metadataUri).toEqual({ status: "ok", value: null });
  });

  it("still reports the token reads when the locker itself is unavailable", async () => {
    stubMulticall(batch([SILENT, SILENT, SILENT], ok(6), ok("ipfs://y")));
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);

    expect(snapshot.locker.status).toBe("unavailable");
    expect(snapshot.decimals).toEqual({ status: "ok", value: 6 });
    expect(snapshot.metadataUri).toEqual({ status: "ok", value: "ipfs://y" });
  });
});
