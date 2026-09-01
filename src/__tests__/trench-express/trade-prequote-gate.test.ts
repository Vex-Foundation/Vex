import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import type { SwapPrequote, SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { extractQuote } from "@vex-agent/tools/protocols/prequote/safety/extract.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000abc";
const TOKEN = "0x58659Ef9Be57216632BFD341FC57736a429EFB91";
const CHAIN_ID = 4663;

type CreateMock = Mock<(input: { matchHash: string; amount: string }) => Promise<void>>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;

let mockCreate: CreateMock;
let mockFind: FindMock;
let mockExistsFail: ExistsMock;
let recordedHash: string | null;

function reset(): void {
  recordedHash = null;
  mockCreate = vi.fn<(input: { matchHash: string; amount: string }) => Promise<void>>().mockImplementation(async (input) => {
    recordedHash = input.matchHash;
  });
  mockFind = vi.fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>().mockResolvedValue(null);
  mockExistsFail = vi.fn<(s: string, h: string, k: string) => Promise<boolean>>().mockResolvedValue(false);
}
reset();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: { matchHash: string; amount: string }) => mockCreate(input),
  findLatestFreshByMatch: (s: string, h: string, k: string) => mockFind(s, h, k),
  existsFreshFailByMatch: (s: string, h: string, k: string) => mockExistsFail(s, h, k),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
}));

const record = await import("@vex-agent/tools/protocols/prequote/record.js");
const gate = await import("@vex-agent/tools/protocols/prequote/gate.js");

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  };
}

const QUOTE_PARAMS = { chain: "robinhood", tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" };
const QUOTE_OUTPUT = {
  chainId: CHAIN_ID,
  tokenIn: { address: NATIVE_TOKEN_ADDRESS },
  tokenOut: { address: TOKEN },
  safety: { tokenIn: { native: true }, tokenOut: { checkFailed: true, reason: "unavailable" } },
};

function prequoteRow(verdict: SafetyVerdict): SwapPrequote {
  return {
    prequoteId: "prequote-trench-1",
    sessionId: SESSION_ID,
    matchHash: recordedHash ?? "x".repeat(64),
    kind: "swap",
    family: "eip155",
    provider: "trench",
    chainId: CHAIN_ID,
    walletAddress: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
    tokenIn: NATIVE_TOKEN_ADDRESS,
    tokenOut: TOKEN,
    amount: "0.01",
    slippageBps: null,
    safetyVerdict: verdict,
    safetyDetail: {},
    routeRef: null,
    // Migration 095: a row that predates the claim lane reads as an
    // executable, unclaimed quote. It authorizes nothing on its own - the
    // claim additionally requires a stored route snapshot.
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as SwapPrequote;
}

beforeEach(reset);

describe("trench.trade_quote prequote extraction", () => {
  it("routes to the EVM extractor and records the swap identity with an unknown verdict", () => {
    const extracted = extractQuote("trench.trade_quote", QUOTE_PARAMS, QUOTE_OUTPUT);
    expect(extracted).not.toBeNull();
    expect(extracted!.chainId).toBe(CHAIN_ID);
    expect(extracted!.tokenIn).toBe(NATIVE_TOKEN_ADDRESS);
    expect(extracted!.tokenOut).toBe(TOKEN);
    expect(extracted!.amount).toBe("0.01");
    // No honeypot oracle on the RBC curve token → allowed-with-approval-warning.
    expect(extracted!.verdict).toBe("unknown");
  });
});

describe("trench execute prequote gate — quote↔execute collision", () => {
  it("records a prequote whose hash the matching execute reproduces (ALLOW)", async () => {
    await record.recordPrequoteFromQuote("trench.trade_quote", QUOTE_PARAMS, QUOTE_OUTPUT, ctx());
    expect(recordedHash).toBeTruthy();

    // The gate finds the row only when queried with the SAME hash the quote recorded.
    mockFind.mockImplementation(async (_s, h) => (h === recordedHash ? prequoteRow("unknown") : null));

    const decision = await gate.evaluatePrequoteGate(
      "trench.trade_execute",
      { chain: "robinhood", tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" },
      ctx(),
    );
    expect(decision.kind).toBe("allow");
  });

  it("blocks (no_quote) when the execute amount differs from the quoted amount", async () => {
    await record.recordPrequoteFromQuote("trench.trade_quote", QUOTE_PARAMS, QUOTE_OUTPUT, ctx());
    mockFind.mockImplementation(async (_s, h) => (h === recordedHash ? prequoteRow("unknown") : null));

    const decision = await gate.evaluatePrequoteGate(
      "trench.trade_execute",
      { chain: "robinhood", tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.02" }, // different amount
      ctx(),
    );
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") expect(decision.reason).toBe("no_quote");
  });
});
