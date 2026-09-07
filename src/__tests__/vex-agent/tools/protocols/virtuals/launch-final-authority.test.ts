/**
 * THE LAST GATE BEFORE THE KEY on a Virtuals agent launch.
 *
 * The defect this file reproduces (arc round-2 review, blocker 4): the launch
 * plan - implementations, BondingConfig, the venue's launch fee, the balance and
 * the allowance - was established on the FALLBACK reader and BEFORE the
 * allowance legs, while `preLaunch` is estimated, signed and broadcast on the
 * PINNED node minutes later. An approval mining is unbounded block time, and
 * BondingV5 sits behind a proxy: implementation A passed validation, the
 * approval mined, the proxy was upgraded to B, the estimate succeeded under B,
 * and Vex signed a launch whose meaning nothing had established.
 *
 * The suspension here is the real thing rather than a metaphor: the fake
 * broadcaster parks the APPROVAL leg on a controlled promise (that is the
 * approval mining), the test changes the pinned node's answer while it is
 * parked, and then resumes. The assertions are that the launch leg was NEVER
 * signed and that the refusal names what moved.
 *
 * `signStageBroadcast` is faked, and it is faked FAITHFULLY to the hook contract
 * it documents (`staged-broadcast.ts:325-388`): `onNonceReserved`, then
 * `onBeforeSign` as the last call before the signature, then `onHashStaged`,
 * then `onAccepted`. "Signed" in this file means "execution passed
 * `onBeforeSign`", which is exactly what the real function's ordering makes it
 * mean. The mechanism itself has its own suites; the subject here is the
 * handler's gate, plus the ARM it hands the mechanism - the deferred signer,
 * which is what makes the window between that gate and the signature carry no
 * provider call at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import { publicClientDouble, walletClientDouble } from "../../../../_test-evm-clients.js";
import { definedValue } from "../../../../_test-value-guards.js";
import { makeProtocolContext } from "../../_test-context.js";

const WALLET = getAddress("0x33Ef6673bd80CB11fCc41B82BC2181e65cc4D2fa");
const TOKEN = getAddress("0x1984edF491D3399FBc09E6d0856E01fF3721f952");
const PAIR = getAddress("0x3e11e685a056048C2dFa1c0dc1E1D0F233DbA84a");
const KEY = `0x${"11".repeat(32)}` as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const KEEPER_TX = `0x${"cd".repeat(32)}` as Hex;
const IMAGE_URL = "https://cdn.example.test/a/abc123.png";
const IMAGE_CID = "abc123";

/** A promise a test resolves by hand - the approval that is still mining. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

// ── The two readers, and the difference between them is the whole point ──
//
// `fallbackReads` answers the plan; `pinnedReads` answers the node that will
// broadcast. A gate that reads the fallback list cannot see anything only the
// pinned node knows.
let fallbackReads: Record<string, unknown> = {};
let pinnedReads: Record<string, unknown> = {};
let fallbackImplementations: Record<string, string> = {};
let pinnedImplementations: Record<string, string> = {};
/** What the bounded keeper wait answers. Both endings are correct outcomes. */
let keeperObservation: Record<string, unknown> = {};
/** Set by a test to corrupt the request the broadcaster hands the gate. */
let requestMutation: ((request: Record<string, unknown>) => Record<string, unknown>) | null = null;

function word(address: string): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: KEY }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: String(err) }),
}));

const failActivityEvent = vi.fn(async () => undefined);
const confirmLaunchWithOutputIdentity = vi.fn(
  async (_id: number, _input: Record<string, unknown>) => ({ applied: true }),
);
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: async (input: { events: readonly { eventIndex: number; eventRole: string }[] }) => ({
    executionId: 91,
    events: input.events.map((event, index) => ({ ...event, id: 300 + index })),
  }),
  confirmActivityEvent: async () => ({ applied: true }),
  confirmLaunchWithOutputIdentity: (id: number, input: Record<string, unknown>) =>
    confirmLaunchWithOutputIdentity(id, input),
  failActivityEvent: (...a: unknown[]) => failActivityEvent(...(a as [])),
  markActivityBroadcast: async () => ({ applied: true }),
  markBroadcastAccepted: async () => ({ applied: true }),
  reserveActivityEvmNonce: async () => 11,
}));

const readLaunchIntent = vi.fn();
const settleLaunchFailure = vi.fn(async () => true);
vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js", () => ({
  readLaunchIntent: (...a: unknown[]) => readLaunchIntent(...(a as [])),
  claimPreviewAndAuthorize: async () => ({ ok: true, intentId: "int_1" }),
  recordLaunchBroadcast: async () => ({ applied: true }),
  settleLaunchFailure: (...a: unknown[]) => settleLaunchFailure(...(a as [])),
  settleLaunchOutcome: async () => true,
}));

vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/activity.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/protocols/virtuals/handlers/launch/activity.js")
  >();
  return { ...actual, abortRemainingLaunchPlans: async () => undefined };
});

vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/identity.js", () => ({
  recordLaunchIdentity: async () => ({ attestation: { recorded: false, reason: "not the subject of this suite" } }),
}));

vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/fee-leg.js", () => ({
  runLaunchFeeLeg: async () => ({
    collection: "not_charged",
    collectionNote: "not the subject of this suite",
    txHash: null,
    feeAmountRaw: null,
    receiver: "0x0000000000000000000000000000000000000000",
  }),
}));

vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/image.js", () => ({
  resolveLaunchImage: async () => ({
    ok: true,
    image: { url: IMAGE_URL, cid: IMAGE_CID, imageId: "img_1", label: "agent.png" },
  }),
}));

/** The keeper's own observation, stubbed: this suite is about the signature. */
vi.mock("@tools/virtuals/launch/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/virtuals/launch/index.js")>();
  return {
    ...actual,
    keeperLogReaderFrom: () => ({}),
    waitForKeeperLaunch: async () => keeperObservation,
    decodePreLaunched: () => ({
      token: TOKEN,
      pair: PAIR,
      virtualId: 4242n,
      initialPurchaseRaw: 990_000_000_000_000_000n,
    }),
  };
});

function reads(node: () => Record<string, unknown>, implementations: () => Record<string, string>) {
  return {
    getBlockNumber: async () => 50_870_256n,
    getBlock: async () => ({ timestamp: 1_788_600_000n }),
    getStorageAt: async ({ address }: { address: Address }): Promise<Hex> =>
      word(definedValue(implementations()[address.toLowerCase()], "an implementation slot")),
    call: async () => ({ data: "0x" as Hex }),
    readContract: async ({ functionName }: { functionName: string }): Promise<unknown> => {
      const scripted = node()[functionName] ?? defaultReads()[functionName];
      if (scripted === undefined) throw new Error(`this test double has no script for the read ${functionName}`);
      return scripted;
    },
  };
}

const FEE_TO = getAddress("0x86CbAC9d9Ac726F729eEf6627Dc4817BcBB03A9c");

/** Lazy because the pinned deployment is imported below, after the mocks. */
function defaultReads(): Record<string, unknown> {
  return {
    bondingConfig: getAddress("0x8B4F0aB4a3B4A7e8F7C6c8bC9D6d3D2fF1e0a9B8"),
    // The closed-loop pin `readLaunchState` holds BondingV5 to: a suite whose
    // router is not the deployment's FRouterV3 is a different contract set.
    router: BASE.frouterV3,
    calculateLaunchFee: 0n,
    getScheduledLaunchParams: { startTimeDelay: 86_400n, normalLaunchFee: 0n, acfFee: 10_000_000_000_000_000_000n },
    feeTo: FEE_TO,
    initialSupply: 1_000_000_000n,
    decimals: 18,
    balanceOf: 10_000_000_000_000_000_000n,
    allowance: 10_000_000_000_000_000_000n,
  };
}

/** Every leg the fake was asked to send, every leg past the gate, every arm used. */
const staged: { to: Address; data: Hex; value: bigint }[] = [];
const signed: { to: Address; data: Hex; value: bigint }[] = [];
const signerArms: string[] = [];
let approvalMining = deferred();
let approvalReached = deferred();

vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: async (
    _publicClient: unknown,
    signer: { kind?: string },
    txParams: { to: Address; data: Hex; value: bigint },
    hooks: {
      onNonceReserved: (r: unknown) => Promise<number>;
      onHashStaged: (h: unknown) => Promise<void>;
      onAccepted: () => Promise<void>;
      onBeforeSign?: (request: unknown) => Promise<void>;
    },
  ) => {
    staged.push(txParams);
    signerArms.push(signer.kind ?? "eager");
    await hooks.onNonceReserved({ fromAddress: WALLET, chainId: 8453, nodePendingNonce: 11 });
    // THE APPROVAL MINING. The launch leg never waits here; the approval does,
    // and the test decides how long and what changes meanwhile.
    if (txParams.to.toLowerCase() !== BASE.bondingV5.toLowerCase()) {
      approvalReached.resolve();
      await approvalMining.promise;
    }
    const request: Record<string, unknown> = {
      to: txParams.to,
      data: txParams.data,
      value: txParams.value,
      gas: 5_000_000n,
      nonce: 11,
      gasPrice: undefined,
      maxFeePerGas: 1_000_000n,
      maxPriorityFeePerGas: 1_000n,
    };
    await hooks.onBeforeSign?.(
      requestMutation !== null && txParams.to.toLowerCase() === BASE.bondingV5.toLowerCase()
        ? requestMutation(request)
        : request,
    );
    // PAST THE GATE: from here the key is used. Anything recorded below happened
    // to a signature.
    signed.push(txParams);
    await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET, nonce: 11 });
    await hooks.onAccepted();
    return {
      kind: "confirmed" as const,
      txHash: TX_HASH,
      receipt: { blockNumber: 50_870_260n, logs: [], status: "success" },
    };
  },
}));

const fallbackClient = publicClientDouble(reads(() => fallbackReads, () => fallbackImplementations), 8453);
const pinnedClient = publicClientDouble(reads(() => pinnedReads, () => pinnedImplementations), 8453);
const signingWalletClient = walletClientDouble(WALLET, {}, 8453);

vi.mock("@tools/virtuals/curve/evm-client.js", () => ({
  getVirtualsCurvePublicClient: () => fallbackClient,
  getVirtualsCurveClients: () => ({ publicClient: pinnedClient, walletClient: signingWalletClient }),
}));

const { virtualsLaunchExecute } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/launch-execute.js"
);
const { virtualsCurveDeployment } = await import("@tools/virtuals/curve/index.js");

const BASE = definedValue(virtualsCurveDeployment("base"), "the Base Virtuals deployment");

function defaultImplementations(): Record<string, string> {
  return {
    [BASE.bondingV5.toLowerCase()]: BASE.implementations.bondingV5,
    [BASE.frouterV3.toLowerCase()]: BASE.implementations.frouterV3,
  };
}

const CONTEXT = makeProtocolContext({ sessionId: "s-1", sessionPermission: "full", approved: true });

function params(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    chain: "base",
    name: "Otaku Analyst",
    symbol: "OTAKU",
    description: "reads anime sentiment",
    cores: ["0", "1", "2"],
    amountIn: "1",
    imageId: "img_1",
    ...overrides,
  };
}

/**
 * The block the preview sealed, taken from the production plan itself.
 *
 * `simulateOnly` runs the whole path to the edge of signing and claims nothing,
 * so the figures it reports ARE the plan's - which is what an approval seals.
 * Deriving them here by hand would let a test agree with itself while disagreeing
 * with the handler.
 */
async function sealedBlockFromPlan(): Promise<Record<string, unknown>> {
  const result = await virtualsLaunchExecute(params({ simulateOnly: true }), CONTEXT);
  if (!result.success) throw new Error(`the plan itself refused: ${result.output}`);
  const plan = JSON.parse(result.output) as {
    agent: { onChainName: string; imageUrl: string };
    money: { venueReceivesRaw: string; protocolLaunchFeeRaw: string };
    transaction: { calldataFingerprint: string };
  };
  return {
    chainKey: "base",
    bondingV5: BASE.bondingV5,
    imageUrl: plan.agent.imageUrl,
    imageCid: IMAGE_CID,
    cores: [0, 1, 2],
    antiSniperTaxType: 0,
    nameSuffix: "by_virtuals",
    onChainName: plan.agent.onChainName,
    urls: ["", "", "", ""],
    calldataFingerprint: plan.transaction.calldataFingerprint,
    launchAmountRaw: plan.money.venueReceivesRaw,
    protocolFeeRaw: plan.money.protocolLaunchFeeRaw,
  };
}

/** Start the execute, wait until the approval leg is parked, then act. */
async function executeWithApprovalMining(
  meanwhile: () => void,
): Promise<Awaited<ReturnType<typeof virtualsLaunchExecute>>> {
  const block = await sealedBlockFromPlan();
  readLaunchIntent.mockResolvedValue({ protocol: "virtuals", virtuals: block });
  const inFlight = virtualsLaunchExecute(params({ previewId: "prev_1" }), CONTEXT);
  await approvalReached.promise;
  meanwhile();
  approvalMining.resolve();
  return await inFlight;
}

function refusalText(result: Awaited<ReturnType<typeof virtualsLaunchExecute>>): string {
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
}

/** Which legs got past the gate, by target. */
function signedTargets(): string[] {
  return signed.map((leg) => (leg.to.toLowerCase() === BASE.bondingV5.toLowerCase() ? "pre_launch" : "allowance"));
}

beforeEach(() => {
  vi.clearAllMocks();
  staged.length = 0;
  signed.length = 0;
  signerArms.length = 0;
  approvalMining = deferred();
  approvalReached = deferred();
  fallbackReads = { allowance: 0n };
  pinnedReads = { allowance: 0n };
  fallbackImplementations = defaultImplementations();
  pinnedImplementations = defaultImplementations();
  requestMutation = null;
  keeperObservation = {
    kind: "observed",
    txHash: KEEPER_TX,
    launched: { initialPurchasedAmountRaw: 4_000_000_000_000_000_000_000n },
  };
  readLaunchIntent.mockReset();
});

describe("the launch is held to its approval at the last gate, on the signing node", () => {
  it("signs the pre-launch when the pinned node still agrees with the plan", async () => {
    // The allowance the approval leg wrote is what the pinned node reports by
    // the time the launch is signed.
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n };
    });
    expect(result.success, refusalText(result)).toBe(true);
    expect(signedTargets()).toEqual(["allowance", "pre_launch"]);
  });

  it("refuses a BondingV5 implementation UPGRADED while the approval was mining, and never signs the launch", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n };
      pinnedImplementations = {
        ...defaultImplementations(),
        [BASE.bondingV5.toLowerCase()]: "0x0000000000000000000000000000000000000009",
      };
    });

    expect(result.success).toBe(false);
    const out = refusalText(result);
    expect(out).toMatch(/implementation|upgraded/i);
    expect(out).toContain("Nothing was signed");
    // THE ASSERTION THIS FILE EXISTS FOR: the approval is mined and stands, and
    // the pre-launch never reached a key.
    expect(signedTargets()).toEqual(["allowance"]);
    expect(staged.map((leg) => leg.to.toLowerCase())).toContain(BASE.bondingV5.toLowerCase());
    expect(confirmLaunchWithOutputIdentity).not.toHaveBeenCalled();
  });

  it("refuses a venue LAUNCH FEE that moved between the plan and the signature", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n, calculateLaunchFee: 500_000_000_000_000_000n };
    });

    expect(result.success).toBe(false);
    expect(refusalText(result)).toContain("launch fee");
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses a BondingConfig the signing node no longer names", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedReads = {
        allowance: 10_000_000_000_000_000_000n,
        bondingConfig: getAddress("0x1111111111111111111111111111111111111122"),
      };
    });

    expect(result.success).toBe(false);
    expect(refusalText(result)).toContain("BondingConfig");
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses when the approval's allowance is not what the SIGNING node reports", async () => {
    // The approval mined somewhere the launch is not being signed. `preLaunch`
    // pulls with safeTransferFrom, so this is a certain revert, refused instead.
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 1n };
    });

    expect(result.success).toBe(false);
    expect(refusalText(result)).toContain("allowance");
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses when the wallet can no longer pay for the launch it approved", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n, balanceOf: 1n };
    });

    expect(result.success).toBe(false);
    expect(refusalText(result)).toContain("VIRTUAL");
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses when the bytes about to be signed are not the approved pre-launch", async () => {
    // The subject of a pre-sign gate must be what will be SIGNED, never what was
    // asked: a target or a calldata blob altered on the preparation path would
    // otherwise be signed under a verdict that never looked at it.
    requestMutation = (request) => ({ ...request, data: `0x${"de".repeat(40)}` });
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n };
    });

    expect(result.success).toBe(false);
    expect(refusalText(result)).toContain("not the pre-launch this execution planned");
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("terminalizes the refusal under its own named failure code", async () => {
    await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n };
      pinnedImplementations = {
        ...defaultImplementations(),
        [BASE.bondingV5.toLowerCase()]: "0x0000000000000000000000000000000000000009",
      };
    });

    expect(failActivityEvent).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ failureCode: "simulation_reverted" }),
    );
    expect(settleLaunchFailure).toHaveBeenCalledWith("int_1", "s-1", "token_launch_refused");
  });
});

/**
 * Blocker 5's half of this lane, driven through the same harness because it is
 * the same call: what the launch row RECORDS as delivered when the keeper has
 * not acted inside the bounded wait.
 */
describe("an unobserved keeper purchase is recorded as UNKNOWN, never as zero", () => {
  it("confirms the launch with the output leg absent and named as owed", async () => {
    keeperObservation = { kind: "not_observed", waitedMs: 90_000, lastReadError: null };

    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n };
    });

    expect(result.success, refusalText(result)).toBe(true);
    expect(confirmLaunchWithOutputIdentity).toHaveBeenCalledTimes(1);
    const written = definedValue(confirmLaunchWithOutputIdentity.mock.calls[0], "the confirm call")[1];
    // A `0` here reads to every consumer as a PROVEN payout of nothing: the
    // AgentScan readiness gate would treat it as settled and spend the server's
    // single `pending -> terminal` merge window on it, so the amount the keeper
    // sweep writes minutes later could never reach the feed.
    expect(written.executedAmountOutRaw).toBeNull();
    expect(written.outputPendingReason).toBe("keeper_purchase");
    expect(written.executedAmountInRaw).toBe(definedValue(written.executedAmountInRaw, "the input leg"));
  });

  it("records the keeper's proven purchase when it WAS observed inside the wait", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n };
    });

    expect(result.success, refusalText(result)).toBe(true);
    const written = definedValue(confirmLaunchWithOutputIdentity.mock.calls[0], "the confirm call")[1];
    expect(written.executedAmountOutRaw).toBe("4000000000000000000000");
    expect(written.outputPendingReason).toBeUndefined();
  });
});

describe("the signature itself happens offline", () => {
  it("hands every leg to the DEFERRED arm, so no provider call stands between the gate and the bytes", async () => {
    // viem's eager wallet action awaits one `eth_chainId` of its own after the
    // last gate (`staged-broadcast.ts:243-262`). On this lane the gate re-reads
    // launch authority, so that window must not exist at all: the deferred arm
    // signs offline with the chain id taken from preparation.
    await executeWithApprovalMining(() => {
      pinnedReads = { allowance: 10_000_000_000_000_000_000n };
    });

    expect(signerArms.length).toBeGreaterThan(0);
    expect(signerArms.every((arm) => arm === "deferred")).toBe(true);
  });
});
