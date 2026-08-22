/**
 * `pools.token` - the join of the launchpad row with the chain, and the decline
 * this tool exists to make.
 *
 * The decline: a token launched by the OLDER sushi launcher is not in the
 * pools.fun PartyLocker's registry, so the locker answers with the zero address
 * for every field. Emitting those zeroes would tell the agent that the token has
 * no creator and trades in pool 0x000...0 - a claim the evidence does not
 * support, and the same class of defect as a settlement decoder guessing rather
 * than declining.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { validateDiscoverPage } from "@tools/pools-fun/validation.js";
import * as onChain from "@tools/pools-fun/evm/token-registration.js";
import type { PoolsOnChainSnapshot } from "@tools/pools-fun/evm/token-registration.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { makeProtocolContext } from "../../_test-context.js";
import { captureResponse, CAPTURES } from "../../../../pools-fun/_captures.js";

const CTX: ProtocolExecutionContext = makeProtocolContext();
const POOLS_TOKEN = "0x0ab8d01664d4bb625705f9f3c595a8a19b3dcfb0";
const ZERO = "0x0000000000000000000000000000000000000000";

function stubDiscoverCapture(): void {
  vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue(
    validateDiscoverPage(captureResponse(CAPTURES.discoverPoolsFun)),
  );
}

function stubSnapshot(snapshot: PoolsOnChainSnapshot): void {
  vi.spyOn(onChain, "readPoolsOnChainSnapshot").mockResolvedValue(snapshot);
}

const REGISTERED: PoolsOnChainSnapshot = {
  blockNumber: "39620464",
  decimals: { status: "ok", value: 18 },
  metadataUri: { status: "ok", value: "ipfs://example" },
  locker: {
    status: "registered",
    info: {
      pairedAssetAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      pool: "0x50136d4174129585ec766eacf2f00cd1856690ca",
      creator: "0x5793b76e33669334701c60297500fd05300e13af",
      feeRecipient: "0x5793b76e33669334701c60297500fd05300e13af",
      lockedPositionIds: ["12345"],
      feeSplitAvailable: true,
      feeSplitBps: {
        creator: 2000, platform: 2500, buyback: 3000, community: 2500,
        stockCreator: 2000, stockProtocol: 8000,
      },
    },
  },
};

/** The locker ANSWERED and has no entry - a token from the OTHER launcher. */
const UNREGISTERED: PoolsOnChainSnapshot = {
  blockNumber: "39620464",
  decimals: { status: "ok", value: 18 },
  metadataUri: { status: "ok", value: null },
  locker: { status: "unregistered" },
};

/** The locker call did NOT answer - nothing about the token was established. */
const LOCKER_UNAVAILABLE: PoolsOnChainSnapshot = {
  blockNumber: "39620464",
  decimals: { status: "ok", value: 18 },
  metadataUri: { status: "unavailable" },
  locker: { status: "unavailable" },
};

async function token(params: Record<string, unknown>) {
  return POOLS_HANDLERS["pools.token"]!(params, CTX);
}

afterEach(() => vi.restoreAllMocks());

describe("pools.token params", () => {
  it("requires a tokenAddress", async () => {
    const res = await token({});
    expect(res.success).toBe(false);
    expect(res.output).toContain("tokenAddress");
  });

  it("rejects a symbol handed in where an address belongs", async () => {
    const res = await token({ tokenAddress: "SUSHICAT" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("pools__tokens_search");
  });
});

describe("pools.token joins the two sources and labels them", () => {
  it("returns an api group and an onchain group, each naming its source", async () => {
    stubDiscoverCapture();
    stubSnapshot(REGISTERED);

    const res = await token({ tokenAddress: POOLS_TOKEN });
    expect(res.success).toBe(true);

    const data = JSON.parse(res.output) as { api: Record<string, unknown>; onchain: Record<string, unknown> };
    expect(data.api.source).toBe("api");
    expect(data.api.symbol).toBe("sushicat");
    expect(data.onchain).toMatchObject({
      source: "onchain",
      lockerStatus: "registered",
      blockNumber: "39620464",
      decimals: 18,
      poolFeeBps: 100,
    });
    expect((data.onchain.feeSplitBps as Record<string, number>).creator).toBe(2000);
  });
});

describe("pools.token declines instead of emitting zeroes", () => {
  it("says the locker has no registration rather than reporting zero addresses", async () => {
    stubDiscoverCapture();
    stubSnapshot(UNREGISTERED);

    const res = await token({ tokenAddress: POOLS_TOKEN });
    const data = JSON.parse(res.output) as { onchain: Record<string, unknown> };

    expect(data.onchain.lockerStatus).toBe("unregistered");
    expect(String(data.onchain.lockerNote)).toContain("answered and has no entry");
    expect(data.onchain).not.toHaveProperty("pool");
    expect(data.onchain).not.toHaveProperty("creator");
    expect(JSON.stringify(data.onchain)).not.toContain(ZERO);
    // The on-chain reads that DID succeed are still reported.
    expect(data.onchain.decimals).toBe(18);
  });

  it("never reports a FAILED locker call as 'not registered'", async () => {
    stubDiscoverCapture();
    stubSnapshot(LOCKER_UNAVAILABLE);

    const res = await token({ tokenAddress: POOLS_TOKEN });
    const data = JSON.parse(res.output) as { onchain: Record<string, unknown> };

    expect(data.onchain.lockerStatus).toBe("unavailable");
    // The distinction the tri-state exists for: an RPC failure is not evidence
    // that the token has no pools.fun registration.
    expect(String(data.onchain.lockerNote)).toContain("NOT determined");
    expect(data.onchain).not.toHaveProperty("pool");
    expect(JSON.stringify(data.onchain)).not.toContain(ZERO);
  });

  it("separates a failed metadataUri read from a token that has none", async () => {
    stubDiscoverCapture();
    stubSnapshot(LOCKER_UNAVAILABLE);

    const res = await token({ tokenAddress: POOLS_TOKEN });
    const data = JSON.parse(res.output) as { onchain: Record<string, unknown> };
    expect(data.onchain).not.toHaveProperty("metadataUri");
    expect(String(data.onchain.metadataUriUnavailable)).toContain("did not answer");
  });

  it("keeps a registration whose fee-split call alone failed, and says so", async () => {
    stubDiscoverCapture();
    stubSnapshot({
      ...REGISTERED,
      locker: {
        status: "registered",
        info: { ...REGISTERED.locker.status === "registered" ? REGISTERED.locker.info : ({} as never),
          feeSplitAvailable: false, feeSplitBps: null },
      },
    });

    const res = await token({ tokenAddress: POOLS_TOKEN });
    const data = JSON.parse(res.output) as { onchain: Record<string, unknown> };
    expect(data.onchain.lockerStatus).toBe("registered");
    expect(data.onchain).not.toHaveProperty("feeSplitBps");
    expect(String(data.onchain.feeSplitUnavailable)).toContain("did not answer");
  });

  it("names an on-chain read failure instead of silently omitting the group", async () => {
    stubDiscoverCapture();
    vi.spyOn(onChain, "readPoolsOnChainSnapshot").mockRejectedValue(new Error("rpc unreachable"));

    const res = await token({ tokenAddress: POOLS_TOKEN });
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output) as { onchain: Record<string, unknown> };
    expect(String(data.onchain.unavailable)).toContain("proven either way");
  });

  it("says the launchpad has no row rather than inventing one", async () => {
    vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue(
      validateDiscoverPage(captureResponse(CAPTURES.discoverEmpty)),
    );
    stubSnapshot(REGISTERED);

    const res = await token({ tokenAddress: POOLS_TOKEN });
    const data = JSON.parse(res.output) as { api: Record<string, unknown> };
    expect(String(data.api.unavailable)).toContain("no row for this address");
  });
});
