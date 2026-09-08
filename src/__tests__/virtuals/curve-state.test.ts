/**
 * The authority table read, and the two things that make it authority.
 *
 * ## 1. The `tokenInfo` member order, proven against real bytes
 *
 * `BondingV5.tokenInfo` is a Solidity AUTO-GETTER over
 * `mapping(address => BondingConfig.Token)`. Auto-getters OMIT array members, so
 * the struct's `uint8[] cores` (declared between `description` and `image`) is
 * absent from the return, and every member after it shifts by one. Getting that
 * wrong is silent: the call still decodes, `trading` reads whatever `website`
 * held, and the lane would happily trade a token BondingV5 says is closed.
 *
 * So the decode is asserted against the RAW `eth_call` return data captured live
 * from both chains on 2026-09-04
 * (`fixtures/bonding-v5-token-info.json`), not against a hand-written vector.
 *
 * ## 2. Unknown fails closed
 *
 * A tax that cannot be read cannot price a floor, and an anti-sniper window that
 * cannot be read is UNKNOWN rather than zero. Both are refused by name with a
 * bounded code. That is the whole reason `readCurveState` returns a refusal
 * union instead of a partial object.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { decodeFunctionResult, getAddress, type Address, type Hex } from "viem";

import { BONDING_V5_TOKEN_INFO_ABI } from "@tools/virtuals/curve/abi.js";
import {
  readCurveState,
  virtualsCurveDeployment,
  type CurveStateResult,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import { publicClientDouble } from "../_test-evm-clients.js";
import { definedValue } from "../_test-value-guards.js";

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/bonding-v5-token-info.json"), "utf8"),
) as {
  readonly calls: Readonly<Record<string, {
    readonly chainId: number;
    readonly bondingV5: string;
    readonly token: string;
    readonly blockNumber: string;
    readonly returnData: Hex;
  }>>;
};

function deployment(key: string): VirtualsCurveDeployment {
  const d = virtualsCurveDeployment(key);
  if (d === undefined) throw new Error(`no Virtuals curve deployment for ${key}`);
  return d;
}

/** The member order this lane depends on, by index into the decoded tuple. */
const MEMBER_INDEX = {
  creator: 0,
  token: 1,
  pair: 2,
  agentToken: 3,
  data: 4,
  description: 5,
  image: 6,
  twitter: 7,
  telegram: 8,
  youtube: 9,
  website: 10,
  trading: 11,
  tradingOnUniswap: 12,
  applicationId: 13,
  initialPurchase: 14,
  virtualId: 15,
  launchExecuted: 16,
} as const;

describe("the tokenInfo auto-getter shape, decoded from real chain bytes", () => {
  it.each(Object.keys(FIXTURE.calls))("decodes the live %s response into 17 members", (key) => {
    const call = definedValue(FIXTURE.calls[key], `the captured ${key} tokenInfo response`);
    const decoded = decodeFunctionResult({
      abi: BONDING_V5_TOKEN_INFO_ABI,
      functionName: "tokenInfo",
      data: call.returnData,
    }) as readonly unknown[];
    // 18 struct members minus the omitted `uint8[] cores`.
    expect(decoded).toHaveLength(17);
  });

  it.each(Object.keys(FIXTURE.calls))("puts %s's real values at the indices this lane reads", (key) => {
    const call = definedValue(FIXTURE.calls[key], `the captured ${key} tokenInfo response`);
    const d = decodeFunctionResult({
      abi: BONDING_V5_TOKEN_INFO_ABI,
      functionName: "tokenInfo",
      data: call.returnData,
    }) as readonly unknown[];

    // `token` at index 1 must echo the address the call asked about. This is the
    // single strongest self-check the response carries: if `cores` had not been
    // omitted, or a member were mis-declared, this equality would break.
    expect(getAddress(d[MEMBER_INDEX.token] as Address)).toBe(getAddress(call.token));

    // The lifecycle flags this lane gates on are BOOLEANS at 11 and 12, not
    // strings that happened to decode.
    expect(typeof d[MEMBER_INDEX.trading]).toBe("boolean");
    expect(typeof d[MEMBER_INDEX.tradingOnUniswap]).toBe("boolean");
    expect(typeof d[MEMBER_INDEX.launchExecuted]).toBe("boolean");

    // Both fixture agents were live on their curve when captured.
    expect(d[MEMBER_INDEX.trading]).toBe(true);
    expect(d[MEMBER_INDEX.tradingOnUniswap]).toBe(false);
    expect(d[MEMBER_INDEX.launchExecuted]).toBe(true);

    // The pair is a real address, not the zero address that means "no curve".
    const pair = getAddress(d[MEMBER_INDEX.pair] as Address);
    expect(pair).not.toBe("0x0000000000000000000000000000000000000000");
    expect(getAddress(d[MEMBER_INDEX.creator] as Address)).not.toBe(pair);

    // `data.name` is the display name and `data.ticker` the symbol; the lane
    // binds the NAME, and a swap of the two would show the symbol twice.
    const data = d[MEMBER_INDEX.data] as { name: string; ticker: string };
    expect(data.ticker.length).toBeGreaterThan(0);
    expect(data.name.length).toBeGreaterThan(0);
    expect(data.name).not.toBe(data.ticker);
    // Both live agents are named "<something> by Virtuals", which is exactly the
    // string a person should see beside the symbol on an approval card.
    expect(data.name).toContain("by Virtuals");

    expect(typeof (d[MEMBER_INDEX.virtualId] as bigint)).toBe("bigint");
  });
});

// -- readCurveState -------------------------------------------------------

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x1984edF491D3399FBc09E6d0856E01fF3721f952");
const PAIR = getAddress("0x3e11e685a056048C2dFa1c0dc1E1D0F233DbA84a");
const CREATOR = getAddress("0xD494A454888a390B2b05df74AE2B5fD9c9902B71");
const BLOCK = 50_881_730n;
const BLOCK_TIME = 1_788_530_400;

interface Overrides {
  readonly tokenInfo?: readonly unknown[];
  /** Contract calls that should throw, keyed by function name. */
  readonly throwOn?: readonly string[];
  readonly implementations?: Readonly<Record<string, Hex | undefined>>;
  readonly reads?: Readonly<Record<string, unknown>>;
  /** Observes every contract read the lane makes, in call order. */
  readonly onRead?: (args: StubReadArgs) => void;
}

/** The subset of viem's `readContract` argument this stub decides on. */
interface StubReadArgs {
  readonly address: string;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

function liveTokenInfo(): readonly unknown[] {
  return [
    CREATOR, TOKEN, PAIR, "0x0000000000000000000000000000000000000000",
    { token: TOKEN, name: "Cult OS by Virtuals", _name: "Cult OS", ticker: "CULTOS", supply: 0n, price: 0n, marketCap: 0n, liquidity: 0n, volume: 0n, volume24H: 0n, prevPrice: 0n, lastUpdated: 0n },
    "", "", "", "", "", "",
    true, false, 0n, 0n, 50_000_018_423n, true,
  ];
}

function word(address: string): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

/**
 * A REAL viem public client with this lane's reads scripted on top of it
 * (`publicClientDouble`). It answers ONLY the calls this lane makes: a new read
 * added to `readCurveState` without a decision about its failure mode throws
 * `unmodelled read` here rather than silently passing, and any OTHER client
 * method the lane grows reaches viem's own implementation over a transport that
 * refuses by name.
 */
function stubClient(d: VirtualsCurveDeployment, o: Overrides = {}) {
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
    balanceOf: 42n,
  };
  const impl = o.implementations ?? {
    [d.bondingV5.toLowerCase()]: word(d.implementations.bondingV5),
    [d.frouterV3.toLowerCase()]: word(d.implementations.frouterV3),
  };
  return publicClientDouble({
    async getStorageAt(args: { address: Address }) {
      return impl[args.address.toLowerCase()];
    },
    async getBlockNumber() {
      return BLOCK;
    },
    async getBlock() {
      return { timestamp: BigInt(BLOCK_TIME) };
    },
    async getBalance() {
      return 5_106_838_744_005_253n;
    },
    async readContract(args: StubReadArgs) {
      o.onRead?.(args);
      if ((o.throwOn ?? []).includes(args.functionName)) {
        throw new Error(`stub: ${args.functionName} reverted`);
      }
      if (args.functionName === "tokenInfo") return o.tokenInfo ?? liveTokenInfo();
      const overridden = o.reads?.[args.functionName];
      if (overridden !== undefined) return overridden;
      const value = defaults[args.functionName];
      if (value === undefined) throw new Error(`stub: unmodelled read ${args.functionName}`);
      return value;
    },
  });
}

async function read(o: Overrides = {}, side: "buy" | "sell" = "buy"): Promise<CurveStateResult> {
  const d = deployment("base");
  return await readCurveState({ client: stubClient(d, o), deployment: d, token: TOKEN, side, wallet: WALLET });
}

describe("readCurveState pins one block and reports the chain's own answers", () => {
  it("returns the whole authority table at one block", async () => {
    const state = await read();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.blockNumber).toBe(BLOCK);
    expect(state.blockTimestampSeconds).toBe(BLOCK_TIME);
    expect(state.token).toBe(TOKEN);
    expect(state.pair).toBe(PAIR);
    expect(state.creator).toBe(CREATOR);
    expect(state.virtualId).toBe("50000018423");
    expect(state.buyTaxPct).toBe(1);
    expect(state.sellTaxPct).toBe(1);
    expect(state.implementations).toEqual({
      bondingV5: getAddress(deployment("base").implementations.bondingV5),
      frouterV3: getAddress(deployment("base").implementations.frouterV3),
    });
  });

  it("binds the DISPLAY NAME, not the ticker, so the card does not show the symbol twice", async () => {
    const state = await read();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.tokenName).toBe("Cult OS by Virtuals");
    expect(state.tokenSymbol).toBe("CULTOS");
    expect(state.tokenName).not.toBe(state.tokenSymbol);
  });

  it("reads the allowance of the token the SIDE spends, against FRouterV3", async () => {
    const d = deployment("base");
    const seen: StubReadArgs[] = [];
    const client = stubClient(d, { onRead: (a) => seen.push(a) });

    await readCurveState({ client, deployment: d, token: TOKEN, side: "buy", wallet: WALLET });
    const allowance = seen.find((s) => s.functionName === "allowance");
    expect(allowance?.address).toBe(d.virtual);
    expect(allowance?.args).toEqual([WALLET, d.frouterV3]);

    seen.length = 0;
    await readCurveState({ client, deployment: d, token: TOKEN, side: "sell", wallet: WALLET });
    // A SELL spends the agent token, so that is the allowance that matters.
    expect(seen.find((s) => s.functionName === "allowance")?.address).toBe(TOKEN);
  });
});

describe("readCurveState refuses by name rather than guessing", () => {
  it("refuses when an implementation moved, before it reads anything else", async () => {
    const d = deployment("base");
    const state = await read({
      implementations: {
        [d.bondingV5.toLowerCase()]: word("0x00000000000000000000000000000000DEadBEEF"),
        [d.frouterV3.toLowerCase()]: word(d.implementations.frouterV3),
      },
    });
    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.code).toBe("implementation_moved");
  });

  it("names a token BondingV5 never launched as NOT A CURVE TOKEN, not as graduated", async () => {
    const zeroed = [...liveTokenInfo()];
    zeroed[MEMBER_INDEX.pair] = "0x0000000000000000000000000000000000000000";
    zeroed[MEMBER_INDEX.launchExecuted] = false;
    const state = await read({ tokenInfo: zeroed });
    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.code).toBe("not_a_curve_token");
  });

  it("reports a GRADUATED agent with its pool, so the caller can hand off", async () => {
    const graduated = [...liveTokenInfo()];
    graduated[MEMBER_INDEX.tradingOnUniswap] = true;
    const state = await read({ tokenInfo: graduated });
    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.code).toBe("graduated");
    expect(state.graduatedPair).toBe(PAIR);
  });

  it("distinguishes trading DISABLED from graduated", async () => {
    const closed = [...liveTokenInfo()];
    closed[MEMBER_INDEX.trading] = false;
    const state = await read({ tokenInfo: closed });
    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.code).toBe("not_trading");
  });

  it.each(["buyTax", "sellTax"])("refuses an unreadable %s rather than pricing a floor at zero", async (fn) => {
    const state = await read({ throwOn: [fn] });
    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.code).toBe("tax_unreadable");
    expect(state.reason).toContain("unknown tax cannot price a floor");
  });

  it.each(["tokenAntiSniperType", "getAntiSniperDuration", "antiSniperBuyTaxStartValue", "startTime"])(
    "treats an unreadable %s as UNKNOWN, not as zero",
    async (fn) => {
      const state = await read({ throwOn: [fn] });
      expect(state.ok).toBe(false);
      if (state.ok) return;
      expect(state.code).toBe("anti_sniper_unreadable");
      expect(state.reason).toContain("UNKNOWN, not zero");
    },
  );

  it("does NOT treat a missing taxStartTime as a failure - the router falls back to startTime", async () => {
    // `FRouterV3._getTaxStartTime` try/catches this very call for old pairs.
    const state = await read({ throwOn: ["taxStartTime"] });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.antiSniper.clockSource).toBe("startTime");
    expect(state.antiSniper.taxStartTimeSeconds).toBe(BLOCK_TIME - 10_000);
  });

  it("prefers taxStartTime when the pair set one", async () => {
    const state = await read();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.antiSniper.clockSource).toBe("taxStartTime");
    expect(state.antiSniper.taxStartTimeSeconds).toBe(BLOCK_TIME - 9_900);
  });
});

describe("the anti-sniper window is evaluated on the BLOCK's clock", () => {
  it("reports the decayed percent on the side the type taxes, and zero on the other", async () => {
    const state = await read({
      reads: {
        tokenAntiSniperType: 1,
        getAntiSniperDuration: 100n,
        appliesAntiSniperOnBuy: true,
        appliesAntiSniperOnSell: false,
        // 40 seconds into a 100-second window: 99 * 60 / 100 = 59.
        taxStartTime: BigInt(BLOCK_TIME - 40),
        hasAntiSniperTax: true,
      },
    });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.antiSniper.rawBuyPct).toBe(59);
    expect(state.antiSniper.rawSellPct).toBe(0);
    expect(state.antiSniper.remainingSeconds).toBe(60);
    expect(state.antiSniper.activeOnChain).toBe(true);
  });

  it("reports the FULL start tax before trading has started, which no API row can model", async () => {
    const state = await read({
      reads: {
        tokenAntiSniperType: 1,
        getAntiSniperDuration: 100n,
        appliesAntiSniperOnBuy: true,
        taxStartTime: BigInt(BLOCK_TIME + 500),
      },
    });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.antiSniper.rawBuyPct).toBe(99);
  });
});
