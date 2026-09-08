/**
 * THE LAST GATE BEFORE THE KEY on a Virtuals curve trade.
 *
 * The defect this file reproduces (arc final review, lane 1): the execution
 * authority was established on the FALLBACK reader and BEFORE the allowance
 * legs, while the trade is prepared, signed and broadcast on the PINNED node
 * minutes later. Everything in between - a raised FFactoryV2 tax, an upgraded
 * BondingV5 or FRouterV3 proxy, a graduated agent, an expired proposal - was
 * therefore never seen, and the sell's gross floor cannot stand in for any of
 * it: the contract enforces that floor on the router's output BEFORE the
 * curve's taxes, so a raised tax takes its increase out of the wallet's net
 * with the floor intact.
 *
 * The suspension here is the real thing rather than a metaphor: the fake
 * broadcaster parks the ALLOWANCE leg on a controlled promise (that is the
 * approval mining), the test changes the pinned node's answer while it is
 * parked, and then resumes. The assertions are that the trade leg was NEVER
 * signed and that the refusal names what moved.
 *
 * `signStageBroadcast` is faked, and it is faked FAITHFULLY to the hook contract
 * it documents (`staged-broadcast.ts:325-388`): `onNonceReserved`, then
 * `onBeforeSign` as the last call before the signature, then `onHashStaged`,
 * then `onAccepted`. "Signed" in this file means "execution passed
 * `onBeforeSign`", which is exactly what the real function's ordering makes it
 * mean. The mechanism itself has its own suites; the subject here is the
 * handler's gate.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { getAddress, parseUnits, type Address, type Hex } from "viem";

import type { FailActivityEventInput } from "@vex-agent/db/repos/agent-activity.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { definedValue } from "../../../../_test-value-guards.js";
import { walletClientDouble } from "../../../../_test-evm-clients.js";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x1984edF491D3399FBc09E6d0856E01fF3721f952");
const PAIR = getAddress("0x3e11e685a056048C2dFa1c0dc1E1D0F233DbA84a");
const CREATOR = getAddress("0xD494A454888a390B2b05df74AE2B5fD9c9902B71");
const SESSION = "00000000-0000-4000-8000-000000000001";
const KEY = `0x${"11".repeat(32)}` as Hex;
const BLOCK = 50_881_730n;
const BLOCK_TIME = 1_788_530_400;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

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
// `fallbackReads` answers the pre-claim walk; `pinnedReads` answers the node
// that would broadcast. A gate that reads the fallback list cannot see anything
// only the pinned node knows.
let fallbackReads: Record<string, unknown> = {};
let pinnedReads: Record<string, unknown> = {};
let fallbackTokenInfo: readonly unknown[] = [];
let pinnedTokenInfo: readonly unknown[] = [];

function defaultTokenInfo(): readonly unknown[] {
  return [
    CREATOR, TOKEN, PAIR, "0x0000000000000000000000000000000000000000",
    {
      token: TOKEN, name: "Cult OS by Virtuals", _name: "Cult OS", ticker: "CULTOS",
      supply: 0n, price: 0n, marketCap: 0n, liquidity: 0n, volume: 0n, volume24H: 0n,
      prevPrice: 0n, lastUpdated: 0n,
    },
    "", "", "", "", "", "",
    true, false, 0n, 0n, 50_000_018_423n, true,
  ];
}

/** A read this node refuses to answer. */
const UNREADABLE = Symbol("unreadable");

function word(address: string): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

const DEFAULT_READS: Record<string, unknown> = {
  buyTax: 1n,
  sellTax: 1n,
  antiSniperBuyTaxStartValue: 99n,
  tokenAntiSniperType: 0,
  getAntiSniperDuration: 0n,
  appliesAntiSniperOnBuy: false,
  appliesAntiSniperOnSell: false,
  startTime: BigInt(BLOCK_TIME - 10_000),
  taxStartTime: BigInt(BLOCK_TIME - 9_900),
  hasAntiSniperTax: false,
  decimals: 18,
  symbol: "CULTOS",
  allowance: 0n,
  balanceOf: 10_000_000_000_000_000_000n,
  getAmountsOut: 5_646_592_476_387_574_784_133n,
};

function makeClient(
  reads: () => Record<string, unknown>,
  info: () => readonly unknown[],
  implementations: () => Record<string, string>,
  /**
   * Called for every `readContract` this node answers, BEFORE the value is
   * returned. The seam a test uses to make one specific read slow in the only
   * way that matters here: the clock moves while it is in flight.
   */
  observe: (functionName: string) => void = () => {},
) {
  return {
    async getStorageAt(args: { address: Address }) {
      return word(definedValue(implementations()[args.address.toLowerCase()], "an implementation slot"));
    },
    async getBlockNumber() {
      return BLOCK;
    },
    async getBlock() {
      return { timestamp: BigInt(BLOCK_TIME) };
    },
    async getBalance() {
      return 5_000_000_000_000_000n;
    },
    async readContract(args: { functionName: string }) {
      observe(args.functionName);
      if (args.functionName === "tokenInfo") return info();
      const value = reads()[args.functionName] ?? DEFAULT_READS[args.functionName];
      // The sentinel is what an endpoint that cannot answer looks like to this
      // lane: a throw, not a zero. `readCurveState` turns it into `tax_unreadable`.
      if (value === UNREADABLE) throw new Error(`stub: ${args.functionName} is unreadable on this node`);
      if (value === undefined) throw new Error(`stub: unmodelled read ${args.functionName}`);
      return value;
    },
  };
}

const claim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimVirtualsExecutionSnapshot: (...a: unknown[]) => claim(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: KEY }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: String(err) }),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: async () => undefined,
}));

const failActivityEvent = vi.fn(async (_id: number, _input: FailActivityEventInput) => undefined);
const confirmActivityEvent = vi.fn(async () => ({ applied: true }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: async (input: { events: readonly { eventIndex: number; eventRole: string }[] }) => ({
    executionId: 77,
    events: input.events.map((event, index) => ({ ...event, id: 100 + index })),
  }),
  createAgentActivityPreBroadcastFailure: async () => ({ executionId: 78 }),
  abortPlannedEvents: vi.fn(async () => undefined),
  confirmActivityEvent: (...a: unknown[]) => confirmActivityEvent(...(a as [])),
  failActivityEvent: (id: number, input: FailActivityEventInput) => failActivityEvent(id, input),
  markActivityBroadcast: async () => ({ applied: true }),
  markBroadcastAccepted: async () => ({ applied: true }),
  reserveActivityEvmNonce: async () => 7,
}));

vi.mock("@vex-agent/tools/protocols/virtuals/handlers/trade/fee-leg.js", () => ({
  runCurveFeeLeg: async () => ({ charged: false, reason: "not the subject of this suite" }),
}));

const fallbackClient = makeClient(
  () => fallbackReads,
  () => fallbackTokenInfo,
  () => fallbackImplementations,
);
/** Per-test observer on the PINNED node's reads. Reset in `beforeEach`. */
let pinnedReadObserver: (functionName: string) => void = () => {};
const pinnedClient = makeClient(
  () => pinnedReads,
  () => pinnedTokenInfo,
  () => pinnedImplementations,
  (functionName) => pinnedReadObserver(functionName),
);

vi.mock("@tools/virtuals/curve/evm-client.js", () => ({
  getVirtualsCurvePublicClient: () => fallbackClient,
  // The wallet client is a REAL account-bound viem client (see
  // `pinnedWalletClient` below): the leg reads its account and chain to build
  // the deferred signer that keeps the signature offline, so a bare `{}` would
  // make this suite pass by never reaching production's own identity read.
  getVirtualsCurveClients: () => ({ publicClient: pinnedClient, walletClient: pinnedWalletClient }),
}));

/** Every leg the fake was asked to send, and every leg it got past the gate. */
const staged: { to: Address; data: Hex; value: bigint }[] = [];
const signed: { to: Address; data: Hex; value: bigint }[] = [];
/** Resolved by the test when the "approval" has mined. */
let allowanceMining = deferred();
let allowanceReached = deferred();

vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: async (
    _publicClient: unknown,
    _signer: unknown,
    txParams: { to: Address; data: Hex; value: bigint },
    hooks: {
      onNonceReserved: (r: unknown) => Promise<number>;
      onHashStaged: (h: unknown) => Promise<void>;
      onAccepted: () => Promise<void>;
      onBeforeSign?: (request: unknown) => Promise<void>;
    },
  ) => {
    staged.push(txParams);
    await hooks.onNonceReserved({ fromAddress: WALLET, chainId: 8453, nodePendingNonce: 7 });
    // THE APPROVAL MINING. The trade leg never waits here; the allowance does,
    // and the test decides how long and what changes meanwhile.
    if (txParams.to.toLowerCase() !== BASE_BONDING.toLowerCase()) {
      allowanceReached.resolve();
      await allowanceMining.promise;
    }
    await hooks.onBeforeSign?.({
      to: txParams.to,
      data: txParams.data,
      value: txParams.value,
      gas: 300_000n,
      nonce: 7,
      gasPrice: undefined,
      maxFeePerGas: 1_000_000n,
      maxPriorityFeePerGas: 1_000n,
    });
    // PAST THE GATE: from here the key is used. Anything recorded below happened
    // to a signature.
    signed.push(txParams);
    await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET, nonce: 7 });
    await hooks.onAccepted();
    return {
      kind: "confirmed" as const,
      txHash: TX_HASH,
      receipt: { blockNumber: BLOCK + 2n, logs: [], status: "success" },
    };
  },
}));

const { virtualsTradeExecute } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/trade-execute.js"
);
const {
  virtualsCurveDeployment,
  applySlippageFloor,
  resolveVirtualsCurveBuyFee,
  VIRTUALS_CURVE_FEE_BPS,
  VIRTUALS_CURVE_FEE_RECEIVER_EVM,
} = await import("@tools/virtuals/curve/index.js");
const { sealVirtualsSnapshot, VIRTUALS_SNAPSHOT_VERSION } = await import(
  "@vex-agent/tools/protocols/quote-authority/virtuals.js"
);

const BASE = definedValue(virtualsCurveDeployment("base"), "the base curve deployment");
const BASE_BONDING = BASE.bondingV5;
/** The signing identity the trade leg builds its deferred signer from. */
const pinnedWalletClient = walletClientDouble(WALLET, {}, BASE.chainId);
let fallbackImplementations: Record<string, string> = {};
let pinnedImplementations: Record<string, string> = {};

function defaultImplementations(): Record<string, string> {
  return {
    [BASE.bondingV5.toLowerCase()]: BASE.implementations.bondingV5,
    [BASE.frouterV3.toLowerCase()]: BASE.implementations.frouterV3,
  };
}

const SLIPPAGE_BPS = 100;
const AMOUNT_HUMAN = "0.5";
/** What the stub router answers for this size. Kept in one place. */
const QUOTED_OUT_RAW = 5_646_592_476_387_574_784_133n;

/**
 * The snapshot the quote WOULD have sealed against the state these stubs
 * describe, built through the same pure owners the quote itself uses
 * (`resolveVirtualsCurveBuyFee`, `applySlippageFloor`) rather than from
 * hand-typed digits. The control test below is the canary: if this drifts from
 * what the handler derives, the trade that should sign refuses instead.
 */
function sealApprovedSnapshot(expiresAt: string) {
  const buyFee = resolveVirtualsCurveBuyFee({
    deployment: BASE,
    committedRaw: parseUnits(AMOUNT_HUMAN, BASE.virtualDecimals),
  });
  const quotedOutRaw = QUOTED_OUT_RAW;
  return sealVirtualsSnapshot({
    v: VIRTUALS_SNAPSHOT_VERSION,
    provider: "virtuals",
    chainId: BASE.chainId,
    side: "buy",
    token: { address: TOKEN, symbol: "CULTOS", decimals: 18 },
    virtual: { address: BASE.virtual, symbol: "VIRTUAL", decimals: BASE.virtualDecimals },
    pair: PAIR,
    bondingV5Implementation: BASE.implementations.bondingV5,
    frouterV3Implementation: BASE.implementations.frouterV3,
    totalInRaw: buyFee.committedRaw.toString(),
    curveAmountRaw: buyFee.curveAmountRaw.toString(),
    fee: {
      disposition: "charged_on_input",
      amountRaw: definedValue(buyFee.feeRaw, "the buy fee").toString(),
      receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
      bps: VIRTUALS_CURVE_FEE_BPS,
      disclosureText: buyFee.disclosure.note,
    },
    taxes: {
      protocolTaxPct: 1,
      effectiveAntiSniperPct: 0,
      antiSniperType: 0,
      acceptedAntiSniperPct: null,
    },
    quotedOutRaw: quotedOutRaw.toString(),
    contractFloorRaw: applySlippageFloor(quotedOutRaw, SLIPPAGE_BPS).toString(),
    walletNetMinRaw: null,
    slippageBps: SLIPPAGE_BPS,
    expiresAt,
  });
}

const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: SESSION,
};

function run(proposalId: string) {
  return virtualsTradeExecute(
    { chain: "base", token: TOKEN, side: "buy", amountIn: AMOUNT_HUMAN, slippageBps: SLIPPAGE_BPS, proposalId },
    CONTEXT,
  );
}

/** Start the execute, wait until the approval leg is parked, then act. */
async function executeWithApprovalMining(
  meanwhile: () => void,
): Promise<Awaited<ReturnType<typeof run>>> {
  const snapshot = sealApprovedSnapshot(new Date(Date.now() + 60_000).toISOString());
  claim.mockResolvedValue({ ok: true, snapshot, prequoteId: "p", vexFee: undefined });
  const inFlight = run(snapshot.digest);
  await allowanceReached.promise;
  meanwhile();
  allowanceMining.resolve();
  return await inFlight;
}

function refusalText(result: Awaited<ReturnType<typeof run>>): string {
  const r = result as { output?: unknown };
  return typeof r.output === "string" ? r.output : JSON.stringify(r.output);
}

/** Which legs got past the gate, by target. */
function signedTargets(): string[] {
  return signed.map((leg) => (leg.to.toLowerCase() === BASE_BONDING.toLowerCase() ? "swap" : "allowance"));
}

beforeEach(() => {
  vi.clearAllMocks();
  staged.length = 0;
  signed.length = 0;
  allowanceMining = deferred();
  allowanceReached = deferred();
  fallbackReads = {};
  pinnedReads = {};
  fallbackTokenInfo = defaultTokenInfo();
  pinnedTokenInfo = defaultTokenInfo();
  fallbackImplementations = defaultImplementations();
  pinnedImplementations = defaultImplementations();
  pinnedReadObserver = () => {};
});

describe("the trade is held to its approval at the last gate, on the signing node", () => {
  it("signs the trade when the pinned node still agrees with the approval", async () => {
    const result = await executeWithApprovalMining(() => {});
    expect(result.success, refusalText(result)).toBe(true);
    expect(signedTargets()).toEqual(["allowance", "swap"]);
  });

  it("refuses a curve tax RAISED while the approval was mining, and never signs the trade", async () => {
    // The defect: the tax was proven before the approval leg, on a different
    // node, and nothing looked again. A buy whose protocol tax went 1% -> 25%
    // reaches the curve with a quarter of the input taken by the venue.
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { buyTax: 25n };
    });
    expect(result.success).toBe(false);
    const out = refusalText(result);
    expect(out).toContain("final signing check");
    expect(out).toContain("tax setup changed");
    expect(out).toContain("Nothing was signed");
    // THE ASSERTION THIS FILE EXISTS FOR: the allowance is mined and stands, and
    // the trade never reached a key.
    expect(signedTargets()).toEqual(["allowance"]);
    expect(staged.map((leg) => leg.to.toLowerCase())).toContain(BASE_BONDING.toLowerCase());
  });

  it("refuses a proxy UPGRADED while the approval was mining", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedImplementations = {
        ...defaultImplementations(),
        [BASE.bondingV5.toLowerCase()]: "0x0000000000000000000000000000000000000009",
      };
    });
    expect(result.success).toBe(false);
    expect(refusalText(result)).toMatch(/implementation|upgraded/i);
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses an agent that GRADUATED while the approval was mining", async () => {
    const result = await executeWithApprovalMining(() => {
      const graduated = [...defaultTokenInfo()];
      graduated[12] = true;
      pinnedTokenInfo = graduated;
    });
    expect(result.success).toBe(false);
    expect(refusalText(result)).toContain("graduated");
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses when the curve can no longer reach the SEALED floor", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { getAmountsOut: 1_000n };
    });
    expect(result.success).toBe(false);
    expect(refusalText(result)).toContain("approved floor");
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses when the pinned node cannot state the taxes at all - unknown is not unchanged", async () => {
    const result = await executeWithApprovalMining(() => {
      pinnedReads = { buyTax: UNREADABLE };
    });
    expect(result.success).toBe(false);
    expect(refusalText(result)).toMatch(/could not be read|could not be asked/i);
    expect(signedTargets()).toEqual(["allowance"]);
  });

  it("refuses a proposal that EXPIRED while the approval was mining, before any chain read", async () => {
    const snapshot = sealApprovedSnapshot(new Date(Date.now() + 30_000).toISOString());
    claim.mockResolvedValue({ ok: true, snapshot, prequoteId: "p", vexFee: undefined });
    vi.useFakeTimers();
    try {
      const inFlight = run(snapshot.digest);
      await allowanceReached.promise;
      vi.setSystemTime(new Date(Date.parse(snapshot.expiresAt) + 1_000));
      allowanceMining.resolve();
      const result = await inFlight;
      expect(result.success).toBe(false);
      expect(refusalText(result)).toContain("expired");
      expect(signedTargets()).toEqual(["allowance"]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THE WINDOW THE FIRST EXPIRY CHECK CANNOT SEE.
   *
   * The gate read the clock once and then awaited the pinned node twice
   * (`readCurveState`, then `readCurveQuote`). Both of those are network round
   * trips on a node that may be slow, rate-limited or simply busy, and the
   * proposal's own deadline keeps running through them. So a quote with 30 s of
   * life left could pass the check, spend 31 s in the authority reads, and be
   * signed against a deadline that had already passed - the approval the human
   * gave was for a price valid until a moment that was gone before the bytes
   * existed.
   *
   * The clock here is advanced INSIDE the last awaited read, which is exactly
   * where the real window is, and nowhere else: the first check must still pass,
   * or this proves nothing about the second one.
   */
  it("refuses a proposal that expires DURING the final authority reads, and never signs the trade", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = sealApprovedSnapshot(new Date(Date.now() + 30_000).toISOString());
      claim.mockResolvedValue({ ok: true, snapshot, prequoteId: "p", vexFee: undefined });
      // `getAmountsOut` on the PINNED node is `readCurveQuote` - the last awaited
      // authority read before the gate returns.
      pinnedReadObserver = (functionName) => {
        if (functionName === "getAmountsOut") {
          vi.setSystemTime(new Date(Date.parse(snapshot.expiresAt) + 1_000));
        }
      };

      const inFlight = run(snapshot.digest);
      await allowanceReached.promise;
      // The clock has NOT moved yet: the gate's first expiry check passes, and
      // everything this test asserts is therefore about the second one.
      allowanceMining.resolve();
      const result = await inFlight;

      expect(result.success).toBe(false);
      const out = refusalText(result);
      expect(out).toContain("expired");
      expect(out).toContain("Nothing was signed");
      expect(signedTargets()).toEqual(["allowance"]);
      // The trade leg WAS prepared - the refusal happened at the gate, not
      // before the leg was reached, which is what makes the window real.
      expect(staged.map((leg) => leg.to.toLowerCase())).toContain(BASE_BONDING.toLowerCase());
      const call = definedValue(failActivityEvent.mock.calls.at(-1), "failActivityEvent was never called");
      expect(call[1].failureCode).toBe("deadline_expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the refused trade leg with a named durable failure, never as an unknown revert", async () => {
    await executeWithApprovalMining(() => {
      pinnedReads = { buyTax: 25n };
    });
    const call = definedValue(failActivityEvent.mock.calls.at(-1), "failActivityEvent was never called");
    expect(call[0]).toBe(101);
    expect(call[1].failureCode).toBe("simulation_reverted");
    expect(call[1].failureReason).toContain("tax setup changed");
  });
});
