/**
 * pools.fun settlement decoding: the refusal matrix.
 *
 * The decoder's job is to say "this receipt is OUR launch" or to decline. The
 * risk it manages is the second kind of error: a decoder that confirms a row
 * from a receipt it has not really proven records somebody else's token as the
 * user's, and the user then acts on it. So the suite is built the same way as
 * the verifier's - a receipt that decodes cleanly, then one thing wrong at a
 * time, each requiring a NAMED refusal.
 *
 * Logs are REAL encoded events (viem `encodeEventTopics` + `encodeAbiParameters`
 * over the verified ABIs), not hand-written topic strings: a decoder tested
 * against invented logs proves nothing about the logs it will actually meet.
 */

import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex,
} from "viem";

import {
  PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
  PARTY_LOCKER_CLAIMED_EVENT_ABI,
  POOLS_GATEWAY_LAUNCH_EVENT_ABI,
} from "@tools/pools-fun/abi.js";
import { POOLS_SUITES } from "@tools/pools-fun/constants.js";
import { POOLS_DISTRIBUTOR_DEPLOYED_EVENT_ABI } from "@tools/pools-fun/holder-rewards/read.js";
import {
  decodePoolsClaimSettlement,
  decodePoolsLaunchSettlement,
  type PoolsLaunchExpectation,
  type PoolsSettlementLog,
} from "@vex-agent/sync/pools-settlement-decoder.js";

/**
 * The suite whose emitters the default cases use.
 *
 * V1 on purpose: our seven real launches are V1 rows, so these cases keep
 * describing receipts that actually exist on-chain. The per-suite cases at the
 * bottom of this file cover V2 and V3, whose event topics are byte-identical -
 * only the emitter addresses differ, which is exactly the thing that broke.
 */
const V1 = POOLS_SUITES.find((s) => s.version === 1)!;
const V2 = POOLS_SUITES.find((s) => s.version === 2)!;
const V3 = POOLS_SUITES.find((s) => s.version === 3)!;
const GATEWAY = getAddress(V1.gateway);
const FACTORY = getAddress(V1.factory);
const LOCKER = getAddress(V1.locker);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const SALT = `0x${"7a".repeat(32)}` as Hex;

/**
 * `encodeEventTopics` types its result as `(Hex | Hex[] | null)[]` because an
 * indexed arg MAY be omitted to build a filter. Every call here supplies all of
 * them, so the concrete topics are strings - narrowed explicitly rather than
 * cast, so a future builder that forgets an arg loses the topic instead of
 * smuggling a null into a decoder input.
 */
function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

interface GatewayFields {
  token: Address; pool: Address; launcher: Address; pairedAsset: Address;
  feeRecipient: Address; userSalt: Hex; feePaidWei: bigint; devBuyOut: bigint;
}

function gatewayLog(over: Partial<GatewayFields> = {}, emitter: string = GATEWAY): PoolsSettlementLog {
  const f: GatewayFields = {
    token: TOKEN, pool: POOL, launcher: WALLET, pairedAsset: WETH,
    feeRecipient: WALLET, userSalt: SALT, feePaidWei: 1_051_674_002_092_832n,
    devBuyOut: 112_657_539_798_287_513_447_808n, ...over,
  };
  const topics = encodeEventTopics({
    abi: POOLS_GATEWAY_LAUNCH_EVENT_ABI,
    eventName: "GatewayLaunch",
    args: { token: f.token, pool: f.pool, launcher: f.launcher },
  });
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [f.pairedAsset, f.feeRecipient, f.userSalt, f.feePaidWei, f.devBuyOut],
  );
  return { address: emitter, topics: concreteTopics(topics), data };
}

interface FactoryFields {
  token: Address; pool: Address; creator: Address; pairedAsset: Address;
  deployer: Address; feeRecipient: Address; startTick: number;
  metadataUri: string; devBuyAmountOut: bigint;
}

function factoryLog(over: Partial<FactoryFields> = {}, emitter: string = FACTORY): PoolsSettlementLog {
  const f: FactoryFields = {
    token: TOKEN, pool: POOL, creator: GATEWAY, pairedAsset: WETH,
    deployer: GATEWAY, feeRecipient: WALLET, startTick: -197_600,
    metadataUri: "ipfs://bafkreifaguifkgqdrrs2cwlbjejqblrguynowkm3zb77yvq3gsydqacywm",
    devBuyAmountOut: 112_657_539_798_287_513_447_808n, ...over,
  };
  const topics = encodeEventTopics({
    abi: PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
    eventName: "TokenLaunched",
    args: { token: f.token, pool: f.pool, creator: f.creator },
  });
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "int24" },
     { type: "string" }, { type: "uint256" }],
    [f.pairedAsset, f.deployer, f.feeRecipient, f.startTick, f.metadataUri, f.devBuyAmountOut],
  );
  return { address: emitter, topics: concreteTopics(topics), data };
}

function claimedLog(
  over: Partial<{ token: Address; account: Address; tokenAmount: bigint; pairedAmount: bigint }> = {},
  emitter: string = LOCKER,
): PoolsSettlementLog {
  const f = { token: TOKEN, account: WALLET, tokenAmount: 12_345n, pairedAmount: 599_999_999_999n, ...over };
  const topics = encodeEventTopics({
    abi: PARTY_LOCKER_CLAIMED_EVENT_ABI,
    eventName: "Claimed",
    args: { token: f.token, account: f.account },
  });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [f.tokenAmount, f.pairedAmount]);
  return { address: emitter, topics: concreteTopics(topics), data };
}

const EXPECTED: PoolsLaunchExpectation = {
  launcher: WALLET, feeRecipient: WALLET, pairedAsset: WETH,
  userSalt: SALT, predictedTokenAddress: TOKEN,
};

/** Assert a refusal whose reason actually explains itself. */
function expectRefusal(
  result: { ok: boolean; reason?: string },
  fragment: string,
): void {
  expect(result.ok, "the decoder must decline").toBe(false);
  expect(result.reason ?? "").toContain(fragment);
  expect((result.reason ?? "").length).toBeGreaterThan(25);
}

describe("launch settlement - the proven case", () => {
  it("decodes a well-formed dual-event receipt", () => {
    const result = decodePoolsLaunchSettlement([gatewayLog(), factoryLog()], EXPECTED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenAddress).toBe(TOKEN);
    expect(result.value.poolAddress).toBe(POOL);
    expect(result.value.launcher).toBe(WALLET);
    expect(result.value.startTick).toBe(-197_600);
    expect(result.value.devBuyOut).toBeGreaterThan(0n);
  });

  it("ignores unrelated logs sitting in the same receipt", () => {
    const noise: PoolsSettlementLog = { address: STRANGER, topics: [`0x${"ab".repeat(32)}`], data: "0x" };
    expect(decodePoolsLaunchSettlement([noise, gatewayLog(), factoryLog(), noise], EXPECTED).ok).toBe(true);
  });
});

/**
 * The suite the authorized plan names.
 *
 * Every production launch records its gateway (migration 082), so the plan
 * SELECTS the suite and these cases go through that path. The discovery path -
 * an older row with no gateway - has its own block at the bottom of this file,
 * because its refusals are deliberately different: it has to name the suites it
 * looked at.
 */
const NAMED_V1 = { gateway: V1.gateway, factory: V1.factory };

describe("launch settlement - BOTH events are required", () => {
  it("declines with only the factory event (it credits the gateway, so it cannot name us)", () => {
    expectRefusal(decodePoolsLaunchSettlement([factoryLog()], EXPECTED, NAMED_V1), "no GatewayLaunch");
  });

  it("declines with only the gateway event", () => {
    expectRefusal(decodePoolsLaunchSettlement([gatewayLog()], EXPECTED, NAMED_V1), "no TokenLaunched");
  });

  it("declines on an empty receipt", () => {
    expectRefusal(decodePoolsLaunchSettlement([], EXPECTED, NAMED_V1), "no GatewayLaunch");
  });
});

describe("launch settlement - emitters are PINNED", () => {
  it("declines a GatewayLaunch emitted by an impostor contract", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog({}, STRANGER), factoryLog()], EXPECTED, NAMED_V1),
      "no GatewayLaunch",
    );
  });

  it("declines a TokenLaunched emitted by an impostor contract", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), factoryLog({}, STRANGER)], EXPECTED, NAMED_V1),
      "no TokenLaunched",
    );
  });
});

describe("launch settlement - EXACTLY ONE of each", () => {
  it("declines two gateway launches rather than picking one", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), gatewayLog(), factoryLog()], EXPECTED),
      "cannot be attributed",
    );
  });

  it("declines two factory launches rather than picking one", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), factoryLog(), factoryLog()], EXPECTED),
      "cannot be attributed",
    );
  });
});

describe("launch settlement - identity", () => {
  it("declines when the launcher is somebody else's wallet", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog({ launcher: STRANGER }), factoryLog()], EXPECTED),
      "not this session's wallet",
    );
  });

  it("declines when the factory did NOT credit the gateway (so this was not the gateway path)", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), factoryLog({ creator: STRANGER })], EXPECTED),
      "must credit the gateway",
    );
  });

  it("declines when deployer is not the gateway even though creator is", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), factoryLog({ deployer: STRANGER })], EXPECTED),
      "must credit the gateway",
    );
  });
});

describe("launch settlement - the two events must agree field by field", () => {
  it.each([
    ["token", { token: STRANGER }, {}, "do not describe the same launch"],
    ["pool", { pool: STRANGER }, {}, "do not describe the same launch"],
  ])("declines when the factory's %s differs from the gateway's", (_l, factoryOver, _g, fragment) => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), factoryLog(factoryOver as Partial<FactoryFields>)], EXPECTED),
      fragment,
    );
  });

  it("declines when the two events disagree about the paired asset", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), factoryLog({ pairedAsset: STRANGER })], EXPECTED),
      "pairedAsset",
    );
  });

  it("declines when the two events disagree about the fee recipient", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog(), factoryLog({ feeRecipient: STRANGER })], EXPECTED),
      "feeRecipient",
    );
  });
});

describe("launch settlement - the receipt must match the AUTHORIZED plan", () => {
  it("declines a token that is not the one the user approved", () => {
    const other = getAddress("0x0ab8d01664d4bb625705f9f3c595a8a19b3dcfb0");
    expectRefusal(
      decodePoolsLaunchSettlement(
        [gatewayLog({ token: other }), factoryLog({ token: other })],
        EXPECTED,
      ),
      "the authorized plan approved",
    );
  });

  it("declines when the fee stream went somewhere the plan did not authorize", () => {
    expectRefusal(
      decodePoolsLaunchSettlement(
        [gatewayLog({ feeRecipient: STRANGER }), factoryLog({ feeRecipient: STRANGER })],
        EXPECTED,
      ),
      "the authorized plan set",
    );
  });

  it("declines a different salt - a different salt is a different token address", () => {
    expectRefusal(
      decodePoolsLaunchSettlement([gatewayLog({ userSalt: `0x${"11".repeat(32)}` }), factoryLog()], EXPECTED),
      "different salt",
    );
  });

  it("declines a pair the plan did not authorize", () => {
    const usdg = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expectRefusal(
      decodePoolsLaunchSettlement(
        [gatewayLog({ pairedAsset: usdg }), factoryLog({ pairedAsset: usdg })],
        EXPECTED,
      ),
      "not the authorized",
    );
  });
});

describe("claim settlement", () => {
  const expected = { account: WALLET, tokenAddress: TOKEN };

  it("decodes both legs of a proven claim", () => {
    const result = decodePoolsClaimSettlement([claimedLog()], expected);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenAmountRaw).toBe(12_345n);
    expect(result.value.pairedAmountRaw).toBe(599_999_999_999n);
    expect(result.value.account).toBe(WALLET);
  });

  it("treats a 0/0 payout as a legitimate outcome, not a decode failure", () => {
    // The pool had nothing to pay. That is a fact about the pool, and the row
    // should record it rather than sit pending forever.
    const result = decodePoolsClaimSettlement([claimedLog({ tokenAmount: 0n, pairedAmount: 0n })], expected);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pairedAmountRaw).toBe(0n);
  });

  it("declines a Claimed from an impostor locker", () => {
    expectRefusal(decodePoolsClaimSettlement([claimedLog({}, STRANGER)], expected), "no Claimed event");
  });

  it("declines when the claim paid a different account", () => {
    expectRefusal(decodePoolsClaimSettlement([claimedLog({ account: STRANGER })], expected), "none for token");
  });

  it("declines when the claim was for a different token", () => {
    expectRefusal(decodePoolsClaimSettlement([claimedLog({ token: STRANGER })], expected), "none for token");
  });

  it("picks OUR claim out of a receipt containing somebody else's", () => {
    const result = decodePoolsClaimSettlement(
      [claimedLog({ account: STRANGER }), claimedLog(), claimedLog({ token: STRANGER })],
      expected,
    );
    expect(result.ok).toBe(true);
  });

  it("declines two claims for the same token and account rather than picking one", () => {
    expectRefusal(
      decodePoolsClaimSettlement([claimedLog(), claimedLog()], expected),
      "cannot be attributed",
    );
  });
});

/**
 * ONE TOKEN, THREE SUITES: the same launch, emitted by V1, V2 and V3.
 *
 * WHY THIS BLOCK EXISTS. The three suites emit BYTE-IDENTICAL topics (verified
 * against the three Sourcify ABIs), so the only thing that distinguishes a V3
 * launch receipt from a V1 one is the EMITTER ADDRESS. While the decoder pinned
 * V1's addresses, every V2 and V3 launch decoded as "no GatewayLaunch event from
 * the pinned gateway" - a confirmed transaction that moved real money, reported
 * as unattributable, forever. These cases are what make that impossible to
 * reintroduce silently.
 */
describe("launch settlement - every suite, and never two at once", () => {
  const suites = [
    ["V1", V1],
    ["V2", V2],
    ["V3", V3],
  ] as const;

  it.each(suites)("%s: the plan's gateway selects the suite, and its factory comes with it", (_name, suite) => {
    const logs = [
      gatewayLog({}, suite.gateway),
      factoryLog({ creator: getAddress(suite.gateway), deployer: getAddress(suite.gateway) }, suite.factory),
    ];
    const result = decodePoolsLaunchSettlement(logs, EXPECTED, { gateway: suite.gateway });
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenAddress).toBe(TOKEN);
  });

  it.each(suites)("%s: discovers itself when the row carries no gateway", (_name, suite) => {
    // Rows written before migration 082 have no gateway column. Discovery finds
    // the one suite that emitted BOTH events - which is stricter than the old
    // V1 default it replaces, not looser.
    const logs = [
      gatewayLog({}, suite.gateway),
      factoryLog({ creator: getAddress(suite.gateway), deployer: getAddress(suite.gateway) }, suite.factory),
    ];
    const result = decodePoolsLaunchSettlement(logs, EXPECTED);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  });

  it("refuses to mix suites: a V3 gateway event beside a V1 factory event proves nothing", () => {
    // The dual-event rule means ONE launch produced both, and a launch is one
    // gateway calling its own factory. Accepting a cross-suite pair would keep
    // the ceremony and lose the guarantee.
    const logs = [
      gatewayLog({}, V3.gateway),
      factoryLog({ creator: getAddress(V1.gateway), deployer: getAddress(V1.gateway) }, V1.factory),
    ];
    expectRefusal(decodePoolsLaunchSettlement(logs, EXPECTED, { gateway: V3.gateway }), "no TokenLaunched");
    expectRefusal(decodePoolsLaunchSettlement(logs, EXPECTED), "no pools.fun suite emitted both");
  });

  it("refuses a receipt in which TWO suites each emitted a full launch pair", () => {
    const logs = [
      gatewayLog({}, V1.gateway),
      factoryLog({ creator: getAddress(V1.gateway), deployer: getAddress(V1.gateway) }, V1.factory),
      gatewayLog({}, V3.gateway),
      factoryLog({ creator: getAddress(V3.gateway), deployer: getAddress(V3.gateway) }, V3.factory),
    ];
    expectRefusal(decodePoolsLaunchSettlement(logs, EXPECTED), "cannot be attributed");
  });

  it("refuses a gateway the suite table does not carry, by name", () => {
    // A sweep must leave such a row PENDING rather than confirm it: a receipt
    // from an unknown contract cannot be shown to be a pools.fun launch at all.
    const result = decodePoolsLaunchSettlement(
      [gatewayLog({}, STRANGER), factoryLog({}, STRANGER)],
      EXPECTED,
      { gateway: STRANGER },
    );
    expectRefusal(result, "not one of the pools.fun suites Vex knows");
  });
});

describe("claim settlement - across suites", () => {
  const suites = [
    ["V1", V1],
    ["V2", V2],
    ["V3", V3],
  ] as const;

  it.each(suites)("%s: decodes a claim from the locker the claim was sent to", (_name, suite) => {
    const result = decodePoolsClaimSettlement(
      [claimedLog({}, suite.locker)],
      { account: WALLET, tokenAddress: TOKEN },
      { locker: suite.locker },
    );
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  });

  it.each(suites)("%s: decodes without a named locker, because any known one is ours", (_name, suite) => {
    // The `account` and `token` filters still make the attribution exact; the
    // locker set only bounds WHICH contracts may be believed at all.
    expect(
      decodePoolsClaimSettlement([claimedLog({}, suite.locker)], { account: WALLET, tokenAddress: TOKEN }).ok,
    ).toBe(true);
  });

  it("still refuses a Claimed event from a contract in no suite", () => {
    expectRefusal(
      decodePoolsClaimSettlement([claimedLog({}, STRANGER)], { account: WALLET, tokenAddress: TOKEN }),
      "no Claimed event",
    );
  });
});

/**
 * EMITTER HINTS SELECT AMONG THE TABLE'S SUITES; THEY NEVER ADD AN EMITTER.
 *
 * The plan's `{gateway, factory}` and the claim's `{locker}` are hints the
 * caller recorded, and a hint used verbatim would let a receipt full of forged
 * same-signature events from arbitrary contracts decode as a launch or a payout
 * (Codex final review of PR1). Every hint is resolved through `POOLS_SUITES`
 * and refused by name when the table does not carry it.
 */
describe("launch settlement - emitter hints are resolved through the suite table", () => {
  it("refuses an unknown gateway/factory PAIR even when both emitted matching events", () => {
    const logs = [
      gatewayLog({}, STRANGER),
      factoryLog({ creator: STRANGER, deployer: STRANGER }, STRANGER),
    ];
    expectRefusal(
      decodePoolsLaunchSettlement(logs, EXPECTED, { gateway: STRANGER, factory: STRANGER }),
      "not one of the pools.fun suites Vex knows",
    );
  });

  it("refuses a MISMATCHED known pair: a V3 gateway hinted with V1's factory", () => {
    const logs = [
      gatewayLog({}, V3.gateway),
      factoryLog({ creator: getAddress(V3.gateway), deployer: getAddress(V3.gateway) }, V3.factory),
    ];
    // The same receipt decodes with the honest hint, so the refusal below is
    // about the hint, not the logs.
    expect(decodePoolsLaunchSettlement(logs, EXPECTED, { gateway: V3.gateway, factory: V3.factory }).ok).toBe(true);
    expectRefusal(
      decodePoolsLaunchSettlement(logs, EXPECTED, { gateway: V3.gateway, factory: V1.factory }),
      "does not describe one suite",
    );
  });

  it("refuses a factory-only hint: a factory alone does not identify a suite", () => {
    const logs = [
      gatewayLog({}, V3.gateway),
      factoryLog({ creator: getAddress(V3.gateway), deployer: getAddress(V3.gateway) }, V3.factory),
    ];
    expectRefusal(decodePoolsLaunchSettlement(logs, EXPECTED, { factory: V3.factory }), "named without its gateway");
  });
});

describe("claim settlement - a named locker must be one of the table's", () => {
  it("refuses an explicit locker outside the table even when it emitted a matching Claimed", () => {
    expectRefusal(
      decodePoolsClaimSettlement(
        [claimedLog({}, STRANGER)],
        { account: WALLET, tokenAddress: TOKEN },
        { locker: STRANGER },
      ),
      "not one of the pools.fun suites Vex knows",
    );
  });

  it("a known locker hint selects only that suite: a Claimed from another suite's locker is not believed", () => {
    expectRefusal(
      decodePoolsClaimSettlement(
        [claimedLog({}, V1.locker)],
        { account: WALLET, tokenAddress: TOKEN },
        { locker: V3.locker },
      ),
      "no Claimed event",
    );
  });
});

/**
 * FEES TO HOLDERS: the one launch shape where the receipt's fee recipient is
 * NOT the address that was signed.
 *
 * The verified V3 gateway resolves a `FEES_TO_HOLDERS*` sentinel to the
 * distributor it deploys inside the same transaction BEFORE it emits
 * `GatewayLaunch`. So on such a launch:
 *
 *   - the signed tuple carries the SENTINEL (proven by verifier point 15);
 *   - the receipt carries the DISTRIBUTOR;
 *   - they are different addresses, and neither is wrong.
 *
 * Comparing the receipt to the sentinel would therefore refuse every correct
 * holders launch, and accepting whatever the gateway emitted would prove
 * nothing. What stands in their place is this transaction's own
 * `DistributorDeployed(token, distributor, rewardMode)`, from the suite's pinned
 * HolderRewardsDeployer - and each of its four facts is asserted here as a
 * separate refusal, because each one is a different way for a fee stream to end
 * up somewhere nobody agreed to.
 */
describe("fees-to-holders settlement: the receipt names the distributor, not the sentinel", () => {
  const v3Suite = POOLS_SUITES.find((s) => s.version === 3);
  if (v3Suite === undefined) throw new Error("the suite table has no V3 entry");
  const v3Deployer = v3Suite.holderRewardsDeployer;
  if (v3Deployer === undefined) throw new Error("the V3 suite entry has no HolderRewardsDeployer");

  const V3_GATEWAY = getAddress(v3Suite.gateway);
  const V3_FACTORY = getAddress(v3Suite.factory);
  const DEPLOYER = getAddress(v3Deployer);
  /** `gateway.FEES_TO_HOLDERS_BOTH()`, measured on the V3 gateway 2026-09-04. */
  const SENTINEL_BOTH = getAddress("0x968b0c1e896fb1ddb2042957fc0614c67ab7ffc4");
  const DISTRIBUTOR = getAddress("0x25ff1A3D3C9dE60Cd0Cf7E2E5c0C5f6c9e0b1234");

  /** `DistributorDeployed(token, distributor, rewardMode)` from a chosen emitter. */
  function distributorLog(
    over: Partial<{ token: Address; distributor: Address; rewardMode: number }> = {},
    emitter: string = DEPLOYER,
  ): PoolsSettlementLog {
    const f = { token: TOKEN, distributor: DISTRIBUTOR, rewardMode: 2, ...over };
    const topics = encodeEventTopics({
      abi: [POOLS_DISTRIBUTOR_DEPLOYED_EVENT_ABI] as const,
      eventName: "DistributorDeployed",
      args: { token: f.token, distributor: f.distributor },
    });
    const data = encodeAbiParameters([{ type: "uint8" }], [f.rewardMode]);
    return { address: emitter, topics: concreteTopics(topics), data };
  }

  /** A V3 holders launch: the gateway emitted the DISTRIBUTOR as the fee recipient. */
  function holdersLogs(over: { rewardMode?: number; distributor?: Address; emittedRecipient?: Address } = {}) {
    const distributor = over.distributor ?? DISTRIBUTOR;
    return [
      gatewayLog({ feeRecipient: over.emittedRecipient ?? distributor }, V3_GATEWAY),
      factoryLog(
        {
          creator: V3_GATEWAY,
          deployer: V3_GATEWAY,
          feeRecipient: over.emittedRecipient ?? distributor,
        },
        V3_FACTORY,
      ),
      distributorLog({
        distributor,
        ...(over.rewardMode === undefined ? {} : { rewardMode: over.rewardMode }),
      }),
    ];
  }

  /** What the authorized plan holds for a holders launch: the SENTINEL, plus the mode. */
  const HOLDERS_EXPECTED: PoolsLaunchExpectation = {
    ...EXPECTED,
    // The signed tuple's recipient. Deliberately NOT the address the receipt
    // carries - that is the whole point of this shape.
    feeRecipient: SENTINEL_BOTH,
    holderRewards: { mode: "both", sentinel: SENTINEL_BOTH },
  };

  it("accepts the launch and reports the PROVEN distributor and mode", () => {
    const result = decodePoolsLaunchSettlement(holdersLogs(), HOLDERS_EXPECTED, {
      gateway: V3_GATEWAY,
    });
    if (!result.ok) throw new Error(`expected a proven holders launch, got: ${result.reason}`);
    expect(result.value.feeRecipient).toBe(DISTRIBUTOR);
    expect(result.value.holderRewards).toEqual({ distributor: DISTRIBUTOR, mode: "both" });
  });

  // The regression this arm exists to prevent: the old decoder compared the
  // receipt's recipient to the plan's, and the plan's is the sentinel. Every
  // correct holders launch would have been declined as "somebody else's".
  it("does NOT require the receipt to carry the sentinel that was signed", () => {
    const result = decodePoolsLaunchSettlement(holdersLogs(), HOLDERS_EXPECTED, {
      gateway: V3_GATEWAY,
    });
    expect(result.ok).toBe(true);
    // The sentinel really is a different address from what the receipt named.
    expect(SENTINEL_BOTH).not.toBe(DISTRIBUTOR);
  });

  it("refuses when the receipt carries no DistributorDeployed at all", () => {
    const logs = holdersLogs().slice(0, 2);
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: V3_GATEWAY }),
      "no DistributorDeployed event",
    );
  });

  // Any contract can emit a same-signature event. A distributor "proven" by an
  // unpinned emitter is not proven at all.
  it("refuses a DistributorDeployed from an emitter that is not the suite's deployer", () => {
    const logs = [...holdersLogs().slice(0, 2), distributorLog({}, STRANGER)];
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: V3_GATEWAY }),
      "no DistributorDeployed event",
    );
  });

  it("refuses when the deployed distributor belongs to a DIFFERENT token", () => {
    const logs = [
      ...holdersLogs().slice(0, 2),
      distributorLog({ token: getAddress("0x1111111111111111111111111111111111111111") }),
    ];
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: V3_GATEWAY }),
      "belongs to a different token",
    );
  });

  // THE JOIN. Without it the receipt would only prove "a distributor was
  // deployed", never "the fee stream goes to it".
  it("refuses when the fee stream went somewhere other than the deployed distributor", () => {
    const logs = holdersLogs({ emittedRecipient: STRANGER });
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: V3_GATEWAY }),
      "does not go to the distributor",
    );
  });

  // The user agreed to be paid in one asset. A distributor running in another
  // mode pays a different stream for the life of the token.
  it("refuses when the distributor's mode is not the mode that was authorized", () => {
    const logs = holdersLogs({ rewardMode: 0 });
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: V3_GATEWAY }),
      'runs in "token" mode',
    );
  });

  it("refuses a reward-mode ordinal this build has no name for, rather than reporting a number", () => {
    const logs = holdersLogs({ rewardMode: 7 });
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: V3_GATEWAY }),
      "has no name for",
    );
  });

  it("refuses two DistributorDeployed events rather than picking one", () => {
    const logs = [
      ...holdersLogs(),
      distributorLog({ distributor: getAddress("0x2222222222222222222222222222222222222222") }),
    ];
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: V3_GATEWAY }),
      "cannot be established",
    );
  });

  // An ORDINARY launch is unchanged and must stay exact: no holders intent means
  // the receipt has to name the address that was signed, and nothing about the
  // new arm may loosen that.
  it("still holds an ORDINARY launch to exact recipient equality", () => {
    const logs = [
      gatewayLog({ feeRecipient: STRANGER }, V3_GATEWAY),
      factoryLog({ creator: V3_GATEWAY, deployer: V3_GATEWAY, feeRecipient: STRANGER }, V3_FACTORY),
    ];
    expectRefusal(
      decodePoolsLaunchSettlement(logs, { ...EXPECTED, holderRewards: null }, { gateway: V3_GATEWAY }),
      "the fee stream was set to",
    );
  });

  // A V1 or V2 launch cannot deploy a paired or both distributor at all. Skipping
  // the proof for a suite with no known deployer would accept an unaccountable
  // fee destination.
  it("refuses a holders launch on a suite whose HolderRewardsDeployer is unknown", () => {
    const v1Suite = POOLS_SUITES.find((s) => s.version === 1);
    if (v1Suite === undefined) throw new Error("the suite table has no V1 entry");
    expect(v1Suite.holderRewardsDeployer).toBeUndefined();
    const logs = [
      gatewayLog({ feeRecipient: DISTRIBUTOR }),
      factoryLog({ feeRecipient: DISTRIBUTOR }),
    ];
    expectRefusal(
      decodePoolsLaunchSettlement(logs, HOLDERS_EXPECTED, { gateway: v1Suite.gateway }),
      "has no HolderRewardsDeployer",
    );
  });
});
