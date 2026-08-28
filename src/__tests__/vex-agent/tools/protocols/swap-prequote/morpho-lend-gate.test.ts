/**
 * Morpho vault prequote pairing (E3b-2): a quote authorizes ONLY the execute it
 * actually priced.
 *
 * THE PROPERTY THAT MATTERS MOST HERE IS THE DIRECTION ONE. A deposit and a
 * withdrawal on the same vault take the same vault address and can take the same
 * amount, so if the two shared a prequote kind, a quote for putting money IN
 * would authorize taking it OUT. That is not a rounding risk; it is the wrong
 * operation on real funds. These cases pin that the two are structurally
 * unmixable, plus the ordinary bindings (vault, amount, slippage, venue) and the
 * fail-closed default.
 *
 * The DB and the wallet resolution are stubbed: what is under test is the
 * identity and the gate decision, not the repository.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type CreateMock = Mock<(input: unknown) => Promise<void>>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;

let mockCreate: CreateMock;
let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;

function resetMocks() {
  mockCreate = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  mockFindLatest = vi.fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>().mockResolvedValue(null);
  mockExistsFail = vi.fn<(s: string, h: string, k: string) => Promise<boolean>>().mockResolvedValue(false);
}
resetMocks();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: unknown) => mockCreate(input),
  findLatestFreshByMatch: (s: string, h: string, k: string) => mockFindLatest(s, h, k),
  existsFreshFailByMatch: (s: string, h: string, k: string) => mockExistsFail(s, h, k),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
}));

const mod = await import("@vex-agent/tools/protocols/swap-prequote.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AMOUNT = "1000000";

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  } as ProtocolExecutionContext;
}

function quoteParams(direction: "deposit" | "withdraw", overrides: Record<string, unknown> = {}) {
  return {
    vaultAddress: VAULT,
    chain: "base",
    direction,
    [direction === "deposit" ? "depositAmountRaw" : "withdrawAmountRaw"]: AMOUNT,
    slippageBps: 50,
    ...overrides,
  };
}

function executeParams(direction: "deposit" | "withdraw", overrides: Record<string, unknown> = {}) {
  return {
    vaultAddress: VAULT,
    chain: "base",
    [direction === "deposit" ? "depositAmountRaw" : "withdrawAmountRaw"]: AMOUNT,
    slippageBps: 50,
    ...overrides,
  };
}

function quoteResult(direction: "deposit" | "withdraw"): Record<string, unknown> {
  return {
    quote: {
      chainId: 8453,
      direction,
      vault: { address: VAULT, asset: ASSET },
      sharePrice: { slippageBps: 50 },
      preflight: { verdict: "ok" },
    },
    governance: { status: "read" },
  };
}

/** Record a quote and hand back the row the recorder would have written. */
async function recordAndCapture(direction: "deposit" | "withdraw", params: Record<string, unknown>) {
  await mod.recordPrequoteFromQuote("morpho.vault.quote", params, quoteResult(direction), ctx());
  expect(mockCreate).toHaveBeenCalled();
  return mockCreate.mock.calls[0]?.[0] as { matchHash: string; kind: string; amount: string; tokenIn: string; tokenOut: string };
}

/**
 * Make the stubbed repository behave like a real one holding exactly this row:
 * a lookup for a DIFFERENT hash or a different kind finds nothing.
 */
function seed(row: { matchHash: string; kind: string }) {
  mockFindLatest.mockImplementation(async (_s, hash, kind) =>
    hash === row.matchHash && kind === row.kind ? storedPrequote(row) : null,
  );
}

/**
 * A COMPLETE stored row, not a three-field stand-in: the gate reads
 * `safetyVerdict` and the row's identity, and a partial row typed as if it were
 * whole would keep compiling after the gate started reading a fourth column.
 */
function storedPrequote(row: { matchHash: string; kind: string }): SwapPrequote {
  return {
    prequoteId: "p1",
    sessionId: "session-1",
    matchHash: row.matchHash,
    kind: row.kind as SwapPrequote["kind"],
    family: "eip155",
    provider: "morpho",
    chainId: 8453,
    walletAddress: "0xaaaabbbbccccddddeeeeffff0000111122223333",
    tokenIn: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    tokenOut: "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca",
    amount: "1000000",
    slippageBps: 100,
    safetyVerdict: "pass",
    safetyDetail: {},
    routeRef: null,
    // Migration 095: a row that predates the claim lane reads as an
    // executable, unclaimed quote. It authorizes nothing on its own - the
    // claim additionally requires a stored route snapshot.
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T00:05:00.000Z",
  };
}

beforeEach(() => {
  resetMocks();
});

describe("the Morpho vault quote records the direction it actually priced", () => {
  it("records a deposit quote as kind lend_deposit, with the asset paying for the vault's shares", async () => {
    const row = await recordAndCapture("deposit", quoteParams("deposit"));

    expect(row.kind).toBe("lend_deposit");
    expect(row.tokenIn.toLowerCase()).toBe(ASSET);
    expect(row.tokenOut.toLowerCase()).toBe(VAULT);
    expect(row.amount).toBe(AMOUNT);
  });

  it("records a withdrawal quote as kind lend_withdraw, mirrored", async () => {
    const row = await recordAndCapture("withdraw", quoteParams("withdraw"));

    expect(row.kind).toBe("lend_withdraw");
    expect(row.tokenIn.toLowerCase()).toBe(VAULT);
    expect(row.tokenOut.toLowerCase()).toBe(ASSET);
  });
});

describe("a quote authorizes only its own direction", () => {
  it("lets a deposit quote authorize the deposit execute", async () => {
    seed(await recordAndCapture("deposit", quoteParams("deposit")));

    const decision = await mod.evaluatePrequoteGate("morpho.vault.deposit", executeParams("deposit"), ctx());

    expect(decision.kind).toBe("allow");
  });

  it("REFUSES to let a deposit quote authorize the WITHDRAW execute", async () => {
    seed(await recordAndCapture("deposit", quoteParams("deposit")));

    const decision = await mod.evaluatePrequoteGate("morpho.vault.withdraw", executeParams("withdraw"), ctx());

    expect(decision.kind).toBe("block");
  });

  it("REFUSES to let a withdrawal quote authorize the DEPOSIT execute", async () => {
    seed(await recordAndCapture("withdraw", quoteParams("withdraw")));

    const decision = await mod.evaluatePrequoteGate("morpho.vault.deposit", executeParams("deposit"), ctx());

    expect(decision.kind).toBe("block");
  });
});

describe("the identity binds what a substitution would change", () => {
  it("blocks an execute on a DIFFERENT vault", async () => {
    seed(await recordAndCapture("deposit", quoteParams("deposit")));

    const decision = await mod.evaluatePrequoteGate(
      "morpho.vault.deposit",
      executeParams("deposit", { vaultAddress: `0x${"9".repeat(40)}` }),
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });

  it("blocks an execute for a DIFFERENT amount", async () => {
    seed(await recordAndCapture("deposit", quoteParams("deposit")));

    const decision = await mod.evaluatePrequoteGate(
      "morpho.vault.deposit",
      executeParams("deposit", { depositAmountRaw: "2000000" }),
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });

  it("blocks an execute that widened the slippage the quote was priced at", async () => {
    seed(await recordAndCapture("deposit", quoteParams("deposit")));

    const decision = await mod.evaluatePrequoteGate(
      "morpho.vault.deposit",
      executeParams("deposit", { slippageBps: 500 }),
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });

  it("blocks an execute on a DIFFERENT chain, since a vault address is chain-scoped", async () => {
    seed(await recordAndCapture("deposit", quoteParams("deposit")));

    const decision = await mod.evaluatePrequoteGate(
      "morpho.vault.deposit",
      executeParams("deposit", { chain: "ethereum" }),
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });

  it("does NOT bind the quote's optional walletAddress param, which the execute cannot send", async () => {
    // The quote takes `walletAddress` to choose whose allowance to report. The
    // execute always signs with the session's selected wallet. If the param
    // entered the identity, a quote taken with it could authorize nothing.
    seed(await recordAndCapture("deposit", quoteParams("deposit", { walletAddress: WALLET })));

    const decision = await mod.evaluatePrequoteGate("morpho.vault.deposit", executeParams("deposit"), ctx());

    expect(decision.kind).toBe("allow");
  });
});

describe("the gate fails closed and speaks the right language", () => {
  it("blocks when no quote was ever recorded", async () => {
    const decision = await mod.evaluatePrequoteGate("morpho.vault.deposit", executeParams("deposit"), ctx());

    expect(decision.kind).toBe("block");
  });

  it("tells the agent to re-run morpho.vault.quote, NOT a swap quote", async () => {
    // Hamilton's obligation: without the LEND message maps the selector falls
    // back to the SWAP wording, which would send the agent to a tool that
    // cannot authorize this operation at all.
    const decision = await mod.evaluatePrequoteGate("morpho.vault.deposit", executeParams("deposit"), ctx());

    if (decision.kind !== "block") throw new Error("expected a block");
    expect(decision.message).toContain("morpho__vault_quote");
    expect(decision.message).not.toContain("swap quote");
  });

  it("words a blocked WITHDRAW as a withdrawal and says a deposit quote will not do", async () => {
    const decision = await mod.evaluatePrequoteGate("morpho.vault.withdraw", executeParams("withdraw"), ctx());

    if (decision.kind !== "block") throw new Error("expected a block");
    expect(decision.message).toContain("Vault withdrawal blocked");
    expect(decision.message).toContain("DEPOSIT quote does not authorize a withdrawal");
  });

  it("blocks an unsupported chain rather than resolving it to something else", async () => {
    const decision = await mod.evaluatePrequoteGate(
      "morpho.vault.deposit",
      executeParams("deposit", { chain: "not-a-chain" }),
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });
});
