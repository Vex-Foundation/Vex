/**
 * THE LAST CLOCK BEFORE THE KEY, on the pools.fun launch.
 *
 * ## The defect this file pins
 *
 * `pools.launch_execute` checked the signed quote's expiry at the ANCHORED
 * BLOCK, inside the verifier, and the desktop lane checked it again when Deploy
 * was clicked. Both of those happen BEFORE authorization, before the durable
 * activity write, before gas estimation, before fee filling and before the
 * durable nonce reservation - all of which reach the network and can stall.
 *
 * So a launch could pass every check with eleven seconds of quote left, spend
 * twelve seconds preparing, and then sign and broadcast calldata the factory was
 * already guaranteed to reject: the deployment fee is spent, the transaction
 * reverts, and nothing in the path had asked the clock again.
 *
 * The gate belongs at the ONE boundary both paths share - `onBeforeSign`, the
 * last hook `signStageBroadcast` calls before the signature, with nothing
 * awaited after it that could reach a provider.
 *
 * ## How these tests drive it
 *
 * The REAL `signStageBroadcast` runs, over fake viem clients whose
 * `prepareTransactionRequest` and whose durable nonce reservation ADVANCE THE
 * CLOCK - which is exactly where the stall happens in production. The
 * assertions are on the observable effects a user would meet: whether the key
 * was asked for a signature, whether any bytes reached the network, what the
 * intent's end state is, and whether the refusal says which clock ran out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  http,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Chain,
  type Hex,
  type TransactionSerialized,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { definedValue } from "../../../../_test-value-guards.js";

import {
  PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
  POOLS_GATEWAY_LAUNCH_EVENT_ABI,
} from "@tools/pools-fun/abi.js";
import { POOLS_CHAIN_ID, poolsLaunchSuite } from "@tools/pools-fun/constants.js";
import type { PoolsChainAnchors, PoolsLaunchTuple } from "@tools/pools-fun/launch/verifier-types.js";

const SUITE = poolsLaunchSuite();
const GATEWAY = getAddress(SUITE.gateway);
const FACTORY = getAddress(SUITE.factory);
const LOCKER = getAddress(SUITE.locker);
const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const WALLET = getAddress(ACCOUNT.address);
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const STOCK = getAddress("0x000000000000000000000000000000000000dead");
const SALT = `0x${"7a".repeat(32)}` as Hex;
const CALLDATA = `0x${"cd".repeat(64)}` as Hex;
const FINGERPRINT = `0x${"ef".repeat(32)}` as Hex;
const METADATA_URI = "ipfs://bafkreifaguifkgqdrrs2cwlbjejqblrguynowkm3zb77yvq3gsydqacywm";

const FEE_WEI = 1_051_674_002_092_832n;
const PREBUY_WEI = 10_000_000_000_000_000n;
const VALUE_WEI = FEE_WEI + PREBUY_WEI;
const DEV_BUY_OUT = 112_657_539_798_287_513_447_808n;

/**
 * The wall clock every test starts at, and the two on-chain clocks.
 *
 * The quote has FIFTEEN seconds left at t0, which clears the ten-second margin
 * the verifier already applies at the anchored block - so the launch is alive
 * when it reaches the broadcaster, and only the stall kills it.
 */
const BASE_MS = 1_787_054_000_000;
const BASE_SECONDS = BigInt(Math.floor(BASE_MS / 1000));
const QUOTE_EXPIRES_AT = BASE_SECONDS + 15n;
const GATEWAY_DEADLINE = BASE_SECONDS + 20n * 60n;

const CHAIN: Chain = defineChain({
  id: POOLS_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
});

// ── The doubles the broadcaster's bookkeeping runs against ──────────
//
// Factory-mocked rather than spied: these repositories return whole database
// rows, and a spy would need a cast per call to hand back a partial one. The
// calls this file asserts on are captured through `vi.fn()`s declared beside the
// mock, so what is asserted is what the handler actually asked for.

const dbCalls = vi.hoisted(() => ({
  nonceReservations: [] as number[],
  broadcastStaged: [] as number[],
  /**
   * Host-clock milliseconds at `onHashStaged` - the first hook after the
   * signature exists, and therefore an upper bound on when the bytes were
   * signed. Nothing between the signature and this hook moves the fake clock.
   */
  stagedAtMs: [] as number[],
  abortedFrom: [] as number[],
  failedIntents: [] as string[],
  confirmedIntents: [] as string[],
  intentFailureReasons: [] as string[],
  /** Milliseconds the durable nonce reservation itself burns. */
  nonceStallMs: 0,
}));

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: async () => undefined,
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: async () => ({ executionId: 7, events: [{ id: 70 }] }),
  reserveActivityEvmNonce: async (_id: number, request: { nodePendingNonce: number }) => {
    dbCalls.nonceReservations.push(request.nodePendingNonce);
    // THE STALL THIS FILE IS ABOUT. The durable reservation takes a wallet lock
    // and reconciles unresolved rows; under contention it waits, and the wall
    // clock moves while the calldata does not.
    vi.setSystemTime(Date.now() + dbCalls.nonceStallMs);
    return request.nodePendingNonce;
  },
  markActivityBroadcast: async (id: number) => {
    dbCalls.broadcastStaged.push(id);
    dbCalls.stagedAtMs.push(Date.now());
    return { applied: true };
  },
  markBroadcastAccepted: async () => ({ applied: true }),
  confirmLaunchWithOutputIdentity: async () => ({ applied: true }),
  fillLaunchOutputIdentityOnConfirmed: async () => true,
  stampLaunchOutputIdentityByTxHash: async () => undefined,
  failActivityEvent: async () => undefined,
  abortPlannedEvents: async (_executionId: number, fromIndex: number) => {
    dbCalls.abortedFrom.push(fromIndex);
    return [];
  },
}));
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  markBroadcastPendingWith: async () => ({ intentId: "intent-1" }),
  confirmWith: async (_client: unknown, intentId: string) => {
    dbCalls.confirmedIntents.push(intentId);
    return { intentId };
  },
  failWith: async (_client: unknown, intentId: string, _sessionId: string, reason: string) => {
    dbCalls.failedIntents.push(intentId);
    dbCalls.intentFailureReasons.push(reason);
    return { intentId };
  },
}));
vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  record: async () => ({ inserted: true }),
}));
vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: async () => undefined,
}));

const { broadcastPoolsLaunch } = await import(
  "@vex-agent/tools/protocols/pools/handlers/launch/execute/broadcast.js"
);
const attribution = await import(
  "@vex-agent/tools/protocols/pools/handlers/launch/execute/attribute.js"
);
const tokenRegistration = await import("@tools/pools-fun/evm/token-registration.js");
const { POOLS_LAUNCH_SIGNING_MARGIN_MS, poolsLaunchOnChainExpiry } = await import(
  "@vex-agent/tools/protocols/pools/handlers/launch/execute/expiry.js"
);
type PoolsLaunchPlan = Parameters<typeof broadcastPoolsLaunch>[0]["plan"];

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

/** Real encoded events, so the confirmed path decodes what it will actually meet. */
function receiptLogs(): { address: Address; topics: string[]; data: Hex }[] {
  return [
    {
      address: GATEWAY,
      topics: concreteTopics(
        encodeEventTopics({
          abi: POOLS_GATEWAY_LAUNCH_EVENT_ABI,
          eventName: "GatewayLaunch",
          args: { token: TOKEN, pool: POOL, launcher: WALLET },
        }),
      ),
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
        [WETH, WALLET, SALT, FEE_WEI, DEV_BUY_OUT],
      ),
    },
    {
      address: FACTORY,
      topics: concreteTopics(
        encodeEventTopics({
          abi: PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
          eventName: "TokenLaunched",
          args: { token: TOKEN, pool: POOL, creator: GATEWAY },
        }),
      ),
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "int24" }, { type: "string" }, { type: "uint256" }],
        [WETH, GATEWAY, WALLET, -197_600, METADATA_URI, DEV_BUY_OUT],
      ),
    },
  ];
}

/** A SIGNED_STOCK tuple: the shape whose quote can die between check and key. */
function signedStockTuple(over: Partial<PoolsLaunchTuple> = {}): PoolsLaunchTuple {
  return {
    name: "Vex Flamingo",
    symbol: "VEXFLAM",
    metadataUri: METADATA_URI,
    userSalt: SALT,
    pairedAsset: STOCK,
    expectedStartTick: -197_600,
    deadline: GATEWAY_DEADLINE,
    feeRecipient: WALLET,
    nativeDevBuyAmount: PREBUY_WEI,
    erc20DevBuyAmountIn: 0n,
    devBuyMinOut: DEV_BUY_OUT,
    expectedFeeWei: FEE_WEI,
    priceAttestation: {
      asset: STOCK,
      underlyingPriceUsdE18: 187_420_000_000_000_000_000n,
      expectedUiMultiplier: 1_000_000_000_000_000_000n,
      observedAt: BASE_SECONDS - 30n,
      expiresAt: QUOTE_EXPIRES_AT,
      pricingEpoch: 4n,
    },
    priceSignature: `0x${"9c".repeat(65)}` as Hex,
    ...over,
  };
}

/** The all-zero attestation every non-stock pair carries: a value, not an absence. */
function wethTuple(over: Partial<PoolsLaunchTuple> = {}): PoolsLaunchTuple {
  return signedStockTuple({
    pairedAsset: WETH,
    priceAttestation: {
      asset: "0x0000000000000000000000000000000000000000",
      underlyingPriceUsdE18: 0n,
      expectedUiMultiplier: 0n,
      observedAt: 0n,
      expiresAt: 0n,
      pricingEpoch: 0n,
    },
    priceSignature: "0x",
    ...over,
  });
}

function anchors(): PoolsChainAnchors {
  return {
    blockNumber: 39_620_464n,
    gatewayVersion: 3n,
    gatewayFactory: FACTORY,
    factoryLocker: LOCKER,
    gatewayPaused: false,
    gatewayDeploymentFeeWei: FEE_WEI,
    gatewayMinFeeWei: 1_000_000_000_000n,
    gatewayMaxFeeWei: 10_000_000_000_000_000n,
    gatewayWeth: WETH,
    feesToHoldersSentinels: { token: null, paired: null, both: null },
    pairedAssetAllowed: true,
    pricingMode: "SIGNED_STOCK",
    startTick: null,
    startTickLive: false,
    signedStartTick: -197_600,
    signedStartTickError: null,
    priceSigner: getAddress("0x00000000000000000000000000000000000000aa"),
    pricingEpoch: 4n,
    assetMaxQuoteAgeSeconds: 60n,
    minSignedQuoteAgeSeconds: 30n,
    maxSignedQuoteAgeSeconds: 120n,
    blockTimestamp: BASE_SECONDS,
    computedTokenAddress: TOKEN,
    nativeBalanceWei: 10n ** 18n,
  };
}

/** A plan that has already passed the verifier - the broadcaster never re-runs it. */
function plan(tuple: PoolsLaunchTuple): PoolsLaunchPlan {
  return {
    call: { chainId: POOLS_CHAIN_ID, to: GATEWAY, data: CALLDATA, valueWei: VALUE_WEI, fingerprint: FINGERPRINT },
    tuple,
    feeLeg: null,
    anchors: anchors(),
    predictedPoolAddress: POOL,
    metadataUri: METADATA_URI,
    imageLanded: true,
    gas: { limit: 3_000_000n, priceWei: 1_000_000n, boundWei: 3_000_000_000_000n },
    simulateOnly: false,
    binding: {
      name: "Vex Flamingo",
      symbol: "VEXFLAM",
      metadataUri: METADATA_URI,
      imageUrl: "https://example.test/flamingo.png",
      imageId: "img-1",
      chainId: POOLS_CHAIN_ID,
      gateway: GATEWAY,
      pairedAsset: "weth",
      pairedAssetAddress: WETH,
      predictedTokenAddress: TOKEN,
      userSalt: SALT,
      deploymentFeeWei: FEE_WEI.toString(),
      prebuyWei: PREBUY_WEI.toString(),
      msgValueWei: VALUE_WEI.toString(),
      vexFeeWei: "2629185005232",
      gasBoundWei: "3000000000000",
      anchorBlockNumber: "39620464",
      feeRecipient: WALLET,
      holderRewards: null,
      walletAddress: WALLET,
      calldata: CALLDATA,
      callFingerprint: FINGERPRINT,
      sessionId: "sess-1",
      permission: "full",
    },
  };
}

/**
 * The clients the real staged broadcast runs against.
 *
 * `prepareTransactionRequest` is where the PREPARATION stall lives: viem may
 * route fee and nonce filling through the node, and that round trip is time the
 * signed quote spends dying.
 */
function harness(prepareStallMs: number) {
  // THE KEY ITSELF, watched where it actually signs. The launch broadcasts
  // through the DEFERRED signer arm, which signs offline with the local
  // account's own signer rather than through viem's wallet action - so a double
  // on the wallet client's `signTransaction` would sit on a path nothing takes
  // and prove nothing about whether the key was asked. The spy calls through:
  // these tests broadcast real signed bytes.
  const signTransaction = vi.spyOn(ACCOUNT, "signTransaction");
  const sendRawTransaction = vi.fn(async () => `0x${"ab".repeat(32)}` as Hex);

  const prepared = {
    to: GATEWAY,
    data: CALLDATA,
    value: VALUE_WEI,
    gas: 3_000_000n,
    nonce: 11,
    chain: CHAIN,
    maxFeePerGas: 1_500_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  };
  const prepare = vi.fn(async () => {
    vi.setSystemTime(Date.now() + prepareStallMs);
    return prepared;
  });

  const publicClient = Object.assign(
    createPublicClient({ chain: CHAIN, transport: http("http://127.0.0.1:1") as Transport }),
    {
      estimateGas: vi.fn(async () => 2_000_000n),
      prepareTransactionRequest: prepare,
      sendRawTransaction,
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        blockNumber: 39_620_500n,
        logs: receiptLogs(),
      })),
    },
  );

  const walletClient = Object.assign(
    createWalletClient({ account: ACCOUNT, chain: CHAIN, transport: http("http://127.0.0.1:1") as Transport }),
    { prepareTransactionRequest: prepare },
  );

  return { publicClient, walletClient, signTransaction, sendRawTransaction };
}

async function run(tuple: PoolsLaunchTuple, prepareStallMs: number) {
  const clients = harness(prepareStallMs);
  const result = await broadcastPoolsLaunch({
    intentId: "intent-1",
    sessionId: "sess-1",
    walletAddress: WALLET,
    plan: plan(tuple),
    params: { name: "Vex Flamingo", symbol: "VEXFLAM" },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
  });
  return { ...clients, result };
}

beforeEach(() => {
  dbCalls.nonceReservations.length = 0;
  dbCalls.broadcastStaged.length = 0;
  dbCalls.stagedAtMs.length = 0;
  dbCalls.abortedFrom.length = 0;
  dbCalls.failedIntents.length = 0;
  dbCalls.confirmedIntents.length = 0;
  dbCalls.intentFailureReasons.length = 0;
  dbCalls.nonceStallMs = 0;
  // Only `Date` is faked: the nonce owner and the receipt guard schedule real
  // timers, and freezing those would deadlock the very path under test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_MS);
  vi.spyOn(attribution, "signAndStorePoolsAttestation").mockResolvedValue(`0x${"ab".repeat(65)}`);
  vi.spyOn(attribution, "signAndStoreAgentscanAttestation").mockResolvedValue(undefined);
  vi.spyOn(attribution, "postPoolsLaunchAttribution").mockResolvedValue(undefined);
  vi.spyOn(tokenRegistration, "readPoolsTokenDecimals").mockResolvedValue(18);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a signed quote that dies during preparation", () => {
  it("refuses at the last gate before the key: nothing signed, nothing broadcast", async () => {
    dbCalls.nonceStallMs = 5_000;
    const { result, signTransaction, sendRawTransaction } = await run(signedStockTuple(), 6_000);

    // ELEVEN SECONDS LATER the quote has four left, under the ten-second margin
    // the verifier itself applies - so these bytes are now guaranteed to revert.
    expect(signTransaction).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
    // The reservation DID happen, which is the point: the stall is downstream of
    // every check the launch had already passed.
    expect(dbCalls.nonceReservations).toEqual([11]);
    expect(dbCalls.broadcastStaged).toEqual([]);

    expect(result.success).toBe(false);
    expect(result.output).toContain("refused before signing");
    expect(result.output).toContain("Nothing was signed");
    // WHICH CLOCK RAN OUT, in the refusal itself.
    expect(result.output).toContain("signed stock price quote");
  });

  it("terminalizes the intent honestly instead of leaving it in flight", async () => {
    dbCalls.nonceStallMs = 5_000;
    await run(signedStockTuple(), 6_000);

    expect(dbCalls.abortedFrom).toEqual([0]);
    expect(dbCalls.failedIntents).toEqual(["intent-1"]);
    expect(dbCalls.intentFailureReasons.join(" ")).toContain("PreSign");
    expect(dbCalls.confirmedIntents).toEqual([]);
  });
});

describe("a gateway deadline that passes during preparation", () => {
  it("refuses by name on a pair that carries no signed quote", async () => {
    const tuple = wethTuple({ deadline: BASE_SECONDS + 12n });
    const { result, signTransaction, sendRawTransaction } = await run(tuple, 6_000);

    expect(signTransaction).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toContain("on-chain deadline");
  });
});

describe("the gate is a clock, not a blanket refusal", () => {
  it("signs and broadcasts a launch whose quote is still alive after preparation", async () => {
    const { result, signTransaction, sendRawTransaction } = await run(signedStockTuple(), 1_000);

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(dbCalls.confirmedIntents).toEqual(["intent-1"]);
  });

  it("never treats an all-zero attestation as a deadline in 1970", async () => {
    const { result, signTransaction } = await run(wethTuple(), 1_000);

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe("which clock kills the authorized bytes", () => {
  it("takes the tightest of the two, with the verifier's own margin on both", () => {
    const quoteFirst = poolsLaunchOnChainExpiry(signedStockTuple());
    expect(quoteFirst).toEqual({
      atMs: Number(QUOTE_EXPIRES_AT) * 1000 - POOLS_LAUNCH_SIGNING_MARGIN_MS,
      clock: "quote_window",
    });

    // A deadline INSIDE the quote's life is the one that binds: the bytes are
    // dead at whichever number comes first, not at the one this lane happens to
    // care about most.
    const deadlineFirst = poolsLaunchOnChainExpiry(
      signedStockTuple({ deadline: BASE_SECONDS + 5n }),
    );
    expect(deadlineFirst).toEqual({
      atMs: Number(BASE_SECONDS + 5n) * 1000 - POOLS_LAUNCH_SIGNING_MARGIN_MS,
      clock: "gateway_deadline",
    });
  });

  it("reports no on-chain clock when the calldata carries neither", () => {
    // A zero deadline is "no deadline" and an all-zero attestation is "this pair
    // needs no signed quote" - neither is a moment in 1970.
    expect(poolsLaunchOnChainExpiry(wethTuple({ deadline: 0n }))).toBeNull();
  });
});

/**
 * THE SAME LAUNCH, driven through a wallet client whose PROVIDER IS REAL enough
 * to answer.
 *
 * The harness above hands the wallet client a `signTransaction` double, which is
 * exactly what hides the defect this block is about: viem's `signTransaction`
 * WALLET ACTION awaits `eth_chainId` before it reaches the local account
 * (measured in the installed viem 2.54.3,
 * `viem/_esm/actions/wallet/signTransaction.js:63`), so on the eager arm a
 * provider round trip stands BETWEEN the expiry gate and the signature. A gate
 * that passed with four seconds of headroom can therefore be followed by a stall
 * and a signature over bytes that are already dead.
 *
 * So here the wallet client keeps its own transport, records every request it
 * receives, and makes `eth_chainId` cost sixteen seconds. Only the public
 * client's reads are doubled - the signing path itself is the real one.
 */
function offlineSigningHarness(chainIdStallMs: number) {
  const walletRequests: { readonly method: string; readonly atMs: number }[] = [];
  const sentBytes: TransactionSerialized[] = [];
  const sendRawTransaction = vi.fn(
    async ({ serializedTransaction }: { serializedTransaction: TransactionSerialized }) => {
      sentBytes.push(serializedTransaction);
      return `0x${"ab".repeat(32)}` as Hex;
    },
  );

  // What viem's own `prepareTransactionRequest` produces, `chainId` included -
  // the field the offline signer asserts the prepared chain against.
  const prepare = vi.fn(async () => ({
    to: GATEWAY,
    data: CALLDATA,
    value: VALUE_WEI,
    gas: 3_000_000n,
    nonce: 11,
    chainId: POOLS_CHAIN_ID,
    chain: CHAIN,
    maxFeePerGas: 1_500_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  }));

  const publicClient = Object.assign(
    createPublicClient({ chain: CHAIN, transport: http("http://127.0.0.1:1") as Transport }),
    {
      estimateGas: vi.fn(async () => 2_000_000n),
      prepareTransactionRequest: prepare,
      sendRawTransaction,
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        blockNumber: 39_620_500n,
        logs: receiptLogs(),
      })),
    },
  );

  const walletClient = Object.assign(
    createWalletClient({
      account: ACCOUNT,
      chain: CHAIN,
      transport: custom({
        request: async ({ method }) => {
          walletRequests.push({ method, atMs: Date.now() });
          if (method === "eth_chainId") {
            // THE STALL viem's wallet action opens the window for: a node that
            // answers slowly, sixteen seconds after a gate that had four.
            vi.setSystemTime(Date.now() + chainIdStallMs);
            return numberToHex(POOLS_CHAIN_ID);
          }
          throw new Error(`unexpected provider call on the signing path: ${method}`);
        },
      }),
    }),
    // Preparation is doubled on both clients so the ONLY thing that can reach
    // this transport is a call the signing path itself makes.
    { prepareTransactionRequest: prepare },
  );

  return { publicClient, walletClient, sendRawTransaction, walletRequests, sentBytes };
}

describe("nothing reaches the network between the last check and the signature", () => {
  it("signs the launch offline while its quote is still alive, despite a stalling node", async () => {
    const tuple = signedStockTuple();
    const clients = offlineSigningHarness(16_000);

    const result = await broadcastPoolsLaunch({
      intentId: "intent-1",
      sessionId: "sess-1",
      walletAddress: WALLET,
      plan: plan(tuple),
      params: { name: "Vex Flamingo", symbol: "VEXFLAM" },
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
    });

    // THE STRUCTURAL PROPERTY. The wallet client's provider was never asked for
    // anything at all: there is no round trip left standing between the expiry
    // gate and the bytes, so no stall can outlive the check.
    expect(clients.walletRequests).toEqual([]);

    // THE CONSEQUENCE the user meets. The gate passed with the quote alive, and
    // the signature exists while it is still alive - not sixteen seconds later,
    // when these exact bytes would be certain to revert.
    const expiry = definedValue(poolsLaunchOnChainExpiry(tuple), "the tuple's on-chain expiry");
    const stagedAtMs = definedValue(dbCalls.stagedAtMs[0], "the moment the signed hash was staged");
    expect(stagedAtMs).toBeLessThan(expiry.atMs);
    expect(stagedAtMs).toBe(BASE_MS);

    // A REAL SIGNATURE over the authorized bytes, produced with no provider at
    // all: the chain id came from preparation, and the key that signed is the
    // wallet the launch was prepared for.
    const sent = definedValue(clients.sentBytes[0], "the broadcast raw transaction");
    const parsed = parseTransaction(sent);
    expect(parsed.chainId).toBe(POOLS_CHAIN_ID);
    expect(parsed.to).toBe(GATEWAY.toLowerCase());
    expect(parsed.nonce).toBe(11);
    await expect(recoverTransactionAddress({ serializedTransaction: sent })).resolves.toBe(WALLET);

    expect(result.success).toBe(true);
    expect(clients.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(dbCalls.confirmedIntents).toEqual(["intent-1"]);
  });

  it("still refuses at the gate, with the key never asked, when the quote died first", async () => {
    dbCalls.nonceStallMs = 5_000;
    const clients = offlineSigningHarness(16_000);
    // The nonce reservation burns five seconds, the preparation double burns
    // none, and the quote's margin is gone at t0 + 5 s.
    vi.setSystemTime(BASE_MS + 1_000);

    const result = await broadcastPoolsLaunch({
      intentId: "intent-1",
      sessionId: "sess-1",
      walletAddress: WALLET,
      plan: plan(signedStockTuple()),
      params: { name: "Vex Flamingo", symbol: "VEXFLAM" },
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
    });

    expect(clients.walletRequests).toEqual([]);
    expect(clients.sentBytes).toEqual([]);
    expect(dbCalls.stagedAtMs).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.output).toContain("refused before signing");
    expect(result.output).toContain("signed stock price quote");
  });
});
