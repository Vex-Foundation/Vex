import { describe, it, expect, vi, afterEach } from "vitest";
import { TRENCH_HANDLERS } from "../../../vex-agent/tools/protocols/trench/handlers.js";
import { getTrenchExpressClient } from "@tools/trench-express/client.js";
import type { TrenchToken } from "@tools/trench-express/types.js";
import type { ProtocolExecutionContext } from "../../../vex-agent/tools/protocols/types.js";
import * as walletResolve from "../../../vex-agent/tools/internal/wallet/resolve.js";
import * as curveProgress from "../../../vex-agent/tools/protocols/trench/handlers/curve-progress.js";
import * as evmClient from "@tools/evm-chains/evm-client.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

function token(over: Partial<TrenchToken> & { token: string }): TrenchToken {
  return {
    token: over.token,
    price: 1,
    supply: 1000,
    time: 1_700_000_000_000,
    creator: over.creator ?? "0xCreator",
    name: over.name ?? "Name",
    symbol: over.symbol ?? "SYM",
    description: null,
    imageCid: over.imageCid ?? null,
    links: [],
    holders: 0,
    stats24h: null,
    ruggedFlagged: over.ruggedFlagged ?? null,
    _id: null,
    graduated: over.graduated ?? false,
  } as TrenchToken;
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("trench.tokens handler", () => {
  it("rejects a structurally unsupported filter by name", async () => {
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ minHolders: 5 }, READ_CTX);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/minHolders/);
  });

  it("rejects an unknown status value", async () => {
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ status: "bogus" }, READ_CTX);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/status/);
  });

  it("applies the creator filter case-insensitively", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([
      token({ token: "0xA", creator: "0xAaA" }),
      token({ token: "0xB", creator: "0xBbB" }),
    ]);
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ creator: "0xaaa" }, READ_CTX);
    expect(res.success).toBe(true);
    const data = parse(res.output);
    expect(data.count).toBe(1);
    expect((data.tokens as Array<{ token: string }>)[0]!.token).toBe("0xA");
  });

  it("drops rug-flagged tokens by default and echoes the census", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([
      token({ token: "0xA" }),
      token({ token: "0xB", ruggedFlagged: true }),
    ]);
    const res = await TRENCH_HANDLERS["trench.tokens"]!({}, READ_CTX);
    const data = parse(res.output);
    expect(data.count).toBe(1);
    expect(data.ruggedFlaggedFiltered).toBe(1);
  });

  it("includes rug-flagged tokens when excludeRuggedFlagged is false", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([
      token({ token: "0xA" }),
      token({ token: "0xB", ruggedFlagged: true }),
    ]);
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ excludeRuggedFlagged: false }, READ_CTX);
    const data = parse(res.output);
    expect(data.count).toBe(2);
  });

  it("emits a per-filter drop census only when explainDrops is true", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xA" })]);
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ explainDrops: true }, READ_CTX);
    const data = parse(res.output);
    expect(data.drops).toBeDefined();
  });
});

// Live-probed Diamond configuration (block 24,148,658 on chain 4663):
// ethMcapThreshold = 40 ETH, per-token fakeEth = 2.5 ETH →
// graduation reserve = sqrt(40 × 2.5) − 2.5 = 7.5 ETH.
const THRESHOLD_40_ETH = 40n * 10n ** 18n;
const FAKE_ETH_2_5 = 2_500_000_000_000_000_000n;
const HALF_CURVE = 3_750_000_000_000_000_000n; // 3.75 / 7.5 ETH → 50 %
const LOW_CURVE = 750_000_000_000_000_000n; // 0.75 / 7.5 ETH → 10 %

type RowOut = { token: string; curveProgressPct?: number };

function snapshot(reads: curveProgress.FakepoolRead[], thresholdWei = THRESHOLD_40_ETH): curveProgress.CurveSnapshot {
  return { blockNumber: 24_148_658n, ethMcapThresholdWei: thresholdWei, reads };
}

function curveRead(ethReserveWei: bigint, fakeEthWei = FAKE_ETH_2_5): curveProgress.FakepoolRead {
  return { status: "success", ethReserveWei, fakeEthWei };
}

describe("trench.tokens curve-progress enrichment", () => {
  it("does NOT touch the chain when no curve-progress param is set", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xA" })]);
    const batch = vi.spyOn(curveProgress, "readCurveSnapshot");
    const res = await TRENCH_HANDLERS["trench.tokens"]!({}, READ_CTX);
    expect(res.success).toBe(true);
    expect(batch).not.toHaveBeenCalled();
    const data = parse(res.output);
    expect(data.curveProgressUnreadable).toBeUndefined();
    expect(data.curveProgressBlock).toBeUndefined();
    expect((data.tokens as RowOut[])[0]!.curveProgressPct).toBeUndefined();
  });

  it("enriches every row without filtering when includeCurveProgress is set, and echoes the pinned block", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xA" }), token({ token: "0xB" })]);
    vi.spyOn(curveProgress, "readCurveSnapshot").mockResolvedValue(
      snapshot([curveRead(HALF_CURVE), curveRead(LOW_CURVE)]),
    );
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ includeCurveProgress: true }, READ_CTX);
    const data = parse(res.output);
    expect(data.count).toBe(2);
    const rows = data.tokens as RowOut[];
    expect(rows[0]!.curveProgressPct).toBe(50);
    expect(rows[1]!.curveProgressPct).toBe(10);
    expect(data.droppedByCurveProgress).toBe(0);
    expect(data.curveProgressBlock).toBe("24148658");
  });

  it("uses each token's OWN fakeEth as its denominator, not a global one", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xA" }), token({ token: "0xB" })]);
    // 0xB is configured with fakeEth = 10 ETH → graduation = sqrt(40×10) − 10 =
    // 10 ETH, so the SAME 3.75 ETH reserve is 37.5 %, not 50 %.
    vi.spyOn(curveProgress, "readCurveSnapshot").mockResolvedValue(
      snapshot([curveRead(HALF_CURVE), curveRead(HALF_CURVE, 10n * 10n ** 18n)]),
    );
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ includeCurveProgress: true }, READ_CTX);
    const rows = parse(res.output).tokens as RowOut[];
    expect(rows[0]!.curveProgressPct).toBe(50);
    expect(rows[1]!.curveProgressPct).toBe(37.5);
  });

  it("treats a graduated token as 100 (its curve read reverts)", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xG", graduated: true })]);
    vi.spyOn(curveProgress, "readCurveSnapshot").mockResolvedValue(snapshot([{ status: "failure" }]));
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ includeCurveProgress: true }, READ_CTX);
    const data = parse(res.output);
    expect((data.tokens as RowOut[])[0]!.curveProgressPct).toBe(100);
    expect(data.curveProgressUnreadable).toBe(0);
  });

  it("filters by min/max curve progress and counts the drops", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xA" }), token({ token: "0xB" })]);
    vi.spyOn(curveProgress, "readCurveSnapshot").mockResolvedValue(
      snapshot([curveRead(HALF_CURVE), curveRead(LOW_CURVE)]),
    );
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ minCurveProgressPct: 40 }, READ_CTX);
    const data = parse(res.output);
    expect(data.count).toBe(1);
    expect((data.tokens as RowOut[])[0]!.token).toBe("0xA");
    expect(data.droppedByCurveProgress).toBe(1);
  });

  it("drops and counts a curve row whose on-chain read is unreadable", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xA" }), token({ token: "0xB" })]);
    vi.spyOn(curveProgress, "readCurveSnapshot").mockResolvedValue(
      snapshot([curveRead(HALF_CURVE), { status: "failure" }]),
    );
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ minCurveProgressPct: 0 }, READ_CTX);
    const data = parse(res.output);
    expect(data.count).toBe(1);
    expect(data.curveProgressUnreadable).toBe(1);
    expect((data.tokens as RowOut[])[0]!.token).toBe("0xA");
  });

  it("FAILS CLOSED when the authoritative threshold cannot be read — never falls back to a constant", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "walkTokens").mockResolvedValue([token({ token: "0xA" })]);
    vi.spyOn(curveProgress, "readCurveSnapshot").mockRejectedValue(
      new Error("Trench graduation threshold slot returned no data."),
    );
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ minCurveProgressPct: 40 }, READ_CTX);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/graduation threshold could not be read/i);
  });

  it("rejects an inverted band by name instead of returning an empty list", async () => {
    const res = await TRENCH_HANDLERS["trench.tokens"]!(
      { minCurveProgressPct: 80, maxCurveProgressPct: 20 },
      READ_CTX,
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/minCurveProgressPct/);
    expect(res.output).toMatch(/maxCurveProgressPct/);
  });

  it("rejects a curve-progress bound outside 0-100", async () => {
    const res = await TRENCH_HANDLERS["trench.tokens"]!({ minCurveProgressPct: 150 }, READ_CTX);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/at most 100/);
  });
});

describe("curve-progress multicall batching", () => {
  it("chunks the batch at 30 rows per multicall instead of one unbounded call", async () => {
    const calls: number[] = [];
    const fakeClient = {
      getBlockNumber: async () => 24_148_658n,
      getStorageAt: async () => `0x${THRESHOLD_40_ETH.toString(16).padStart(64, "0")}`,
      multicall: async ({ contracts }: { contracts: unknown[] }) => {
        calls.push(contracts.length);
        return contracts.map(() => ({ status: "success" as const, result: [HALF_CURVE, 0n, FAKE_ETH_2_5, 0n] }));
      },
    };
    vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue(
      fakeClient as unknown as ReturnType<typeof evmClient.getLocalPublicClient>,
    );

    // 70 tokens — the walk can return up to 600, so this must NOT be one call.
    const tokens = Array.from({ length: 70 }, (_, i) => `0x${String(i).padStart(40, "0")}` as `0x${string}`);
    const snap = await curveProgress.readCurveSnapshot(tokens);

    expect(calls).toEqual([30, 30, 10]);
    expect(calls.every((n) => n <= curveProgress.CURVE_BATCH_CHUNK)).toBe(true);
    expect(snap.reads).toHaveLength(70);
    expect(snap.blockNumber).toBe(24_148_658n);
    expect(snap.ethMcapThresholdWei).toBe(THRESHOLD_40_ETH);
  });
});

describe("trench.search handler", () => {
  it("fails without a query", async () => {
    const res = await TRENCH_HANDLERS["trench.search"]!({}, READ_CTX);
    expect(res.success).toBe(false);
  });

  it("returns projected rows for a query", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "search").mockResolvedValue([token({ token: "0xA", symbol: "VEX" })]);
    const res = await TRENCH_HANDLERS["trench.search"]!({ query: "vex" }, READ_CTX);
    const data = parse(res.output);
    expect(data.count).toBe(1);
    expect((data.tokens as Array<{ symbol: string }>)[0]!.symbol).toBe("VEX");
  });
});

describe("trench.trades handler", () => {
  it("fails without page (provider requires it)", async () => {
    const res = await TRENCH_HANDLERS["trench.trades"]!({ token: "0xA" }, READ_CTX);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/page/);
  });

  it("labels the source as provisional", async () => {
    const client = getTrenchExpressClient();
    vi.spyOn(client, "getTrades").mockResolvedValue([
      { type: 1, in: 0.1, out: 100, vol: 5, price: 0.001, tx: "0xtx", time: 1, _id: null, maker: "0xm" },
    ]);
    const res = await TRENCH_HANDLERS["trench.trades"]!({ token: "0xA", page: 0 }, READ_CTX);
    const data = parse(res.output);
    expect(data.source).toMatch(/undocumented/i);
    expect((data.trades as Array<{ side: string }>)[0]!.side).toBe("buy");
  });
});

describe("trench.launch_preview handler", () => {
  it("fails on a non-https link", async () => {
    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "T", symbol: "T", links: "http://x.com" },
      READ_CTX,
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/https/);
  });

  it("degrades to a validation-only preview when no wallet is selected", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockImplementation(() => {
      throw new Error("WALLET_NOT_SELECTED");
    });
    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT" },
      READ_CTX,
    );
    expect(res.success).toBe(true);
    const data = parse(res.output);
    expect(data.simulated).toBe(false);
    expect(data.creationFeeEth).toBe("0.001");
  });
});
