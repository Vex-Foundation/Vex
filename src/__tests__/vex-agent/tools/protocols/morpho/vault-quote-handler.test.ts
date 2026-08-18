/**
 * `morpho.vault.quote` handler behaviour: the agent-facing contract.
 *
 * The preview ENGINE is not under test here; it is Dijkstra's, it has its own
 * suite, and it is stubbed so these cases can assert the things the agent layer
 * actually owns and nothing else:
 *
 *   - the input contract, including the exclusive amount pair and the
 *     direction/amount DISAGREEMENT, which is refused rather than resolved;
 *   - the governance read, which the on-chain preview cannot perform, and its
 *     degradation to an explicit UNKNOWN rather than a reassuring absence;
 *   - the gated-vault warning reaching the summary, since a deposit is the very
 *     act a withdrawal gate strands;
 *   - the preview-only contract surviving into the reply text;
 *   - the wallet note distinguishing "these are your requirements" from "these
 *     are what a fresh wallet would face".
 *
 * Everything the handler passes DOWN is asserted too, because a slippage
 * default resolved here and then dropped on the way to the price guard would be
 * invisible in the reply.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VEX_DEFAULT_SLIPPAGE_BPS, VEX_MAX_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { mutableRecord } from "../../../../_test-value-guards.js";
import {
  MORPHO_VAULT_NOT_FOUND,
  MORPHO_VAULT_V1_DETAIL,
  MORPHO_VAULT_V2_DETAIL_GATED,
} from "./vault-fixtures.js";

const preview = vi.hoisted(() => vi.fn());

vi.mock("@tools/morpho/mutations.js", () => ({
  previewMorphoVaultOperation: preview,
}));

const { morphoVaultQuote } = await import(
  "../../../../../vex-agent/tools/protocols/morpho/handlers/vault-quote.js"
);

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
/** The same account the caller may legitimately send in mixed case. */
const WALLET_MIXED = "0xAAAAbbbbCCCCddddEEEEffff0000111122223333";

/**
 * The Morpho client caches a response per query for 15 seconds, so two cases
 * that read the same vault address would share one stubbed body regardless of
 * what the second one stubbed. Each case therefore gets its OWN address, which
 * is also closer to the truth: these are different vaults.
 */
let vaultSeq = 0;
let VAULT = "";
function nextVaultAddress(): string {
  vaultSeq += 1;
  return `0x${vaultSeq.toString(16).padStart(40, "0")}`;
}

/**
 * A REAL `Response`: the Morpho client reads `ok`, `status`,
 * `headers.get("retry-after")` and `json()`, and a hand-shaped double that
 * answers exactly those keeps passing if the client starts reading a fifth.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A preview result shaped like the engine's, with only what these cases read. */
function previewResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 8453,
    direction: "deposit",
    vault: {
      address: VAULT,
      name: "Steakhouse USDC",
      generation: "v1",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      assetSymbol: "USDC",
      assetDecimals: 6,
      shareDecimals: 18,
    },
    input: { raw: "1000000", decimals: 6, human: "1", symbol: "USDC" },
    expectedShares: { raw: "970000000000000000", decimals: 18, human: "0.97", symbol: null },
    sharePrice: {
      assetsPerShareRaw: "1030000",
      assetDecimals: 6,
      maxSharePriceRaw: "1040300000000000000000000000",
      vexCeilingRaw: "1040300000000000000000000001",
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      note: "share price note",
    },
    // The owner's FINAL approval policy (2026-08-17): no signature path of any
    // kind, so the two steps a fresh USDT-shaped wallet faces are the reset to
    // zero and the EXACT-amount approval to GeneralAdapter1 - never a Permit2
    // grant and never a typed-data signature.
    requirements: [
      { kind: "approval_reset", token: "0x8335", spender: "0xadapter", spenderRole: "GeneralAdapter1", amountRaw: "0", explanation: "zeroed first" },
      { kind: "approval", token: "0x8335", spender: "0xadapter", spenderRole: "GeneralAdapter1", amountRaw: "1000000", explanation: "exact amount" },
    ],
    allowance: {
      shape: "reset-then-approve",
      spender: "0xadapter",
      spenderRole: "GeneralAdapter1",
      currentAllowanceRaw: "1",
      requiredAmountRaw: "1000000",
      note: "allowance note",
    },
    bundle: { shape: "bundler3-multicall", to: "0xbundler", toRole: "bundler3", selector: "0x1", functionName: "multicall", valueRaw: "0", legs: [], maxSharePriceRaw: "1040300000000000000000000000", verifiedAmountRaw: "1000000", verifiedRecipient: WALLET },
    bundleAllowlist: ["bundler3.multicall"],
    gas: { nodeEstimate: null, vexGasLimit: null, unavailableReason: "The gas figure is UNKNOWN, not zero.", note: "gas note" },
    preflight: { verdict: "reverted", revertReason: "insufficient allowance", explanation: "the approval does not exist yet" },
    walletAddressUsed: WALLET,
    walletAddressWasSupplied: true,
    disclaimer: "THIS IS A PREVIEW.",
    ...overrides,
  };
}

/**
 * Answer each outbound query by its OPERATION NAME, mirroring
 * `vault-handlers.test.ts`. The governance read tries V2 first and falls back to
 * V1, so a stub that returned one body for both would answer the V2 probe with a
 * V1 payload and test a shape that cannot occur.
 */
function stubMorphoByOperation(bodies: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { query: string };
      const key = Object.keys(bodies).find((k) => sent.query.includes(k));
      return jsonResponse(key === undefined ? MORPHO_VAULT_NOT_FOUND : bodies[key]);
    }),
  );
}

/** The V1 vault every case gets unless it asks for the gated V2 one. */
function stubV1Vault(): void {
  stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_NOT_FOUND, VexMorphoVaultV1: MORPHO_VAULT_V1_DETAIL });
}

function stubVaultReadFailure(): void {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("connect ECONNREFUSED https://api.morpho.org/graphql");
  }));
}

/**
 * Exactly the slice of the quote payload these cases read, named so a reader
 * sees the agent-facing contract under assertion rather than an untyped bag.
 * Anything absent from this shape is not asserted here on purpose.
 */
interface QuotePayload {
  readonly summary: string;
  readonly nextStep: string;
  readonly filtersApplied: Record<string, unknown> & { readonly slippageBps: number };
  readonly governance: {
    readonly status: string;
    readonly depositGated: boolean | null;
    readonly withdrawalGated: boolean | null;
    readonly note: string;
  };
  readonly quote: {
    readonly input: { readonly decimals: number };
    readonly expectedShares: { readonly raw: string; readonly decimals: number };
    readonly requirements: readonly unknown[];
  };
  readonly notes: {
    readonly preview: string;
    readonly wallet: string;
    readonly simulation: string;
    readonly shape: string;
    readonly scales: string;
  };
}

function data(result: { output: string }): QuotePayload {
  return JSON.parse(result.output) as QuotePayload;
}

/** Params that pass validation, so each case varies only what it is testing. */
function goodParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { vaultAddress: VAULT, chain: "base", direction: "deposit", depositAmountRaw: "1000000", ...overrides };
}

beforeEach(() => {
  vi.resetModules();
  VAULT = nextVaultAddress();
  preview.mockReset();
  preview.mockResolvedValue(previewResult());
  stubV1Vault();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("morpho.vault.quote input contract", () => {
  it("requires the vault address, the chain and the direction, each named in its own refusal", async () => {
    for (const [missing, params] of [
      ["vaultAddress", goodParams({ vaultAddress: undefined })],
      ["chain", goodParams({ chain: undefined })],
      ["direction", goodParams({ direction: undefined })],
    ] as const) {
      const result = await morphoVaultQuote(params);
      expect(result.success, missing).toBe(false);
      expect(result.output, missing).toContain(missing);
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses a market id supplied as a vault address, naming what it actually is", async () => {
    const result = await morphoVaultQuote(goodParams({ vaultAddress: `0x${"a".repeat(64)}` }));

    expect(result.success).toBe(false);
    expect(result.output).toContain("MARKET id");
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses BOTH amounts together, because exactly one names the operation", async () => {
    const result = await morphoVaultQuote(goodParams({ withdrawAmountRaw: "5" }));

    expect(result.success).toBe(false);
    expect(result.output).toContain("withdrawAmountRaw");
    expect(preview).not.toHaveBeenCalled();
  });

  it("REFUSES a direction that disagrees with the amount key instead of picking a winner", async () => {
    // The case the whole `direction` param exists for: the caller has
    // contradicted itself about which way money moves. Resolving it either way
    // acts on a mistake at the one point it is still free to catch.
    const result = await morphoVaultQuote({
      vaultAddress: VAULT,
      chain: "base",
      direction: "withdraw",
      depositAmountRaw: "1000000",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("depositAmountRaw");
    expect(result.output).toContain("disagree");
    expect(preview).not.toHaveBeenCalled();
  });

  it("requires the amount that matches the direction, by name", async () => {
    const result = await morphoVaultQuote({ vaultAddress: VAULT, chain: "base", direction: "withdraw" });

    expect(result.success).toBe(false);
    expect(result.output).toContain("withdrawAmountRaw");
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses a HUMAN decimal amount rather than rounding it, and says where the decimals come from", async () => {
    const result = await morphoVaultQuote(goodParams({ depositAmountRaw: "1.5" }));

    expect(result.success).toBe(false);
    expect(result.output).toContain("HUMAN decimal");
    expect(result.output).toContain("asset's decimals");
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses a zero or negative amount, which prices nothing", async () => {
    for (const amount of ["0", "-1"]) {
      const result = await morphoVaultQuote(goodParams({ depositAmountRaw: amount }));
      expect(result.success, amount).toBe(false);
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it("passes a very large raw amount through exactly, with no float rounding", async () => {
    const huge = "123456789012345678901234567890";

    await morphoVaultQuote(goodParams({ depositAmountRaw: huge }));

    expect(preview.mock.calls[0]?.[0].amountRaw).toBe(BigInt(huge));
  });
});

describe("morpho.vault.quote slippage policy", () => {
  it("resolves an omitted tolerance to the ONE Vex default and passes it down explicitly", async () => {
    await morphoVaultQuote(goodParams());

    expect(preview.mock.calls[0]?.[0].slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
    expect(data(await morphoVaultQuote(goodParams())).filtersApplied.slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("REJECTS a tolerance above the Vex ceiling rather than clamping it", async () => {
    const result = await morphoVaultQuote(goodParams({ slippageBps: VEX_MAX_SLIPPAGE_BPS + 1 }));

    expect(result.success).toBe(false);
    expect(result.output).toContain(String(VEX_MAX_SLIPPAGE_BPS));
    expect(preview).not.toHaveBeenCalled();
  });

  it("rejects a fractional and a negative tolerance by name", async () => {
    for (const bps of [0.5, -1]) {
      const result = await morphoVaultQuote(goodParams({ slippageBps: bps }));
      expect(result.success, String(bps)).toBe(false);
      expect(result.output, String(bps)).toContain("slippageBps");
    }
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("morpho.vault.quote governance, which the on-chain preview cannot see", () => {
  it("surfaces a DEPOSIT gate in the summary, since it can refuse the very operation being priced", async () => {
    // `Basecamp`, the live V2 capture, carries a non-null `sendAssetsGate` and
    // has abdicated the other three. A preview of a deposit into it looks
    // entirely healthy in its numbers and can still be refused on chain.
    stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_V2_DETAIL_GATED });

    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.governance.status).toBe("read");
    expect(payload.governance.depositGated).toBe(true);
    expect(payload.summary).toContain("DEPOSITS ARE GATED");
    // The two gates answer different questions and are never folded together.
    expect(payload.governance.withdrawalGated).toBe(false);
    expect(payload.summary).not.toContain("WITHDRAWALS ARE GATED");
  });

  it("surfaces a WITHDRAWAL gate too, which strands money that is already in", async () => {
    const gatedOnExit = JSON.parse(JSON.stringify(MORPHO_VAULT_V2_DETAIL_GATED)) as typeof MORPHO_VAULT_V2_DETAIL_GATED;
    const config = mutableRecord(
      mutableRecord(gatedOnExit.data.vaultV2ByAddress, "gated V2 detail")["gatesConfig"],
      "gated V2 gatesConfig",
    );
    config["sendSharesGate"] = { address: "0x000000000000000000000000000000000000dEaD", abdicated: false };
    stubMorphoByOperation({ VexMorphoVaultV2: gatedOnExit });

    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.governance.withdrawalGated).toBe(true);
    expect(payload.summary).toContain("WITHDRAWALS ARE GATED");
  });

  it("reports a V1 vault's absence of gating as a PROVEN absence, not a silence", async () => {
    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.governance.status).toBe("read");
    expect(payload.governance.withdrawalGated).toBe(false);
    expect(payload.governance.note).toContain("no gating mechanism");
    expect(payload.summary).not.toContain("WITHDRAWALS ARE GATED");
  });

  it("degrades an UNREADABLE governance read to UNKNOWN, never to ungated", async () => {
    // The reassuring answer and the wrong one: an unknown gate reported as
    // absent is the failure the wallet lane already records.
    stubVaultReadFailure();

    const result = await morphoVaultQuote(goodParams());
    const payload = data(result);

    expect(result.success).toBe(true);
    expect(payload.governance.status).toBe("unavailable");
    expect(payload.governance.withdrawalGated).toBeNull();
    expect(payload.governance.note).toContain("UNKNOWN");
    expect(payload.governance.note).toContain("not the same as absent");
    expect(payload.summary).toContain("UNKNOWN rather than absent");
  });

  it("still returns the priced operation when only the governance read failed", async () => {
    stubVaultReadFailure();

    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.quote.expectedShares.raw).toBe("970000000000000000");
  });

  it("fails the whole call when the PREVIEW fails, inventing no numbers", async () => {
    preview.mockRejectedValue(new Error("bundle rejected"));

    const result = await morphoVaultQuote(goodParams());

    expect(result.success).toBe(false);
    expect(result.output).toContain("morpho.vault.quote failed");
  });
});

describe("morpho.vault.quote reply contract", () => {
  it("states that nothing was signed or sent, in the summary and in the notes", async () => {
    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.summary).toContain("Nothing was signed and nothing was sent");
    expect(payload.notes.preview).toContain("commits nothing");
    // The quote still commits nothing, but it is no longer a dead end: it
    // AUTHORIZES the matching execute, and the reply has to say which one.
    expect(payload.nextStep).toContain("morpho.vault.deposit");
    expect(payload.nextStep).toContain("spends real funds");
  });

  it("lists the requirements and says how many would have to be satisfied first", async () => {
    const payload = data(await morphoVaultQuote(goodParams({ walletAddress: WALLET })));

    expect(payload.summary).toContain("2 requirement(s)");
    expect(payload.quote.requirements).toHaveLength(2);
    expect(payload.notes.wallet).toContain("the wallet you named");
  });

  it("says the requirements are a FRESH wallet's when no walletAddress was supplied", async () => {
    preview.mockResolvedValue(previewResult({ walletAddressWasSupplied: false }));

    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.notes.wallet).toContain("FRESH wallet");
    expect(payload.notes.wallet).toContain("Re-run with `walletAddress`");
  });

  it("passes the wallet down only when one was supplied, never a placeholder of its own", async () => {
    await morphoVaultQuote(goodParams());
    expect(preview.mock.calls[0]?.[0].walletAddress).toBeUndefined();

    await morphoVaultQuote(goodParams({ walletAddress: WALLET_MIXED }));
    expect(preview.mock.calls[1]?.[0].walletAddress).toBe(WALLET);
  });

  it("explains a reverted deposit simulation as a missing approval, not a broken vault", async () => {
    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.summary).toContain("REVERTED");
    expect(payload.summary).toContain("before treating this as a fault in the vault");
    expect(payload.notes.simulation).toContain("the approval does not exist yet");
  });

  it("keeps a transport-ambiguous verdict distinct from a proven revert", async () => {
    preview.mockResolvedValue(previewResult({
      preflight: { verdict: "transport-ambiguous", revertReason: null, explanation: "the node did not answer" },
    }));

    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.summary).toContain("UNKNOWN");
    expect(payload.summary).not.toContain("REVERTED");
  });

  it("names the withdrawal shape honestly: a direct call with no bundle and no guard", async () => {
    preview.mockResolvedValue(previewResult({
      direction: "withdraw",
      sharePrice: { ...previewResult().sharePrice as Record<string, unknown>, maxSharePriceRaw: null, vexCeilingRaw: null },
      requirements: [],
      allowance: null,
      // A withdrawal pulls nothing, so it has no allowance reading at all.
      bundle: { shape: "direct-vault-call", to: VAULT, toRole: "vault", selector: "0x2", functionName: "withdraw", valueRaw: "0", legs: [], maxSharePriceRaw: null, verifiedAmountRaw: "1000000", verifiedRecipient: WALLET },
    }));

    const payload = data(await morphoVaultQuote(goodParams({
      direction: "withdraw",
      depositAmountRaw: undefined,
      withdrawAmountRaw: "1000000",
    })));

    expect(payload.notes.shape).toContain("DIRECT call on the vault itself");
    expect(payload.notes.shape).toContain("None of those absences is a defect");
    // A tolerance that bound on nothing must not read as one that bound.
    expect(payload.summary).toContain("binds on nothing here");
    expect(payload.summary).toContain("No approval or signature is required");
  });

  it("keeps the two scales apart in the reply, with a note saying why", async () => {
    const payload = data(await morphoVaultQuote(goodParams()));

    expect(payload.quote.input.decimals).toBe(6);
    expect(payload.quote.expectedShares.decimals).toBe(18);
    expect(payload.notes.scales).toContain("DIFFERENT units");
  });

  it("echoes every parameter it acted on, including the default it chose", async () => {
    const payload = data(await morphoVaultQuote(goodParams({ walletAddress: WALLET })));

    expect(payload.filtersApplied).toEqual({
      vaultAddress: VAULT,
      chain: "base",
      direction: "deposit",
      depositAmountRaw: "1000000",
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      walletAddress: WALLET,
    });
  });
});
