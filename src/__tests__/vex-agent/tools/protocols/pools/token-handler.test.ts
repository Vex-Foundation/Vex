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
import { POOLS_SUITES } from "@tools/pools-fun/constants.js";
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
    // V1: the legacy split, so the "community bucket 0" wording of the newer
    // pools is exercised separately below rather than everywhere.
    suite: POOLS_SUITES.find((suite) => suite.version === 1)!,
    launcher: "0x5793b76e33669334701c60297500fd05300e13af",
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
  locker: {
    status: "unavailable",
    detail:
      "these pools.fun suites did not answer at this block: V3 (locker silent). Whether this token is "
      + "registered with any suite was NOT determined - this is a failed read, not a token without a "
      + "registration.",
  },
};

/** A V3 token: the case that came back "unregistered / older sushi launcher" before the repair. */
const REGISTERED_V3: PoolsOnChainSnapshot = {
  ...REGISTERED,
  locker: {
    status: "registered",
    suite: POOLS_SUITES.find((suite) => suite.version === 3)!,
    launcher: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
    info: {
      ...(REGISTERED.locker as { info: PoolsOnChainSnapshot["locker"] extends { info: infer I } ? I : never }).info,
      // The measured V2/V3 split: creator 90 percent, community bucket ZERO.
      feeSplitBps: {
        creator: 9000, platform: 500, buyback: 500, community: 0,
        stockCreator: 9000, stockProtocol: 1000,
      },
    },
  },
};

/** Two suites claiming one token: a state no set of pool fields describes. */
const AMBIGUOUS: PoolsOnChainSnapshot = {
  ...REGISTERED,
  locker: {
    status: "ambiguous",
    detail: "2 pools.fun suites (V1, V3) both hold this token's LP and name a launcher for it.",
  },
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
    // The wording changed with the suite table. It used to say the LOCKER
    // answered and had no entry, and then blame the sushi launcher for it -
    // which is how a V3 token was described as a sushi token. It now says every
    // known suite was asked, and names none of them as the launcher.
    expect(String(data.onchain.lockerNote)).toContain("not registered with any pools.fun suite Vex knows");
    expect(String(data.onchain.lockerNote)).not.toContain("sushi");
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
        suite: POOLS_SUITES.find((suite) => suite.version === 1)!,
        launcher: "0x5793b76e33669334701c60297500fd05300e13af",
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

/**
 * The V2/V3 split, and the sentence that keeps a legitimate zero from reading as
 * a failed read.
 *
 * The split moved with the suites: V1 pools split 2000/2500/3000/2500 with a
 * real community bucket, and pools created on V2/V3 split 9000/500/500/0. A
 * reader who knows the old numbers sees `community: 0` and assumes the field did
 * not load, so the zero is stated in words - and the older wording is kept for
 * the older pools rather than rewritten for all of them.
 */
describe("pools.token reports the suite and the live split", () => {
  it("names the suite that holds a V3 token, with its addresses", async () => {
    stubDiscoverCapture();
    stubSnapshot(REGISTERED_V3);

    const data = JSON.parse((await token({ tokenAddress: POOLS_TOKEN })).output) as {
      onchain: Record<string, Record<string, unknown>>;
    };
    expect(data.onchain.lockerStatus).toBe("registered");
    expect(data.onchain.suite!.version).toBe(3);
    expect(data.onchain.suite!.locker).toBe(POOLS_SUITES.find((s) => s.version === 3)!.locker);
    expect(data.onchain.suite!.holderRewardsDeployer).toBeDefined();
  });

  it("says 'community bucket 0 on this pool' when the live split has none", async () => {
    stubDiscoverCapture();
    stubSnapshot(REGISTERED_V3);

    const data = JSON.parse((await token({ tokenAddress: POOLS_TOKEN })).output) as {
      onchain: Record<string, unknown>;
    };
    expect((data.onchain.feeSplitBps as Record<string, number>).community).toBe(0);
    expect(String(data.onchain.feeSplitNote)).toContain("community bucket 0 on this pool");
    expect(String(data.onchain.feeSplitNote)).toContain("not an unread field");
  });

  it("keeps the legacy wording for a V1 pool that really has a community bucket", async () => {
    stubDiscoverCapture();
    stubSnapshot(REGISTERED);

    const data = JSON.parse((await token({ tokenAddress: POOLS_TOKEN })).output) as {
      onchain: Record<string, unknown>;
    };
    expect((data.onchain.feeSplitBps as Record<string, number>).community).toBe(2500);
    expect(String(data.onchain.feeSplitNote)).toContain("non-zero community bucket");
  });

  it("emits NO pool fields when two suites claim the token", async () => {
    // A contradiction has no set of pool fields that describes it, and printing
    // one suite's answer would hide the disagreement rather than report it.
    stubDiscoverCapture();
    stubSnapshot(AMBIGUOUS);

    const data = JSON.parse((await token({ tokenAddress: POOLS_TOKEN })).output) as {
      onchain: Record<string, unknown>;
    };
    expect(data.onchain.lockerStatus).toBe("ambiguous");
    expect(data.onchain).not.toHaveProperty("pool");
    expect(data.onchain).not.toHaveProperty("feeSplitBps");
    expect(String(data.onchain.lockerNote)).toContain("V1, V3");
  });
});
