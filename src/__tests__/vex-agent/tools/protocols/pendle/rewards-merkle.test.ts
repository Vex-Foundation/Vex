/**
 * `pendle.rewards.merkle` — merkle-distributed rewards the agent could not see.
 *
 * The product fact this tool must never blur: Pendle's public endpoint carries
 * NO merkle proof and NO verify calldata (G-10, settled by a live probe against
 * a wallet holding seven pending rewards), so Vex cannot build a claim
 * transaction from it at any point in the future. The honesty sentence is
 * therefore part of the contract and is asserted verbatim — an agent that reads
 * a claimable balance and infers a claim tool exists would loop forever.
 *
 * The second contract is privacy: the wallet is the session's selected one,
 * resolved exactly as `pendle.position.value` resolves it. A wallet address
 * supplied in the params must never be honoured — that would turn a portfolio
 * read into a third-party balance probe (rules/06).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { ErrorCodes, VexError } from "../../../../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockGetMerkleRewards = vi.fn();
const mockGetAssetPrices = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({
    getMerkleRewards: (...a: unknown[]) => mockGetMerkleRewards(...a),
    getAssetPrices: (...a: unknown[]) => mockGetAssetPrices(...a),
  }),
}));

const mockResolveSelectedAddress = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...a: unknown[]) => mockResolveSelectedAddress(...a),
}));

const { validatePendleMerkleRewards } = await import("@tools/pendle/read/validation/merkle-rewards.js");
const { validatePendleAssetPrices } = await import("@tools/pendle/read/validation/price-series.js");
const { PENDLE_READ_NO_ASSET_FACTS } = await import("@vex-agent/tools/protocols/pendle/asset-decimals.js");
const { pendleRewardsMerkle } = await import("@vex-agent/tools/protocols/pendle/handlers/rewards-merkle.js");
const { PENDLE_MERKLE_REWARDS, PENDLE_MERKLE_FIXTURE_WALLET } = await import("./read-surface-fixtures.js");

const PENDLE_TOKEN = "0x808507121b80c02388fad14726482e061b8da827";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const liveRewards = validatePendleMerkleRewards(PENDLE_MERKLE_REWARDS);

/** Only the PENDLE reward token is priced, so the unpriced path is exercised too. */
const livePrices = validatePendleAssetPrices({ prices: { [`1-${PENDLE_TOKEN}`]: 1 }, total: 1, skip: 0 });
const PENDLE_FACTS = new Map([[PENDLE_TOKEN, { symbol: "PENDLE", decimals: 6 }]]);

/** A real execution context — the handler only reads its wallet resolution + policy. */
const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: {
    source: "session",
    evm: { id: "wallet-1", address: PENDLE_MERKLE_FIXTURE_WALLET },
    solana: null,
  },
  walletPolicy: { kind: "none" },
};

/**
 * A merkle-rewards body in the LIVE shape, driven through the real validator.
 *
 * The key set is exactly what the endpoint returns (`user`, `merkleRoot` and
 * `assetId` included, because the validator's job of dropping them is part of
 * what these rows exercise); only the chain/token/amount vary per case.
 */
function merkleRewards(rows: ReadonlyArray<{ chainId: number; token: string; amount: string }>): unknown {
  return validatePendleMerkleRewards({
    claimableRewards: rows.map((row) => ({
      user: PENDLE_MERKLE_FIXTURE_WALLET,
      token: row.token,
      merkleRoot: "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
      chainId: row.chainId,
      assetId: `${row.chainId}-0xfce3f966a131c46a51b896ceea3917bc4c302577`,
      amount: row.amount,
      toTimestamp: "2026-07-24T00:00:00.000Z",
      fromTimestamp: "2026-07-16T00:00:00.000Z",
    })),
    claimedRewards: [],
  });
}

function output(result: { success: boolean; data?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.success || result.data === undefined) {
    throw new Error(`expected a successful read, got: ${JSON.stringify(result)}`);
  }
  return result.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSelectedAddress.mockReturnValue(PENDLE_MERKLE_FIXTURE_WALLET);
  mockGetMerkleRewards.mockResolvedValue(liveRewards);
  mockGetAssetPrices.mockResolvedValue(livePrices);
});

describe("pendle.rewards.merkle", () => {
  it("carries the cannot-claim sentence verbatim on every answer", async () => {
    const data = output(await pendleRewardsMerkle({}, CONTEXT, PENDLE_READ_NO_ASSET_FACTS, NOW));
    expect(data.note).toBe(
      "Pendle's public API does not publish the merkle proof, so Vex cannot execute this claim. Claim at app.pendle.finance.",
    );
    expect(String(data.nextStep)).toContain("app.pendle.finance");
  });

  it("reads the SESSION wallet and ignores any address supplied in the params", async () => {
    const data = output(
      await pendleRewardsMerkle(
        { wallet: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" },
        CONTEXT,
        PENDLE_READ_NO_ASSET_FACTS,
        NOW,
      ),
    );
    expect(mockResolveSelectedAddress).toHaveBeenCalledWith(CONTEXT.walletResolution, CONTEXT.walletPolicy, "eip155");
    expect(mockGetMerkleRewards).toHaveBeenCalledWith(PENDLE_MERKLE_FIXTURE_WALLET);
    expect(data.wallet).toBe(PENDLE_MERKLE_FIXTURE_WALLET);
  });

  it("ships an unpriceable amount raw and FLAGGED rather than at assumed decimals", async () => {
    const data = output(await pendleRewardsMerkle({}, CONTEXT, PENDLE_READ_NO_ASSET_FACTS, NOW));
    const rows = data.claimable as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(7);
    expect(rows[0]?.amount).toEqual({ raw: "21629940315250", decimals: null, exact: null, unreadable: true });
    expect(rows[0]?.valueUsd).toBeNull();
    expect(data.totalClaimableUsd).toBeNull();
    expect(String(data.amountsNote)).toMatch(/raw base units/i);
  });

  it("values only the rows it can, and says how many it could not", async () => {
    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(PENDLE_FACTS), NOW));
    const rows = data.claimable as Array<Record<string, unknown>>;
    const priced = rows.filter((r) => r.valueUsd !== null);

    expect(priced).toHaveLength(2);
    expect(priced[0]?.amount).toEqual({ raw: "792685546250", decimals: 6, exact: "792685.54625" });
    expect(priced[0]?.valueUsd).toBe("792685.54625");
    expect(data.totalClaimableUsd).toBe("3022297.684258");
    expect(data.pricedRows).toBe(2);
    expect(data.unpricedRows).toBe(5);
    expect(String(data.totalNote)).toMatch(/5/);
  });

  it("reports the accrual window and the reward token identity per row", async () => {
    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(PENDLE_FACTS), NOW));
    const rows = data.claimable as Array<Record<string, unknown>>;
    const pendleRow = rows.find((r) => (r.token as { address: string }).address === PENDLE_TOKEN);

    expect(pendleRow?.token).toEqual({ address: PENDLE_TOKEN, symbol: "PENDLE", decimals: 6 });
    expect(pendleRow?.chain).toBe("ethereum");
    expect(pendleRow?.window).toEqual({ from: "2026-07-16T00:00:00.000Z", to: "2026-07-24T00:00:00.000Z" });
  });

  it("filters to one chain and asks the price endpoint only about that chain", async () => {
    const data = output(await pendleRewardsMerkle({ chain: "arbitrum" }, CONTEXT, PENDLE_READ_NO_ASSET_FACTS, NOW));
    expect(data.claimable).toHaveLength(0);
    expect(data.chainFilter).toBe("arbitrum");
    expect(mockGetAssetPrices).not.toHaveBeenCalled();
    expect(String(data.summary)).toContain("arbitrum");
  });

  it("reports an empty claimed list as an empty list, never as absent data", async () => {
    const data = output(await pendleRewardsMerkle({}, CONTEXT, PENDLE_READ_NO_ASSET_FACTS, NOW));
    expect(data.claimed).toEqual([]);
    expect(data.claimedCount).toBe(0);
  });

  it("still answers when the price read fails, naming the degradation", async () => {
    mockGetAssetPrices.mockRejectedValue(new VexError(ErrorCodes.PENDLE_API_ERROR, "upstream"));
    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(PENDLE_FACTS), NOW));
    expect(data.totalClaimableUsd).toBeNull();
    expect(String(data.totalNote)).toContain("PENDLE_API_ERROR");
    expect((data.claimable as unknown[]).length).toBe(7);
  });

  it("names a FAILED decimals lookup rather than passing it off as an unpublished field", async () => {
    const data = output(
      await pendleRewardsMerkle({}, CONTEXT, () =>
        Promise.reject(new VexError(ErrorCodes.PENDLE_API_ERROR, "catalogue down")), NOW),
    );
    expect(String(data.amountsNote)).toContain("PENDLE_API_ERROR");
    expect((data.claimable as unknown[]).length).toBe(7);
  });

  it("prices the SAME token address on two chains independently", async () => {
    // A reward token address is only unique WITH its chain. Keying marks by the
    // bare address let one chain's price overwrite the other's, so a row could be
    // valued at a price that was never quoted for it.
    mockGetMerkleRewards.mockResolvedValue(
      merkleRewards([
        { chainId: 1, token: PENDLE_TOKEN, amount: "1000000" },
        { chainId: 42161, token: PENDLE_TOKEN, amount: "2000000" },
      ]),
    );
    mockGetAssetPrices.mockImplementation((query: { chainId: number; ids: string[] }) =>
      Promise.resolve(
        validatePendleAssetPrices({
          prices: { [`${query.chainId}-${PENDLE_TOKEN}`]: query.chainId === 1 ? 2 : 5 },
          total: 1,
          skip: 0,
        }),
      ),
    );

    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(PENDLE_FACTS), NOW));
    const rows = data.claimable as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.chainId === 1)?.valueUsd).toBe("2.00");
    expect(rows.find((r) => r.chainId === 42161)?.valueUsd).toBe("10.00");
    expect(data.totalClaimableUsd).toBe("12.00");
  });

  it("prices EVERY distinct token by chunking past the per-call id cap", async () => {
    const tokens = Array.from({ length: 55 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    mockGetMerkleRewards.mockResolvedValue(
      merkleRewards(tokens.map((token) => ({ chainId: 1, token, amount: "1000000" }))),
    );
    const facts = new Map(tokens.map((token) => [token, { symbol: "R", decimals: 6 }]));
    mockGetAssetPrices.mockImplementation((query: { chainId: number; ids: string[] }) =>
      Promise.resolve(
        validatePendleAssetPrices({
          prices: Object.fromEntries(query.ids.map((id) => [id, 1])),
          total: query.ids.length,
          skip: 0,
        }),
      ),
    );

    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(facts), NOW));
    // Two batches, not one truncated call: 50 + 5.
    expect(mockGetAssetPrices).toHaveBeenCalledTimes(2);
    const batches = mockGetAssetPrices.mock.calls.map((call) => (call[0] as { ids: string[] }).ids);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(5);
    expect(new Set(batches.flat()).size).toBe(55);
    expect(data.pricedRows).toBe(55);
    expect(data.unpricedRows).toBe(0);
  });

  it("keeps the marks it already collected when a later price batch fails", async () => {
    const tokens = Array.from({ length: 55 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    mockGetMerkleRewards.mockResolvedValue(
      merkleRewards(tokens.map((token) => ({ chainId: 1, token, amount: "1000000" }))),
    );
    const facts = new Map(tokens.map((token) => [token, { symbol: "R", decimals: 6 }]));
    mockGetAssetPrices
      .mockResolvedValueOnce(
        validatePendleAssetPrices({
          prices: Object.fromEntries(tokens.slice(0, 50).map((t) => [`1-${t}`, 1])),
          total: 50,
          skip: 0,
        }),
      )
      .mockRejectedValueOnce(new VexError(ErrorCodes.PENDLE_RATE_LIMITED, "rate limited"));

    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(facts), NOW));
    expect(data.pricedRows).toBe(50);
    expect(data.unpricedRows).toBe(5);
    expect(String(data.totalNote)).toContain("PENDLE_RATE_LIMITED");
    expect(data.totalClaimableUsd).toBe("50.00");
  });

  it("LABELS the total as partial when the row cap hides claimable rows", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      chainId: 1,
      token: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      amount: "1000000",
    }));
    mockGetMerkleRewards.mockResolvedValue(merkleRewards(rows));
    const facts = new Map(rows.map((r) => [r.token, { symbol: "R", decimals: 6 }]));
    mockGetAssetPrices.mockImplementation((query: { ids: string[] }) =>
      Promise.resolve(
        validatePendleAssetPrices({
          prices: Object.fromEntries(query.ids.map((id) => [id, 1])),
          total: query.ids.length,
          skip: 0,
        }),
      ),
    );

    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(facts), NOW));
    expect(data.claimableCount).toBe(120);
    expect(data.claimableShown).toBe(100);
    expect(data.truncated).toBe(true);
    expect(data.totalIsPartial).toBe(true);
    // An unlabelled 100-row total against 120 rows is a number that reads as the
    // whole answer and is not.
    expect(String(data.totalNote)).toContain("100");
    expect(String(data.totalNote)).toContain("120");
    expect(String(data.summary)).toContain("120");
  });

  it("labels the total partial from UNPRICED rows even when nothing was truncated", async () => {
    const data = output(await pendleRewardsMerkle({}, CONTEXT, () => Promise.resolve(PENDLE_FACTS), NOW));
    expect(data.truncated).toBe(false);
    expect(data.claimableShown).toBe(7);
    // Five of the seven live rows carry a token the catalogue cannot read, so the
    // total is a floor either way — and says so.
    expect(data.totalIsPartial).toBe(true);
  });

  it("fails with a named reason when no EVM wallet is selected", async () => {
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "no wallet");
    });
    const result = await pendleRewardsMerkle({}, CONTEXT, PENDLE_READ_NO_ASSET_FACTS, NOW);
    expect(result.success).toBe(false);
    expect(result.output).toContain("WALLET_SCOPE_MISMATCH");
    expect(mockGetMerkleRewards).not.toHaveBeenCalled();
  });
});
