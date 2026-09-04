/**
 * Suite detection: which pools.fun contract triple holds a token, and the four
 * answers it can give.
 *
 * WHAT THIS SUITE IS FOR. pools.fun runs V1, V2 and V3 side by side. While the
 * locker was one pinned V1 address, `getPoolInfo` answered all-zero for every
 * post-migration token and the product reported "not registered - expected for a
 * token launched by the older sushi launcher". That sentence was wrong about the
 * token AND wrong about the reason, and it reached a money path: `pools.claim_fees`
 * refused real claims with it (measured 2026-09-04 on DICK, a V3 token).
 *
 * So the cases below are written as the STATES OF THE WORLD the detector has to
 * tell apart, one row each, in the table-driven shape
 * `agents-colab/github-mcp-server/pkg/github/repositories_test.go` uses for its
 * tool tests: each row names the scenario, the mocked boundary and the expected
 * outcome, and the boundary is mocked at the transport-facing seam rather than
 * by stubbing the module's own function.
 *
 * THE MOCK IS THE MULTICALL, AND NOTHING BELOW IT. `client.multicall` is where
 * the chain stops and this module's judgement starts, so it is the only thing
 * faked; the suite table, the call ordering, the zero-address reading and the
 * whole verdict are the real code. A test that stubbed `readPoolsOnChainSnapshot`
 * would prove only that the test can return a value.
 */

import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import { getAddress, type Address } from "viem";

import { POOLS_SUITES } from "@tools/pools-fun/constants.js";

const ZERO = "0x0000000000000000000000000000000000000000";
/** DICK, launched on V3 on 2026-09-04 - the token the shipped code got wrong. */
const DICK = getAddress("0x1837b25a3E5d4d3C2b0B5F2d9e4f6a1c2D3e4F50");
const POOL = getAddress("0x3BeA15b06bF7b6f5c23F1BCf6F4E65900b6DBAE2");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const LAUNCHER = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");

const V1 = POOLS_SUITES.find((s) => s.version === 1)!;
const V2 = POOLS_SUITES.find((s) => s.version === 2)!;
const V3 = POOLS_SUITES.find((s) => s.version === 3)!;

type Call = { status: "success"; result: unknown } | { status: "failure" };
const ok = (result: unknown): Call => ({ status: "success", result });
const dead: Call = { status: "failure" };

/** `getPoolInfo`'s five outputs for a token this locker holds. */
const HOLDS = ok([WETH, POOL, LAUNCHER, LAUNCHER, [123n]] as const);
/** `getPoolInfo`'s all-zero row: the locker answering "I never registered it". */
const HOLDS_NOT = ok([ZERO, ZERO, ZERO, ZERO, []] as const);
const SPLITS = ok([9000, 500, 500, 0, 9000, 1000] as const);
const LEGACY_SPLITS = ok([2000, 2500, 3000, 2500, 2000, 8000] as const);

/**
 * The batch, in the order the module builds it: three calls per suite
 * (getPoolInfo, getPoolSplits, launcherOf) then decimals and metadataUri.
 *
 * Assembled positionally on purpose - if the module ever reorders its calls, a
 * row here starts describing a different question and the test goes red, which
 * is exactly the coupling a batch built by index should have.
 */
function batch(
  suites: readonly { poolInfo: Call; splits: Call; launcher: Call }[],
  token: { decimals?: Call; metadataUri?: Call } = {},
): Call[] {
  return [
    ...suites.flatMap((s) => [s.poolInfo, s.splits, s.launcher]),
    token.decimals ?? ok(18),
    token.metadataUri ?? ok("ipfs://bafkreiexample"),
  ];
}

const registeredOn = { poolInfo: HOLDS, splits: SPLITS, launcher: ok(LAUNCHER) };
const silentAbout = { poolInfo: HOLDS_NOT, splits: HOLDS_NOT, launcher: ok(ZERO) };

let multicall: Mock<(...args: unknown[]) => unknown>;

vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: () => ({
    getBlockNumber: async () => 39_620_464n,
    multicall: (...args: unknown[]) => multicall(...args),
  }),
}));

async function detect(): Promise<
  Awaited<ReturnType<typeof import("@tools/pools-fun/evm/token-registration.js").readPoolsOnChainSnapshot>>
> {
  const { readPoolsOnChainSnapshot } = await import("@tools/pools-fun/evm/token-registration.js");
  return readPoolsOnChainSnapshot(DICK as Address);
}

beforeEach(() => {
  multicall = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("exactly one suite, and it is named", () => {
  it("a V3 token resolves to V3, not to 'unregistered'", async () => {
    // The regression this whole lane exists for. Before the repair, the V1
    // locker's all-zero row was the ONLY thing read, and this token came back
    // `unregistered` with a note blaming the sushi launcher.
    multicall.mockResolvedValue(batch([silentAbout, silentAbout, registeredOn]));

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") return;
    expect(snapshot.locker.suite.version).toBe(3);
    expect(snapshot.locker.suite.locker).toBe(V3.locker);
    expect(snapshot.locker.suite.gateway).toBe(V3.gateway);
    expect(snapshot.locker.info.pool).toBe(POOL);
  });

  it("a V1 token still resolves to V1 - the older suites are not retired", async () => {
    // VEXFLAM and our other six launches live in the V1 locker and still claim.
    // A repair that fixed V3 by moving the pin to V3 would have broken them.
    multicall.mockResolvedValue(
      batch([{ poolInfo: HOLDS, splits: LEGACY_SPLITS, launcher: ok(LAUNCHER) }, silentAbout, silentAbout]),
    );

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") return;
    expect(snapshot.locker.suite.version).toBe(1);
    expect(snapshot.locker.suite.locker).toBe(V1.locker);
    // The legacy split, with its real community bucket, survives unchanged.
    expect(snapshot.locker.info.feeSplitBps?.community).toBe(2500);
  });

  it("a V2 token resolves to V2, the suite that existed for one day", async () => {
    multicall.mockResolvedValue(batch([silentAbout, registeredOn, silentAbout]));

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") return;
    expect(snapshot.locker.suite.version).toBe(2);
    expect(snapshot.locker.suite.locker).toBe(V2.locker);
  });
});

describe("no suite claims it", () => {
  it("every suite answers and none holds it: unregistered, and the sushi launcher is NOT named", async () => {
    multicall.mockResolvedValue(batch([silentAbout, silentAbout, silentAbout]));

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("unregistered");
  });

  it("the wording names the suites that were actually checked", async () => {
    const { POOLS_UNREGISTERED_SENTENCE } = await import("@tools/pools-fun/evm/token-registration.js");
    // Not a fixed string: it is derived from the table, so adding a V4 without
    // updating the sentence is impossible.
    expect(POOLS_UNREGISTERED_SENTENCE).toContain("V1, V2, V3");
    expect(POOLS_UNREGISTERED_SENTENCE).not.toContain("sushi");
  });
});

describe("the locker registers; the gateway only attributes", () => {
  it("a locker row with NO gateway launcher is registered, with launcher null", async () => {
    // MEASURED 2026-09-04, and the reason this rule is what it is. sushicat is
    // an ordinary V1 token that has traded for three weeks: the V1 locker holds
    // its LP (pool 0x50136D41...) and the V1 gateway names no launcher, because
    // it was launched directly against the factory - which most pools.fun
    // tokens are. An earlier revision demanded both and called this `ambiguous`,
    // turning the majority of the launchpad into "we cannot tell".
    multicall.mockResolvedValue(
      batch([{ poolInfo: HOLDS, splits: LEGACY_SPLITS, launcher: ok(ZERO) }, silentAbout, silentAbout]),
    );

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") return;
    expect(snapshot.locker.suite.version).toBe(1);
    // `null` is "not launched through the gateway", never "we could not read it"
    // - a read that did not answer produces `unavailable` instead.
    expect(snapshot.locker.launcher).toBeNull();
    expect(snapshot.locker.info.pool).toBe(POOL);
  });

  it("a locker row WITH a matching gateway launcher reports the launcher", async () => {
    multicall.mockResolvedValue(batch([silentAbout, silentAbout, registeredOn]));

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("registered");
    if (snapshot.locker.status !== "registered") return;
    expect(snapshot.locker.launcher).toBe(LAUNCHER);
  });
});

describe("a contradiction is never resolved by picking one", () => {
  it("two lockers both holding the token is ambiguous, not first-match-wins", async () => {
    // Order matters to the assertion: V1 comes FIRST in the table, so a
    // first-match implementation would confidently answer V1 here.
    multicall.mockResolvedValue(batch([registeredOn, silentAbout, registeredOn]));

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("ambiguous");
    if (snapshot.locker.status !== "ambiguous") return;
    expect(snapshot.locker.detail).toContain("V1");
    expect(snapshot.locker.detail).toContain("V3");
  });

  it("a gateway naming a launcher no locker registered IS a contradiction", async () => {
    // The direction that still means something: the gateway recorded a launch
    // and no locker holds the LP. Either the launch never registered or two
    // suites disagree, and neither is a token whose pool fields can be reported.
    multicall.mockResolvedValue(
      batch([silentAbout, silentAbout, { poolInfo: HOLDS_NOT, splits: HOLDS_NOT, launcher: ok(LAUNCHER) }]),
    );

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("ambiguous");
    if (snapshot.locker.status !== "ambiguous") return;
    expect(snapshot.locker.detail).toContain("locker holds no LP");
  });

  it("one suite's locker holding while ANOTHER suite's gateway names a launcher is ambiguous", async () => {
    multicall.mockResolvedValue(
      batch([
        { poolInfo: HOLDS, splits: SPLITS, launcher: ok(ZERO) },
        silentAbout,
        { poolInfo: HOLDS_NOT, splits: HOLDS_NOT, launcher: ok(LAUNCHER) },
      ]),
    );

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("ambiguous");
    if (snapshot.locker.status !== "ambiguous") return;
    expect(snapshot.locker.detail).toContain("V3");
    expect(snapshot.locker.detail).toContain("V1");
  });
});

describe("silence is never read as absence", () => {
  it("one suite's locker not answering makes the whole verdict unavailable", async () => {
    // THE POINT OF THE WHOLE TRI-STATE. A V3 locker that did not answer leaves
    // "is this token registered" unproven - including the negative. Reporting
    // `unregistered` here would refuse a real claim on the strength of an RPC
    // hiccup.
    multicall.mockResolvedValue(
      batch([silentAbout, silentAbout, { poolInfo: dead, splits: dead, launcher: ok(ZERO) }]),
    );

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("unavailable");
    if (snapshot.locker.status !== "unavailable") return;
    expect(snapshot.locker.detail).toContain("V3");
    expect(snapshot.locker.detail).toContain("locker");
    expect(snapshot.locker.detail).toContain("NOT determined");
  });

  it("one suite's gateway not answering is also unavailable, and says which half was silent", async () => {
    multicall.mockResolvedValue(
      batch([silentAbout, { poolInfo: HOLDS_NOT, splits: HOLDS_NOT, launcher: dead }, silentAbout]),
    );

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("unavailable");
    if (snapshot.locker.status !== "unavailable") return;
    expect(snapshot.locker.detail).toContain("V2");
    expect(snapshot.locker.detail).toContain("gateway");
  });

  it("RPC silence outranks a match: an answer from one suite does not license a verdict", async () => {
    // V3 matches cleanly, but V1 said nothing. The token could equally be a V1
    // token, and the answer is that we do not know - not the match we happen to
    // hold. This is the row that separates "cross-check" from "search".
    multicall.mockResolvedValue(
      batch([{ poolInfo: dead, splits: dead, launcher: dead }, silentAbout, registeredOn]),
    );

    const snapshot = await detect();
    expect(snapshot.locker.status).toBe("unavailable");
  });
});

describe("the token's own reads keep their separate outcomes", () => {
  it("decimals that did not answer are unavailable, never 18", async () => {
    multicall.mockResolvedValue(
      batch([silentAbout, silentAbout, registeredOn], { decimals: dead }),
    );

    const snapshot = await detect();
    expect(snapshot.decimals.status).toBe("unavailable");
    // ...and the registration is unharmed: one failed token read must not cost
    // the suite verdict.
    expect(snapshot.locker.status).toBe("registered");
  });

  it("an empty metadataUri is the contract ANSWERING, so it is ok-with-null", async () => {
    multicall.mockResolvedValue(
      batch([silentAbout, silentAbout, registeredOn], { metadataUri: ok("") }),
    );

    const snapshot = await detect();
    expect(snapshot.metadataUri).toEqual({ status: "ok", value: null });
  });
});

describe("the batch itself", () => {
  it("asks every suite at ONE pinned block, three calls each", async () => {
    multicall.mockResolvedValue(batch([silentAbout, silentAbout, registeredOn]));
    await detect();

    const args = multicall.mock.calls[0]![0] as {
      blockNumber: bigint;
      allowFailure: boolean;
      contracts: { address: string; functionName: string }[];
    };
    expect(args.blockNumber).toBe(39_620_464n);
    expect(args.allowFailure).toBe(true);
    // 3 suites x 3 calls + decimals + metadataUri. One batch, so no suite is
    // asked about a different block than another.
    expect(args.contracts).toHaveLength(POOLS_SUITES.length * 3 + 2);
    for (const [index, suite] of POOLS_SUITES.entries()) {
      expect(args.contracts[index * 3]).toMatchObject({
        address: suite.locker,
        functionName: "getPoolInfo",
      });
      expect(args.contracts[index * 3 + 2]).toMatchObject({
        address: suite.gateway,
        functionName: "launcherOf",
      });
    }
  });
});
