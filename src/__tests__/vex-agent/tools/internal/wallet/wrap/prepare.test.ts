/**
 * `WalletWrapPrepare`, end to end through its injected chain seam.
 *
 * No network and no database: the chain seam is an object literal, the session
 * control lock runs its callback directly, and the repo insert is captured. The
 * behaviour being proven is the ORDER of the gates, because that order is what
 * guarantees a refusal never leaves a durable row behind:
 *
 *   forbidden fields -> shape -> chain -> VERIFIED registry -> derive ->
 *   balance -> simulate -> MANDATORY gas caps -> amount+gas ceiling -> insert
 *
 * Every refusal case therefore asserts BOTH the named refusal and that nothing
 * was written. The positive cases assert the DURABLE ROW, not the tool's
 * self-report: the row is what confirm will later revalidate, and a handler that
 * returned a correct summary while storing something else is exactly the defect
 * the row assertion catches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const created: Record<string, unknown>[] = [];

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_sessionId: string, run: (client: unknown) => Promise<unknown>) =>
    run({}),
}));

vi.mock("@vex-agent/db/repos/wallet-wrap-intents.js", () => ({
  createWith: async (_client: unknown, input: Record<string, unknown>) => {
    created.push(input);
  },
}));

const SELECTED_EVM = "0x1111111111111111111111111111111111111111";

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SELECTED_EVM,
  walletScopeErrorToResult: () => ({ success: false, output: "wallet scope" }),
}));

const { handleWalletWrapPrepare } = await import(
  "@vex-agent/tools/internal/wallet/wrap/prepare.js"
);

import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { WrapChain } from "@vex-agent/tools/internal/wallet/wrap/chain.js";

const CONTEXT = { sessionId: "session-1" } as InternalToolContext;

/** Base's verified WETH, and the whole triple prepare must derive for it. */
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const ONE_ETHER = "1000000000000000000";

/** A generous native balance: every default case must clear amount + gas ceiling. */
const RICH = "1000000000000000000000";

function wrapChain(overrides: Partial<WrapChain> = {}): WrapChain {
  return {
    chainId: 8453,
    chainAlias: "base",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    getNativeBalance: async () => RICH,
    getWrappedBalance: async () => RICH,
    simulate: async () => ({ ok: true, value: undefined }),
    estimateFees: async () => ({
      suggestedGasLimit: "60000",
      suggestedMaxFeePerGasWei: "1500000000",
      suggestedMaxPriorityFeePerGasWei: "100000000",
      suggestedGasPriceWei: "1400000000",
      supportsEip1559: true,
    }),
    ...overrides,
  };
}

const BOUNDS = {
  gasLimit: "60000",
  maxFeePerGasWei: "2000000000",
  maxPriorityFeePerGasWei: "1000000000",
};

/** gasLimit * maxFeePerGas, the ceiling the wrap balance check adds to the amount. */
const MAX_TOTAL_FEE_WEI = (60000n * 2000000000n).toString(10);

function factoryFor(chain: WrapChain = wrapChain()) {
  return async () => chain;
}

function refusalOf(result: { data?: unknown }): { code: unknown; details: unknown } {
  const data = result.data as Record<string, unknown> | undefined;
  return { code: data?.refusalCode, details: data?.refusalDetails };
}

beforeEach(() => {
  created.length = 0;
});

// ── Positive, both directions ─────────────────────────────────────────

describe("a wrap writes ONE pending intent whose payload carries the amount in value", () => {
  it("stores the derived triple, the verified contract identity and the digest", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      factoryFor(),
    );

    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;

    expect(row.sessionId).toBe("session-1");
    expect(row.walletAddress).toBe(SELECTED_EVM);
    expect(row.chainAlias).toBe("base");
    expect(row.chainId).toBe(8453);
    expect(row.direction).toBe("wrap");
    expect(row.amountRaw).toBe(ONE_ETHER);
    expect(row.contract).toEqual({ address: BASE_WETH, symbol: "WETH", decimals: 18 });
    // The amount is in `valueWei`; the calldata is the constant selector.
    expect(row.payload).toEqual({ to: BASE_WETH, data: "0xd0e30db0", valueWei: ONE_ETHER });
    expect(row.feeBounds).toEqual({
      mode: "eip1559",
      gasLimit: "60000",
      maxFeePerGasWei: "2000000000",
      maxPriorityFeePerGasWei: "1000000000",
      maxTotalFeeWei: MAX_TOTAL_FEE_WEI,
    });
    expect(row.proposalDigestVersion).toBe("v1");
    expect(row.proposalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.status).toBeUndefined();

    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("prepared");
    expect(data.intentId).toBe(row.intentId);
    expect(data.amountHuman).toBe("1");
    expect(data.rate).toBe("1:1");
    expect(data.approvedFeeBounds).toEqual(row.feeBounds);
    expect(data.preview).toEqual(row.preview);
    // Prepare signs nothing and spends nothing, and says so.
    expect(result.output).toContain("Nothing was signed");
  });
});

describe("an unwrap writes ONE pending intent whose calldata carries the amount", () => {
  it("stores withdraw(uint256) with a zero value", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "unwrap", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      factoryFor(),
    );

    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.direction).toBe("unwrap");
    expect(row.payload).toEqual({
      to: BASE_WETH,
      data: "0x2e1a7d4d0000000000000000000000000000000000000000000000000de0b6b3a7640000",
      valueWei: "0",
    });
  });
});

// ── The capability gate ───────────────────────────────────────────────

describe("an unverified chain is refused BY NAME, before anything is derived", () => {
  it("names the chain and the verified set, and writes nothing", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "linea", direction: "wrap", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      factoryFor(wrapChain({ chainId: 59144, chainAlias: "linea" })),
    );

    expect(result.success).toBe(false);
    expect(refusalOf(result).code).toBe("unverified_chain");
    expect(result.output).toContain("linea");
    expect(result.output).toContain("59144");
    // The set is NAMED, so the model learns where wrapping is available rather
    // than guessing an address from another table.
    expect(result.output).toContain("Wrapping is available on:");
    const details = refusalOf(result).details as Record<string, string>;
    expect(details.chain).toBe("linea");
    expect(details.chainId).toBe("59144");
    expect(details.verifiedChains.split(",")).toContain("base");
    expect(details.verifiedChains.split(",")).not.toContain("linea");
    expect(created).toHaveLength(0);
  });
});

// ── Mandatory gas caps ────────────────────────────────────────────────

describe("missing gas caps refuse BY NAME and carry the estimate as a labelled hint", () => {
  it("refuses with missing_fee_bounds and writes nothing", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", amountRaw: ONE_ETHER },
      CONTEXT,
      factoryFor(),
    );

    expect(result.success).toBe(false);
    expect(refusalOf(result).code).toBe("missing_fee_bounds");
    // Vex never turns a network estimate into a spending limit, so the estimate
    // travels only as a labelled hint.
    expect(result.output).toContain("HINTS ONLY");
    const details = refusalOf(result).details as Record<string, string>;
    expect(details).toEqual({
      hintSuggestedGasLimit: "60000",
      hintSuggestedMaxFeePerGasWei: "1500000000",
      hintSuggestedMaxPriorityFeePerGasWei: "100000000",
      hintSuggestedGasPriceWei: "1400000000",
      hintChainSupportsEip1559: "true",
    });
    expect(created).toHaveLength(0);
  });

  it("refuses when the 1559 pair is supplied without a gas limit", async () => {
    const result = await handleWalletWrapPrepare(
      {
        chain: "base",
        direction: "wrap",
        amountRaw: ONE_ETHER,
        maxFeePerGasWei: "2000000000",
        maxPriorityFeePerGasWei: "1000000000",
      },
      CONTEXT,
      factoryFor(),
    );
    expect(refusalOf(result).code).toBe("missing_fee_bounds");
    expect(created).toHaveLength(0);
  });
});

// ── Balance ───────────────────────────────────────────────────────────

describe("insufficient balance is refused on the side the direction actually spends", () => {
  it("refuses a wrap the NATIVE balance cannot cover", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      factoryFor(wrapChain({ getNativeBalance: async () => "1" })),
    );
    expect(refusalOf(result).code).toBe("insufficient_balance");
    expect(refusalOf(result).details).toEqual({ balanceRaw: "1", amountRaw: ONE_ETHER });
    expect(created).toHaveLength(0);
  });

  it("refuses an unwrap the WRAPPED balance cannot cover", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "unwrap", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      // Native is rich, wrapped is empty: an unwrap spends the token, and a
      // check on the wrong balance would let this through.
      factoryFor(wrapChain({ getWrappedBalance: async () => "0" })),
    );
    expect(refusalOf(result).code).toBe("insufficient_balance");
    expect(refusalOf(result).details).toEqual({ balanceRaw: "0", amountRaw: ONE_ETHER });
    expect(created).toHaveLength(0);
  });

  it("refuses a wrap that covers the AMOUNT but not the amount plus the gas ceiling", async () => {
    // The case a naive balance check misses entirely: a wrap spends native AND
    // pays gas in native out of the same balance, so wrapping the exact balance
    // leaves nothing for the fee the user authorized.
    const exactly = ONE_ETHER;
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", amountRaw: exactly, ...BOUNDS },
      CONTEXT,
      factoryFor(wrapChain({ getNativeBalance: async () => exactly })),
    );
    expect(refusalOf(result).code).toBe("insufficient_balance");
    expect(result.output).toContain("network fee you authorized");
    expect(refusalOf(result).details).toEqual({
      balanceRaw: exactly,
      amountRaw: exactly,
      maxTotalFeeWei: MAX_TOTAL_FEE_WEI,
    });
    expect(created).toHaveLength(0);
  });

  it("accepts a wrap of exactly balance minus the gas ceiling", async () => {
    // The boundary immediately on the other side, so the check above is proven
    // to be the intended inequality and not an off-by-a-whole-fee refusal.
    const balance = 10n ** 18n;
    const amount = balance - BigInt(MAX_TOTAL_FEE_WEI);
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", amountRaw: amount.toString(10), ...BOUNDS },
      CONTEXT,
      factoryFor(wrapChain({ getNativeBalance: async () => balance.toString(10) })),
    );
    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
  });
});

// ── Forbidden redirect fields ─────────────────────────────────────────

describe("a caller-supplied redirect field is refused BY NAME, never dropped", () => {
  const fields = [
    "from",
    "sender",
    "account",
    "signer",
    "feePayer",
    "payer",
    "feeReceiver",
    "feeRecipient",
    "referrer",
    "referralAddress",
    "refundAddress",
    "walletAddress",
  ] as const;

  for (const field of fields) {
    it(`refuses \`${field}\` and writes nothing`, async () => {
      const result = await handleWalletWrapPrepare(
        {
          chain: "base",
          direction: "wrap",
          amountRaw: ONE_ETHER,
          ...BOUNDS,
          [field]: "0x9999999999999999999999999999999999999999",
        },
        CONTEXT,
        factoryFor(),
      );
      expect(result.success).toBe(false);
      expect(refusalOf(result).code).toBe("forbidden_field");
      // Named, so a caller who passed it cannot believe it was honoured.
      expect(result.output).toContain(`\`${field}\``);
      expect(refusalOf(result).details).toEqual({ field });
      expect(created).toHaveLength(0);
    });
  }

  it("refuses the redirect field BEFORE any other validation", async () => {
    // Ordering matters: a forbidden field alongside a bad amount must still be
    // reported as the forbidden field, or a caller learns the wrong lesson.
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "sideways", amountRaw: "0", feeReceiver: "0xabc" },
      CONTEXT,
      factoryFor(),
    );
    expect(refusalOf(result).code).toBe("forbidden_field");
  });
});

// ── Shape ─────────────────────────────────────────────────────────────

describe("a malformed amount is refused as invalid_input and writes nothing", () => {
  const cases: readonly [string, unknown][] = [
    ["zero", "0"],
    ["zero written with padding", "0000"],
    ["a negative amount", "-1"],
    ["a fractional amount", "1.5"],
    ["a JSON number, which is how an amount arrives after arithmetic", 1_000_000],
    ["a JSON number that is a safe integer", 1],
    ["a boolean", true],
    ["an amount with a unit suffix", "1 ETH"],
    ["an exponent form", "1e18"],
    ["an empty string", ""],
    ["hex", "0x0de0b6b3a7640000"],
  ];

  for (const [name, amountRaw] of cases) {
    it(`refuses ${name}`, async () => {
      const result = await handleWalletWrapPrepare(
        { chain: "base", direction: "wrap", amountRaw, ...BOUNDS },
        CONTEXT,
        factoryFor(),
      );
      expect(result.success).toBe(false);
      expect(refusalOf(result).code).toBe("invalid_input");
      expect(refusalOf(result).details).toEqual({ field: "amountRaw" });
      expect(created).toHaveLength(0);
    });
  }

  it("refuses a missing amount", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", ...BOUNDS },
      CONTEXT,
      factoryFor(),
    );
    expect(refusalOf(result).code).toBe("invalid_input");
    expect(refusalOf(result).details).toEqual({ field: "amountRaw" });
    expect(created).toHaveLength(0);
  });

  it("normalizes leading zeros so one quantity has one spelling", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", amountRaw: `000${ONE_ETHER}`, ...BOUNDS },
      CONTEXT,
      factoryFor(),
    );
    expect(result.success).toBe(true);
    expect((created[0] as Record<string, unknown>).amountRaw).toBe(ONE_ETHER);
  });
});

describe("a bad direction is refused and writes nothing", () => {
  const cases: readonly [string, unknown][] = [
    ["an unknown word", "sideways"],
    ["the contract function name", "deposit"],
    ["the wrong case", "WRAP"],
    ["a JSON number", 1],
    ["a boolean", true],
    ["an empty string", ""],
  ];

  for (const [name, direction] of cases) {
    it(`refuses ${name}`, async () => {
      const result = await handleWalletWrapPrepare(
        { chain: "base", direction, amountRaw: ONE_ETHER, ...BOUNDS },
        CONTEXT,
        factoryFor(),
      );
      expect(result.success).toBe(false);
      expect(refusalOf(result).code).toBe("invalid_input");
      expect(refusalOf(result).details).toEqual({ field: "direction" });
      expect(created).toHaveLength(0);
    });
  }

  it("refuses a missing direction", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      factoryFor(),
    );
    expect(refusalOf(result).code).toBe("invalid_input");
    expect(refusalOf(result).details).toEqual({ field: "direction" });
    expect(created).toHaveLength(0);
  });

  it("refuses a missing chain", async () => {
    const result = await handleWalletWrapPrepare(
      { direction: "wrap", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      factoryFor(),
    );
    expect(refusalOf(result).code).toBe("invalid_input");
    expect(refusalOf(result).details).toEqual({ field: "chain" });
    expect(created).toHaveLength(0);
  });
});

// ── Simulation ────────────────────────────────────────────────────────

describe("a failed simulation refuses before the gas caps are even read", () => {
  it("carries the decoded revert reason and writes nothing", async () => {
    const result = await handleWalletWrapPrepare(
      { chain: "base", direction: "wrap", amountRaw: ONE_ETHER, ...BOUNDS },
      CONTEXT,
      factoryFor(
        wrapChain({
          simulate: async () => ({
            ok: false,
            refusal: {
              code: "simulation_failed",
              message: "Refusing to prepare: the contract reverted with: ds-math-sub-underflow.",
            },
          }),
        }),
      ),
    );
    expect(result.success).toBe(false);
    expect(refusalOf(result).code).toBe("simulation_failed");
    expect(created).toHaveLength(0);
  });
});
