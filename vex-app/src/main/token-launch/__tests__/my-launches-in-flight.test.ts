/**
 * OD-3 / G4 — A LAUNCH YOU PAID FOR IS VISIBLE BEFORE IT IS PROVEN.
 *
 * The owner's live case: he launched a token, the transaction never got a
 * receipt, and "My Launches" showed him nothing at all — because
 * `launched_tokens` is written ONLY once a token identity is proven. A launch
 * that is broadcast, mempool-stuck or superseded therefore existed nowhere he
 * could see it, with nothing to say why.
 *
 * This is a READ-SIDE MERGE and nothing more. The stop condition is absolute:
 * no `launched_tokens` row is ever written for an unproven launch — that table
 * is the durable identity index, and putting a token that may not exist into it
 * would corrupt the one source of truth the rest of the app trusts.
 *
 * What the merged row may and may not claim:
 *
 * - `tokenAddress` is NULL, modelled as its own shape rather than an empty
 *   string: a launch with no proven token address must never render as a token.
 * - it carries the name/symbol THE USER TYPED (the intent has them) and the tx
 *   hash, so the row is identifiable and clickable.
 * - it shows NO amount beyond the authorized native prebuy already on the
 *   intent — nothing was decoded, so there is nothing else to honestly show.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockListLaunched = vi.fn();
const mockListUnsettled = vi.fn();

vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  listForWallets: (...a: unknown[]) => mockListLaunched(...a),
}));
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  listUnsettledForWallets: (...a: unknown[]) => mockListUnsettled(...a),
  getAwaitingForSession: vi.fn(),
}));

const { listMyLaunches } = await import("../index.js");
const { launchedTokenDtoSchema } = await import("../../../shared/schemas/token-launch.js");

const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const CHAIN_ID = 4663;

const CONFIRMED_ROW = {
  tokenAddress: "0xToken",
  name: "Proven",
  symbol: "PRV",
  createTxHash: "0xconfirmed",
  chainId: CHAIN_ID,
  createdAt: "2026-08-01T00:00:00.000Z",
  initialBuyRaw: "1000",
  initialBuyDecimals: 18,
};

const IN_FLIGHT_INTENT = {
  intentId: "i-1",
  name: "Waiting",
  symbol: "WAIT",
  status: "broadcast_pending",
  txHash: "0xpending",
  chainId: CHAIN_ID,
  walletAddress: WALLET,
  broadcastAt: "2026-08-04T00:00:00.000Z",
  createdAt: "2026-08-03T00:00:00.000Z",
  prebuyRaw: "300000000000000",
  prebuyDecimals: 18,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListLaunched.mockResolvedValue([CONFIRMED_ROW]);
  mockListUnsettled.mockResolvedValue([]);
});

describe("an in-flight launch appears in My Launches", () => {
  it("surfaces it with NO token address, as its own lifecycle", async () => {
    mockListUnsettled.mockResolvedValue([IN_FLIGHT_INTENT]);

    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);
    const inFlight = launches.find((row) => row.createTxHash === "0xpending");

    expect(inFlight).toBeDefined();
    expect(inFlight?.tokenAddress).toBeNull();
    expect(inFlight?.lifecycle).toBe("in_flight");
    // The name and symbol THE USER TYPED — the intent has them.
    expect(inFlight).toMatchObject({ name: "Waiting", symbol: "WAIT" });
  });

  it("puts in-flight launches AHEAD of confirmed ones — the newest news first", async () => {
    mockListUnsettled.mockResolvedValue([IN_FLIGHT_INTENT]);

    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);

    expect(launches[0]?.createTxHash).toBe("0xpending");
    expect(launches[1]?.createTxHash).toBe("0xconfirmed");
  });

  it("shows only the AUTHORIZED prebuy — nothing was decoded, so nothing else is claimed", async () => {
    mockListUnsettled.mockResolvedValue([IN_FLIGHT_INTENT]);

    const [inFlight] = await listMyLaunches([WALLET], CHAIN_ID, 25);

    // Raw and decimals travel TOGETHER: a raw amount without its decimals is
    // unreadable, and 300000000000000 means nothing without the 18.
    expect(inFlight).toMatchObject({ initialBuyRaw: "300000000000000", initialBuyDecimals: 18 });
  });

  it("pairs a null prebuy with null decimals — never a bare raw or a lone scale", async () => {
    mockListUnsettled.mockResolvedValue([
      { ...IN_FLIGHT_INTENT, prebuyRaw: null, prebuyDecimals: 18 },
    ]);

    const [inFlight] = await listMyLaunches([WALLET], CHAIN_ID, 25);

    expect(inFlight?.initialBuyRaw).toBeNull();
    expect(inFlight?.initialBuyDecimals).toBeNull();
  });

  it("never invents a row for a launch with no tx hash — nothing was broadcast", async () => {
    mockListUnsettled.mockResolvedValue([{ ...IN_FLIGHT_INTENT, txHash: null }]);

    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);

    expect(launches.every((row) => row.createTxHash !== null)).toBe(true);
    expect(launches).toHaveLength(1);
  });
});

/**
 * U5 / P2. Terminalizing a stuck launch `superseded_unproven` (migration 072)
 * takes it out of `broadcast_pending`, and `launched_tokens` will NEVER hold a
 * row for it. Without this merge arm the row would disappear the moment Vex
 * stopped checking it — repeating, exactly, the disappearance OD-3 exists to
 * prevent, and this time permanently.
 */
describe("a superseded launch stays listed, under its own lifecycle", () => {
  const SUPERSEDED_INTENT = {
    ...IN_FLIGHT_INTENT,
    intentId: "i-2",
    status: "superseded_unproven",
    txHash: "0xsuperseded",
    name: "Replaced",
    symbol: "RPL",
  };

  it("is listed, with no token address and NOT as in-flight", async () => {
    mockListUnsettled.mockResolvedValue([SUPERSEDED_INTENT]);

    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);
    const row = launches.find((entry) => entry.createTxHash === "0xsuperseded");

    expect(row).toBeDefined();
    expect(row?.tokenAddress).toBeNull();
    // Saying "in_flight" would promise a check that is no longer running.
    expect(row?.lifecycle).toBe("superseded_unproven");
    expect(row).toMatchObject({ name: "Replaced", symbol: "RPL" });
  });

  it("does not disturb the in-flight row beside it", async () => {
    mockListUnsettled.mockResolvedValue([IN_FLIGHT_INTENT, SUPERSEDED_INTENT]);

    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);

    expect(launches.map((row) => row.lifecycle)).toEqual([
      "in_flight",
      "superseded_unproven",
      "launched",
    ]);
  });

  it("still parses against the strict DTO", async () => {
    mockListUnsettled.mockResolvedValue([SUPERSEDED_INTENT]);

    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);

    for (const row of launches) {
      expect(launchedTokenDtoSchema.safeParse(row).success).toBe(true);
    }
  });
});

describe("a proven launch is unchanged", () => {
  it("keeps its token address and reads as launched", async () => {
    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);

    expect(launches[0]).toMatchObject({
      tokenAddress: "0xToken",
      lifecycle: "launched",
    });
  });
});

describe("the strict DTO carries every merged row", () => {
  it("parses BOTH shapes — a drifted field would drop the whole payload", async () => {
    mockListUnsettled.mockResolvedValue([IN_FLIGHT_INTENT]);

    const launches = await listMyLaunches([WALLET], CHAIN_ID, 25);

    for (const row of launches) {
      expect(launchedTokenDtoSchema.safeParse(row).success).toBe(true);
    }
  });
});
