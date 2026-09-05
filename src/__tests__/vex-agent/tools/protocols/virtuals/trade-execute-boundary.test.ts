/**
 * The execute handler's BOUNDARY: everything it refuses, and the one mode that
 * deliberately stops at the edge of signing.
 *
 * The ordering under test is the safety property. `virtuals.trade.execute`
 * acquires authority in exactly this order, and each step exists to make a later
 * one unreachable:
 *
 *   forbidden params -> slippage policy -> chain -> wallet ADDRESS (never a key)
 *   -> [simulateOnly stops here] -> CLAIM the approved quote -> re-read the
 *   chain -> re-price -> hold the sealed snapshot -> resolve the KEY -> sign.
 *
 * The two facts this file is really about:
 *
 *  1. NOTHING before the claim opens a signing key or writes a durable row, so
 *     a caller who fumbles a parameter cannot consume their own approved quote.
 *  2. `simulateOnly` runs BEFORE the claim on purpose. A simulation that
 *     consumed the quote would turn an inspection into a denial of the very
 *     trade being inspected.
 *
 * `claimVirtualsExecutionSnapshot` is mocked so a refusal that should never
 * reach it is proven by the mock NOT being called - the assertion that a fumbled
 * parameter cost the caller nothing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { definedValue } from "../../../../_test-value-guards.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = getAddress("0x1984edF491D3399FBc09E6d0856E01fF3721f952");
const PAIR = getAddress("0x3e11e685a056048C2dFa1c0dc1E1D0F233DbA84a");
const CREATOR = getAddress("0xD494A454888a390B2b05df74AE2B5fD9c9902B71");
const SESSION = "00000000-0000-4000-8000-000000000001";
const BLOCK = 50_881_730n;
const BLOCK_TIME = 1_788_530_400;

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => {
    throw new Error("the boundary tests must never reach a signing key");
  },
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: String(err) }),
}));

const claim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimVirtualsExecutionSnapshot: (...a: unknown[]) => claim(...a),
}));

const createAgentActivityIntent = vi.fn(async () => {
  throw new Error("the boundary tests must never write an execution intent");
});
const createAgentActivityPreBroadcastFailure = vi.fn(async () => ({ executionId: 1 }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...a: unknown[]) => createAgentActivityIntent(...(a as [])),
  createAgentActivityPreBroadcastFailure: (...a: unknown[]) => createAgentActivityPreBroadcastFailure(...(a as [])),
  abortPlannedEvents: vi.fn(),
  confirmActivityEvent: vi.fn(),
  failActivityEvent: vi.fn(),
  markActivityBroadcast: vi.fn(),
  markBroadcastAccepted: vi.fn(),
  reserveActivityEvmNonce: vi.fn(),
}));

/** Typed like viem's `call`, so a mock implementation can read its argument. */
const ethCall = vi.fn(async (_args: { to: string; data: Hex; value: bigint; account: string }) => ({
  data: "0x" as Hex,
}));
vi.mock("@tools/virtuals/curve/evm-client.js", () => ({
  getVirtualsCurvePublicClient: () => publicClient,
  getVirtualsCurveClients: () => {
    throw new Error("the boundary tests must never build a wallet client");
  },
}));

const { virtualsTradeExecute } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/trade-execute.js"
);
const { virtualsCurveDeployment } = await import("@tools/virtuals/curve/index.js");

const BASE = definedValue(virtualsCurveDeployment("base"), "the base curve deployment");

function word(address: string): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

/** State overrides for the one stub client every call in this file shares. */
let stateReads: Record<string, unknown> = {};
let tokenInfo: readonly unknown[] = [];

function defaultTokenInfo(): readonly unknown[] {
  return [
    CREATOR, TOKEN, PAIR, "0x0000000000000000000000000000000000000000",
    { token: TOKEN, name: "Cult OS by Virtuals", _name: "Cult OS", ticker: "CULTOS", supply: 0n, price: 0n, marketCap: 0n, liquidity: 0n, volume: 0n, volume24H: 0n, prevPrice: 0n, lastUpdated: 0n },
    "", "", "", "", "", "",
    true, false, 0n, 0n, 50_000_018_423n, true,
  ];
}

const publicClient = {
  async getStorageAt(args: { address: Address }) {
    const impl: Record<string, Hex> = {
      [BASE.bondingV5.toLowerCase()]: word(BASE.implementations.bondingV5),
      [BASE.frouterV3.toLowerCase()]: word(BASE.implementations.frouterV3),
    };
    return impl[args.address.toLowerCase()];
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
  call: (args: Parameters<typeof ethCall>[0]) => ethCall(args),
  async readContract(args: { functionName: string }) {
    if (args.functionName === "tokenInfo") return tokenInfo;
    const defaults: Record<string, unknown> = {
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
    const value = stateReads[args.functionName] ?? defaults[args.functionName];
    if (value === undefined) throw new Error(`stub: unmodelled read ${args.functionName}`);
    return value;
  },
};

const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: SESSION,
};

function params(over: Record<string, unknown> = {}) {
  return { chain: "base", token: TOKEN, side: "buy", amountIn: "0.5", proposalId: "deadbeef", ...over };
}

function run(over: Record<string, unknown> = {}) {
  return virtualsTradeExecute(params(over), CONTEXT);
}

function refusal(result: Awaited<ReturnType<typeof run>>): string {
  const r = result as { success?: boolean; output?: unknown; error?: unknown };
  expect(r.success, "expected a refusal, got a success").toBe(false);
  return typeof r.output === "string" ? r.output : String(r.error ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  stateReads = {};
  tokenInfo = defaultTokenInfo();
  claim.mockResolvedValue({ ok: false, refusal: { message: "no approved quote" } });
  ethCall.mockResolvedValue({ data: "0x" });
});

describe("nothing a fumbled parameter can do costs the caller their approved quote", () => {
  it.each(["fee", "feeBps", "feeReceiver", "feeRecipient", "feeAmount", "vexFee", "vexFeeBps", "vexFeeReceiver"])(
    "rejects a caller-supplied %s BY NAME, before the claim",
    async (key) => {
      const out = refusal(await run({ [key]: 1 }));
      expect(out).toContain(key);
      expect(out).toContain("fixed product constants");
      expect(claim).not.toHaveBeenCalled();
    },
  );

  it("treats PRESENCE as the violation, whatever the key carries", async () => {
    for (const value of [undefined, null, "", 0]) {
      expect(refusal(await run({ feeReceiver: value }))).toContain("feeReceiver");
    }
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses a slippage above Vex's cap rather than clamping it, before the claim", async () => {
    const out = refusal(await run({ slippageBps: 1001 }));
    expect(out).toContain("slippageBps");
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses dryRun BY NAME and points at the mode this tool actually has", async () => {
    // The manifest declares no `dryRun`. A caller that passes it anyway must not
    // reach a real broadcast because some preview matrix treated the call as a
    // preview - `simulateOnly` is the declared no-signing mode and the only one.
    const out = refusal(await run({ dryRun: true }));
    expect(out).toContain("dryRun");
    expect(out).toContain("simulateOnly");
    expect(claim).not.toHaveBeenCalled();
  });

  it("answers a Solana request with the tool that CAN trade it, not with an error", async () => {
    const result = await run({ chain: "solana" });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.executed).toBe(false);
    expect(data.supported).toBe(false);
    expect(String(data.useInstead)).toContain("solana__swap");
    expect(String(data.reason)).toContain("Meteora");
    expect(claim).not.toHaveBeenCalled();
  });

  it("says Ethereum has no curve at all and names nothing that could trade one", async () => {
    const data = (await run({ chain: "ethereum" })).data as Record<string, unknown>;
    expect(data.supported).toBe(false);
    expect(data.useInstead).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it("requires an active session before it claims anything", async () => {
    const out = refusal(await virtualsTradeExecute(params(), { ...CONTEXT, sessionId: undefined }));
    expect(out).toContain("active session");
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("the proposalId binds the execute to the quote that priced it", () => {
  const snapshot = {
    digest: "a".repeat(64),
    contractFloorRaw: "1",
    slippageBps: 100,
  };

  it("refuses a MISSING proposalId BEFORE the claim, so the mistake costs no quote", async () => {
    // The manifest cannot mark it required (simulateOnly must work without one),
    // so the handler owns the conditional rule - and it must sit ahead of the
    // claim like every other parameter refusal, or a forgotten parameter would
    // burn the caller's approved quote.
    claim.mockResolvedValue({ ok: true, snapshot, prequoteId: "p", vexFee: undefined });
    const out = refusal(await run({ proposalId: undefined }));
    expect(out).toContain("requires the proposalId");
    expect(out).toContain("virtuals__agent_trade_quote");
    expect(out).toContain("simulateOnly");
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses a proposalId that is not the claimed quote's digest", async () => {
    claim.mockResolvedValue({ ok: true, snapshot, prequoteId: "p", vexFee: undefined });
    const out = refusal(await run({ proposalId: "b".repeat(64) }));
    expect(out).toContain("does not match");
    expect(out).toContain("Nothing was");
  });

  it("surfaces the claim's own refusal when there is no fresh quote to claim", async () => {
    claim.mockResolvedValue({ ok: false, refusal: { message: "quote expired" } });
    expect(refusal(await run())).toContain("quote expired");
    expect(createAgentActivityIntent).not.toHaveBeenCalled();
  });
});

describe("simulateOnly stops at the edge of signing", () => {
  async function simulate(over: Record<string, unknown> = {}) {
    return await run({ simulateOnly: true, proposalId: undefined, ...over });
  }

  it("consumes NO quote, opens NO key and writes NO row", async () => {
    const result = await simulate();
    expect(result.success).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(createAgentActivityIntent).not.toHaveBeenCalled();
    const data = result.data as Record<string, unknown>;
    expect(data.executed).toBe(false);
    expect(data.simulateOnly).toBe(true);
    // BOTH null, and the pair travels together: a simulation seals no snapshot,
    // so it authorizes nothing and has nothing to expire. Stamping `expiresAt`
    // with "now" would render as an already-expired proposal, which is a fact
    // about the trade that is not true.
    expect(data.proposalId).toBeNull();
    expect(data.expiresAt).toBeNull();
  });

  it("returns the EXACT transactions the signing path would carry", async () => {
    const data = (await simulate()).data as Record<string, unknown>;
    const sends = data.wouldSend as { role: string; to: string; data: string; value: string; ok: boolean }[];
    // Allowance is zero in the stub, so a buy needs one approval and no reset.
    expect(sends.map((s) => s.role)).toEqual(["allowance", "swap"]);
    expect(getAddress(definedValue(sends[0], "the allowance leg").to)).toBe(getAddress(BASE.virtual));
    expect(getAddress(definedValue(sends[1], "the swap leg").to)).toBe(getAddress(BASE.bondingV5));
    for (const send of sends) expect(send.value).toBe("0");
  });

  it("eth_calls each of them FROM the session wallet address", async () => {
    await simulate();
    expect(ethCall).toHaveBeenCalledTimes(2);
    for (const [args] of ethCall.mock.calls) {
      expect(getAddress(args.account)).toBe(getAddress(WALLET));
    }
  });

  it("REPORTS a leg that reverts rather than hiding it", async () => {
    ethCall.mockImplementation(async (args) => {
      if (args.to.toLowerCase() === BASE.bondingV5.toLowerCase()) {
        throw new Error("execution reverted: SlippageTooHigh");
      }
      return { data: "0x" as Hex };
    });
    const data = (await simulate()).data as Record<string, unknown>;
    const sends = data.wouldSend as { role: string; ok: boolean; revertReason?: string }[];
    expect(sends.find((s) => s.role === "swap")?.ok).toBe(false);
    expect(sends.find((s) => s.role === "swap")?.revertReason).toBeTruthy();
    expect(String(data.simulateNote)).toContain("reverts here by construction");
  });

  it("plans a reset leg when a non-zero allowance is short", async () => {
    stateReads = { allowance: 1n };
    const data = (await simulate()).data as Record<string, unknown>;
    const sends = data.wouldSend as { role: string }[];
    expect(sends.map((s) => s.role)).toEqual(["allowance_reset", "allowance", "swap"]);
  });

  it("plans NO allowance leg when the wallet already allows enough", async () => {
    stateReads = { allowance: 10_000_000_000_000_000_000n };
    const data = (await simulate()).data as Record<string, unknown>;
    expect((data.wouldSend as { role: string }[]).map((s) => s.role)).toEqual(["swap"]);
  });

  it("still refuses a graduated agent - a simulation must not model an impossible trade", async () => {
    const graduated = [...defaultTokenInfo()];
    graduated[12] = true;
    tokenInfo = graduated;
    expect(refusal(await simulate())).toContain("graduated");
  });

  it("still refuses an ACTIVE anti-sniper window the caller accepted nothing for", async () => {
    stateReads = {
      tokenAntiSniperType: 1,
      getAntiSniperDuration: 100n,
      appliesAntiSniperOnBuy: true,
      taxStartTime: BigInt(BLOCK_TIME - 40),
    };
    const out = refusal(await simulate());
    expect(out).toContain("anti-sniper window is ACTIVE");
    expect(out).toContain("acceptAntiSniperTaxPct");
  });

  it("proceeds once the caller states a bound the window is inside", async () => {
    stateReads = {
      tokenAntiSniperType: 1,
      getAntiSniperDuration: 100n,
      appliesAntiSniperOnBuy: true,
      taxStartTime: BigInt(BLOCK_TIME - 40),
    };
    // 99 * 60 / 100 = 59 percent right now.
    const result = await simulate({ acceptAntiSniperTaxPct: 60 });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const curveTax = data.curveTax as { antiSniper: { effectivePct: number; acceptedBoundPct: number } };
    expect(curveTax.antiSniper.effectivePct).toBe(59);
    expect(curveTax.antiSniper.acceptedBoundPct).toBe(60);
  });

  it("refuses a bound BELOW the current percent, naming both", async () => {
    stateReads = {
      tokenAntiSniperType: 1,
      getAntiSniperDuration: 100n,
      appliesAntiSniperOnBuy: true,
      taxStartTime: BigInt(BLOCK_TIME - 40),
    };
    const out = refusal(await simulate({ acceptAntiSniperTaxPct: 10 }));
    expect(out).toContain("59%");
    expect(out).toContain("10%");
  });
});
