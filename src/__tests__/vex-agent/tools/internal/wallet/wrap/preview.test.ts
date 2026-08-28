/**
 * The approval card: the exact sentence and panel a human authorizes from.
 *
 * Two properties are under test, and they fail differently.
 *
 * PRECISION. `formatWrapAmountHuman` is the only thing standing between a wei
 * amount and the number a user reads. The table below includes a value far
 * beyond IEEE-754 integer precision on purpose: if any `Number`, `parseFloat`
 * or division ever enters that function, that row is where it shows, and it
 * shows as a wrong quantity of money on a card someone is about to approve.
 *
 * POSITIVE STATEMENT. A wrap reads like a swap, and the differences are exactly
 * what a swap card warns about. So the assertions require the rate, slippage,
 * route and recipient lines to be PRESENT and to say what they are, rather than
 * merely checking that no misleading line appeared. An absent line teaches a
 * reader that a section failed to render; a present line is a fact.
 */

import { describe, expect, it } from "vitest";

import {
  formatWrapAmountHuman,
  isWrapEvmFeeBounds,
  renderWrapPreview,
  wrapPreviewsEqual,
  type RenderWrapPreviewInput,
} from "@vex-agent/tools/internal/wallet/wrap/preview.js";

// ── Precision ────────────────────────────────────────────────────────

describe("formatWrapAmountHuman renders base units exactly", () => {
  const table: readonly [string, string, number, string][] = [
    ["one wei at 18 decimals keeps all 18 places", "1", 18, "0.000000000000000001"],
    ["trailing fractional zeros are dropped", "1500000000000000000", 18, "1.5"],
    ["a whole number renders with no decimal point", "2000000000000000000", 18, "2"],
    ["a whole number of many units", "123000000000000000000", 18, "123"],
    [
      // 2^53 is where a double stops being able to count. This value is far past
      // it and every digit must survive.
      "a value far beyond IEEE-754 integer precision keeps every digit",
      "123456789012345678901234567890",
      18,
      "123456789012.34567890123456789",
    ],
    ["a sub-unit value pads leading zeros in the fraction", "42", 18, "0.000000000000000042"],
    ["fewer decimals than digits", "1234567", 6, "1.234567"],
    ["zero decimals renders the integer unchanged", "1234567", 0, "1234567"],
    ["leading zeros in the raw amount are normalized away", "0001500", 3, "1.5"],
    ["a value whose fraction is entirely zeros", "1000000", 6, "1"],
  ];

  for (const [name, raw, decimals, expected] of table) {
    it(name, () => {
      expect(formatWrapAmountHuman(raw, decimals)).toBe(expected);
    });
  }

  it("never emits exponent notation for a very large amount", () => {
    // The specific failure a float reintroduces: `1e+21` on a money card.
    const rendered = formatWrapAmountHuman("1" + "0".repeat(39), 18);
    expect(rendered).not.toMatch(/[eE]/);
    expect(rendered).toBe("1" + "0".repeat(21));
  });
});

// ── The card ─────────────────────────────────────────────────────────

const EIP1559_BOUNDS = {
  mode: "eip1559",
  gasLimit: "60000",
  maxFeePerGasWei: "2000000000",
  maxPriorityFeePerGasWei: "1000000000",
  maxTotalFeeWei: "120000000000000",
} as const;

const WRAP_INPUT: RenderWrapPreviewInput = {
  chainAlias: "base",
  chainId: 8453,
  direction: "wrap",
  contract: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    decimals: 18,
  },
  amountRaw: "1500000000000000000",
  payload: {
    to: "0x4200000000000000000000000000000000000006",
    data: "0xd0e30db0",
    valueWei: "1500000000000000000",
  },
  feeBounds: EIP1559_BOUNDS,
  expiresAt: "2026-08-28T12:00:00.000Z",
};

const UNWRAP_INPUT: RenderWrapPreviewInput = {
  ...WRAP_INPUT,
  direction: "unwrap",
  payload: {
    to: "0x4200000000000000000000000000000000000006",
    data: "0x2e1a7d4d00000000000000000000000000000000000000000000000014d1120d7b160000",
    valueWei: "0",
  },
};

const DIRECTIONS: readonly [string, RenderWrapPreviewInput][] = [
  ["wrap", WRAP_INPUT],
  ["unwrap", UNWRAP_INPUT],
];

describe("the card states what a swap card would warn about", () => {
  for (const [name, input] of DIRECTIONS) {
    describe(name, () => {
      const card = renderWrapPreview(input);

      it("states the rate is exactly 1:1", () => {
        expect(card.criticalArgs.rate).toContain("1:1");
        expect(card.criticalArgs.rate).toContain("the amount received is the amount sent");
      });

      it("states there is no slippage, and why", () => {
        expect(card.criticalArgs.slippage).toMatch(/^none\./);
        expect(card.criticalArgs.slippage).toContain("not a trade");
      });

      it("states there is no route, and why", () => {
        expect(card.criticalArgs.route).toMatch(/^none\./);
        expect(card.criticalArgs.route).toContain("directly");
        expect(card.criticalArgs.route).toContain("No router");
      });

      it("states the recipient is the signer and cannot be anyone else", () => {
        expect(card.criticalArgs.recipient).toContain("you, the signer");
        expect(card.criticalArgs.recipient).toContain("cannot be sent to any other address");
      });

      it("carries the WHOLE contract address in the label and in the panel", () => {
        // Address poisoning is defeated by an elision, so the sentence a human
        // authorizes from carries all 42 characters.
        expect(card.label).toContain(input.contract.address);
        expect(card.criticalArgs.wrappedNativeContract).toBe(input.contract.address);
        expect(card.criticalArgs.callTo).toBe(input.payload.to);
        expect(card.label).not.toContain("...");
        expect(card.label).not.toContain("…");
      });

      it("names the contract as the wrapped-native contract, never as WETH9", () => {
        const whole = JSON.stringify(card);
        expect(card.label).toContain("wrapped-native contract");
        expect(whole).not.toContain("WETH9");
      });

      it("shows the amount, its raw base units and the decimals that relate them", () => {
        expect(card.criticalArgs.amountRaw).toBe(input.amountRaw);
        expect(card.criticalArgs.amountHuman).toBe("1.5");
        expect(card.criticalArgs.amountDecimals).toBe("18");
        expect(card.label).toContain("1.5");
      });

      it("names the exact contract function the transaction calls", () => {
        expect(card.criticalArgs.contractFunction).toBe(
          name === "wrap" ? "deposit()" : "withdraw(uint256)",
        );
      });

      it("emits STRING values only, so no number can reach the digest preimage", () => {
        for (const [key, value] of Object.entries(card.criticalArgs)) {
          expect(typeof value, `criticalArgs.${key}`).toBe("string");
        }
      });

      it("carries the authorized network gas caps and NO other fee line", () => {
        expect(card.criticalArgs.maxTotalNetworkFeeWei).toBe(EIP1559_BOUNDS.maxTotalFeeWei);
        expect(card.criticalArgs.gasLimit).toBe(EIP1559_BOUNDS.gasLimit);
        expect(card.criticalArgs.maxFeePerGasWei).toBe(EIP1559_BOUNDS.maxFeePerGasWei);
        expect(card.criticalArgs.maxPriorityFeePerGasWei).toBe(
          EIP1559_BOUNDS.maxPriorityFeePerGasWei,
        );

        // The closed set: the ONLY keys mentioning a fee are the network gas
        // ceilings the user authorized. Any other fee-shaped key on this card
        // would be a charge nobody consented to, so this is an inventory rather
        // than an absence check on a guessed name.
        const feeKeys = Object.keys(card.criticalArgs)
          .filter((key) => /fee/i.test(key))
          .sort();
        expect(feeKeys).toEqual([
          "maxFeePerGasWei",
          "maxPriorityFeePerGasWei",
          "maxTotalNetworkFeeWei",
        ]);
      });
    });
  }

  it("says the native currency LEAVES on a wrap and ARRIVES on an unwrap", () => {
    const wrap = renderWrapPreview(WRAP_INPUT);
    const unwrap = renderWrapPreview(UNWRAP_INPUT);
    expect(wrap.criticalArgs.youSend).toContain("native currency of base");
    expect(wrap.criticalArgs.youReceive).toContain("WETH");
    expect(unwrap.criticalArgs.youSend).toContain("WETH");
    expect(unwrap.criticalArgs.youReceive).toContain("native currency of base");
    expect(wrap.label).not.toBe(unwrap.label);
  });
});

describe("the legacy fee arm renders a gas price instead of the 1559 pair", () => {
  const card = renderWrapPreview({
    ...WRAP_INPUT,
    feeBounds: {
      mode: "legacy",
      gasLimit: "60000",
      gasPriceWei: "1400000000",
      maxTotalFeeWei: "84000000000000",
    },
  });

  it("carries the gas price and no 1559 caps", () => {
    expect(card.criticalArgs.gasPriceWei).toBe("1400000000");
    expect(card.criticalArgs.maxTotalNetworkFeeWei).toBe("84000000000000");
    expect(card.criticalArgs.maxFeePerGasWei).toBeUndefined();
    expect(card.criticalArgs.maxPriorityFeePerGasWei).toBeUndefined();
  });
});

describe("isWrapEvmFeeBounds admits only the arms that carry gas ceilings", () => {
  it("accepts eip1559 and legacy", () => {
    expect(isWrapEvmFeeBounds(EIP1559_BOUNDS)).toBe(true);
    expect(
      isWrapEvmFeeBounds({
        mode: "legacy",
        gasLimit: "1",
        gasPriceWei: "1",
        maxTotalFeeWei: "1",
      }),
    ).toBe(true);
  });

  it("rejects the Solana arm, which has no EVM gas ceilings at all", () => {
    // The COMPLETE Solana arm, every field the durable schema requires. A
    // partial literal would prove the refusal for the wrong reason: the point
    // is that a genuine Solana fee-bounds row is refused because it carries no
    // EVM gas ceilings, not because it was malformed.
    expect(
      isWrapEvmFeeBounds({
        mode: "solana",
        computeUnitLimit: "200000",
        computeUnitPriceMicroLamports: "1000",
        baseFeeLamports: "5000",
        maxPriorityFeeLamports: "200",
        maxTotalFeeLamports: "5200",
      }),
    ).toBe(false);
  });
});

// ── Card equality ────────────────────────────────────────────────────

describe("wrapPreviewsEqual detects every shape a card edit can take", () => {
  const card = renderWrapPreview(WRAP_INPUT);

  it("is true for the identical card", () => {
    expect(wrapPreviewsEqual(card, renderWrapPreview(WRAP_INPUT))).toBe(true);
  });

  it("is FALSE when a key is ADDED", () => {
    // The subtle one: every true fact is still present, plus one more line the
    // reader takes as authoritative. A subset comparison would pass.
    const withExtra = {
      label: card.label,
      criticalArgs: { ...card.criticalArgs, vexFeeWei: "1000000000000000" },
    };
    expect(wrapPreviewsEqual(withExtra, card)).toBe(false);
    expect(wrapPreviewsEqual(card, withExtra)).toBe(false);
  });

  it("is FALSE when a key is REMOVED", () => {
    const { slippage: _dropped, ...rest } = card.criticalArgs;
    expect(wrapPreviewsEqual({ label: card.label, criticalArgs: rest }, card)).toBe(false);
    expect(wrapPreviewsEqual(card, { label: card.label, criticalArgs: rest })).toBe(false);
  });

  it("is FALSE when a value changes", () => {
    const edited = {
      label: card.label,
      criticalArgs: { ...card.criticalArgs, amountHuman: "0.0015" },
    };
    expect(wrapPreviewsEqual(edited, card)).toBe(false);
  });

  it("is FALSE when only the sentence changes", () => {
    expect(
      wrapPreviewsEqual({ label: `${card.label} (safe)`, criticalArgs: card.criticalArgs }, card),
    ).toBe(false);
  });

  it("is FALSE when a stored value is the NUMBER the renderer would have stringified", () => {
    // The renderer only ever emits strings, so a number on the stored side is
    // already evidence of an edit and must not compare equal.
    const stored = { label: card.label, criticalArgs: { ...card.criticalArgs, chainId: 8453 } };
    expect(wrapPreviewsEqual(stored, card)).toBe(false);
  });
});
