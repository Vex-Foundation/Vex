/**
 * `readPoolsOnChainSnapshot` distinguishes THREE outcomes, per multicall member.
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

/** Stub the batch so each of the four members can be dialled independently. */
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
    stubMulticall([REGISTERED_POOL_INFO, SPLITS, ok(18), ok("ipfs://x")]);
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);

    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") throw new Error("narrowing");
    expect(snapshot.locker.info.pool).toBe(POOL);
    expect(snapshot.locker.info.feeSplitBps?.creator).toBe(2000);
    expect(snapshot.locker.info.feeSplitAvailable).toBe(true);
    expect(snapshot.blockNumber).toBe("39620464");
  });

  it("unregistered: the locker ANSWERED, with its all-zero row", async () => {
    stubMulticall([UNREGISTERED_POOL_INFO, SPLITS, ok(18), ok("")]);
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);
    // A fact about the token - the expected answer for a sushi launcher token.
    expect(snapshot.locker.status).toBe("unregistered");
  });

  it("unavailable: the call FAILED, which proves nothing about the token", async () => {
    stubMulticall([failed, SPLITS, ok(18), ok("ipfs://x")]);
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);
    // The whole point: this must NOT come back as "unregistered".
    expect(snapshot.locker.status).toBe("unavailable");
  });
});

describe("each member of the batch carries its own outcome", () => {
  it("keeps the registration when only the SPLITS call fails", async () => {
    stubMulticall([REGISTERED_POOL_INFO, failed, ok(18), ok("ipfs://x")]);
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);

    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") throw new Error("narrowing");
    expect(snapshot.locker.info.feeSplitAvailable).toBe(false);
    expect(snapshot.locker.info.feeSplitBps).toBeNull();
  });

  it("reports a failed decimals() as unavailable, never as an absent value", async () => {
    stubMulticall([REGISTERED_POOL_INFO, SPLITS, failed, ok("ipfs://x")]);
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);
    expect(snapshot.decimals.status).toBe("unavailable");
  });

  it("separates a failed metadataUri() from a contract that has none", async () => {
    stubMulticall([REGISTERED_POOL_INFO, SPLITS, ok(18), failed]);
    expect((await readPoolsOnChainSnapshot(TOKEN)).metadataUri.status).toBe("unavailable");

    stubMulticall([REGISTERED_POOL_INFO, SPLITS, ok(18), ok("")]);
    const empty = await readPoolsOnChainSnapshot(TOKEN);
    // The contract ANSWERED with no URI - a fact, reported as `ok` + null.
    expect(empty.metadataUri).toEqual({ status: "ok", value: null });
  });

  it("still reports the token reads when the locker itself is unavailable", async () => {
    stubMulticall([failed, failed, ok(6), ok("ipfs://y")]);
    const snapshot = await readPoolsOnChainSnapshot(TOKEN);

    expect(snapshot.locker.status).toBe("unavailable");
    expect(snapshot.decimals).toEqual({ status: "ok", value: 6 });
    expect(snapshot.metadataUri).toEqual({ status: "ok", value: "ipfs://y" });
  });
});
