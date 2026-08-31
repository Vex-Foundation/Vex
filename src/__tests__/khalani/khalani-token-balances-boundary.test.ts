/**
 * The STRICT wallet-balances boundary (`validateTokenBalancesResponse`).
 *
 * Two contracts are under test and they pull in opposite directions:
 *
 * 1. Every token the boundary ADMITS has a usable scale. `decimals` is a whole
 *    number in [0, 36], so `formatUnits` - which THROWS on a fractional scale
 *    and produces nonsense on `Infinity` - is total on the admitted rows.
 * 2. Refusing an entry may NEVER cost the chain. The wallet-balances array is
 *    the one Khalani surface an attacker can write to (mint a token, airdrop
 *    it), so an all-or-nothing throw here is a denial of service for the price
 *    of an airdrop. A decimals-only defect becomes a REPORTED rejection that
 *    keeps identity and the exact atomic amount.
 *
 * The line between the two is identity and structure: an entry that is also
 * malformed in any other field is a provider-shape defect and still fails the
 * whole call, exactly as it did before this boundary existed.
 */

import { describe, expect, it } from "vitest";
import { validateTokenBalancesResponse, validateTokensResponse } from "@tools/khalani/validation.js";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "0xUSDC",
    chainId: 1,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    extensions: { balance: "100000000", price: { usd: "1.00" } },
    ...overrides,
  };
}

/**
 * Every value that must NOT become a token's scale, and why each one is here.
 * `asNumber` (the tolerant primitive the curated token lists still use) accepts
 * the first four of these.
 */
const INVALID_DECIMALS: ReadonlyArray<readonly [label: string, value: unknown]> = [
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["NaN", Number.NaN],
  ["fractional", 6.5],
  ["negative", -1],
  ["above the 36 ceiling", 37],
  ["null", null],
  ["a decimal STRING", "18"],
];

describe("khalani wallet-balances boundary: admitted decimals", () => {
  it.each([0, 1, 6, 18, 36])("admits the whole scale %i", (decimals) => {
    const result = validateTokenBalancesResponse([entry({ decimals })]);

    expect(result.rejectedEntries).toEqual([]);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].decimals).toBe(decimals);
  });
});

describe("khalani wallet-balances boundary: refused decimals", () => {
  it.each(INVALID_DECIMALS)("refuses %s without failing the call", (_label, value) => {
    const result = validateTokenBalancesResponse([entry({ decimals: value })]);

    expect(result.tokens).toEqual([]);
    expect(result.rejectedEntries).toEqual([
      {
        entryIndex: 0,
        chainId: 1,
        address: "0xUSDC",
        name: "USD Coin",
        symbol: "USDC",
        balanceRaw: "100000000",
        reason: "token_decimals_invalid",
      },
    ]);
  });

  it("refuses a MISSING decimals field the same way", () => {
    const raw = entry();
    delete raw.decimals;

    const result = validateTokenBalancesResponse([raw]);

    expect(result.tokens).toEqual([]);
    expect(result.rejectedEntries[0].reason).toBe("token_decimals_invalid");
    expect(result.rejectedEntries[0].balanceRaw).toBe("100000000");
  });

  it("never echoes the invalid scale, so nothing downstream can reuse it", () => {
    const result = validateTokenBalancesResponse([entry({ decimals: 1e21 })]);

    // The rejection carries identity and amount, and NO scale of any kind -
    // neither the provider's value nor a guessed 18 (frozen contract C1.2).
    expect(Object.keys(result.rejectedEntries[0]).sort()).toEqual([
      "address",
      "balanceRaw",
      "chainId",
      "entryIndex",
      "name",
      "reason",
      "symbol",
    ]);
  });

  it("reports the entry's own index, so the caller can locate it in the response", () => {
    const result = validateTokenBalancesResponse([
      entry(),
      entry({ address: "0xBAD", symbol: "BAD", name: "Bad Token", decimals: 1.5 }),
    ]);

    expect(result.tokens.map((token) => token.address)).toEqual(["0xUSDC"]);
    expect(result.rejectedEntries[0].entryIndex).toBe(1);
  });
});

describe("khalani wallet-balances boundary: the exact raw amount", () => {
  it.each([
    ["a float string", "1.5"],
    ["a hex string", "0x64"],
    ["a signed string", "-100"],
    ["a JS number", 100],
    ["an absent balance", undefined],
  ])("reports balanceRaw:null for %s", (_label, balance) => {
    const result = validateTokenBalancesResponse([
      entry({ decimals: Number.POSITIVE_INFINITY, extensions: { balance } }),
    ]);

    // A size we cannot state exactly is reported as UNKNOWN, never rounded,
    // reconstructed or defaulted to zero (frozen contract C1.3).
    expect(result.rejectedEntries[0].balanceRaw).toBeNull();
  });

  it("reports balanceRaw:null when the entry has no extensions at all", () => {
    const raw = entry({ decimals: -1 });
    delete raw.extensions;

    expect(validateTokenBalancesResponse([raw]).rejectedEntries[0].balanceRaw).toBeNull();
  });

  it("keeps a zero balance, which is a real amount and not a missing one", () => {
    const result = validateTokenBalancesResponse([
      entry({ decimals: 37, extensions: { balance: "0" } }),
    ]);

    expect(result.rejectedEntries[0].balanceRaw).toBe("0");
  });
});

describe("khalani wallet-balances boundary: what still fails the whole call", () => {
  it.each([
    ["a missing address", { address: "" }, "Invalid Khalani response: missing token.address"],
    ["a non-string address", { address: 42 }, "Invalid Khalani response: missing token.address"],
    ["a missing chainId", { chainId: undefined }, "Invalid Khalani response: missing token.chainId"],
    ["a missing name", { name: "" }, "Invalid Khalani response: missing token.name"],
    ["a missing symbol", { symbol: "" }, "Invalid Khalani response: missing token.symbol"],
  ])("throws for %s", (_label, overrides, message) => {
    expect(() => validateTokenBalancesResponse([entry(overrides)])).toThrow(message);
  });

  it("throws when identity AND decimals are both broken", () => {
    // A decimals defect is recoverable only when it is the ONLY defect: without
    // an address there is no identity to attach the amount to.
    expect(() =>
      validateTokenBalancesResponse([entry({ address: "", decimals: Number.POSITIVE_INFINITY })]),
    ).toThrow("Invalid Khalani response: missing token.address");
  });

  it("throws for a non-object entry and for a non-array document", () => {
    expect(() => validateTokenBalancesResponse(["nope"])).toThrow(
      "Invalid Khalani response: token must be an object",
    );
    expect(() => validateTokenBalancesResponse({ data: [] })).toThrow(
      "Invalid Khalani response: expected token array",
    );
  });
});

describe("khalani wallet-balances boundary: the airdrop denial of service", () => {
  it("keeps every valid row when a hostile entry sits among them", () => {
    const result = validateTokenBalancesResponse([
      entry({ address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6 }),
      entry({
        address: "0xHOSTILE",
        symbol: "GIFT",
        name: "Airdropped Gift",
        decimals: 1e21,
        extensions: { balance: "777" },
      }),
      entry({
        address: "0xWETH",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
        extensions: { balance: "1000000000000000000" },
      }),
    ]);

    expect(result.tokens.map((token) => token.symbol)).toEqual(["USDC", "WETH"]);
    expect(result.rejectedEntries).toEqual([
      {
        entryIndex: 1,
        chainId: 1,
        address: "0xHOSTILE",
        name: "Airdropped Gift",
        symbol: "GIFT",
        balanceRaw: "777",
        reason: "token_decimals_invalid",
      },
    ]);
  });

  it("the CURATED token list still fails whole on the same hostile entry", () => {
    // `/v1/tokens`, search and autocomplete are provider-curated: nobody can add
    // an entry, so a malformed one is a provider defect that must fail loudly
    // rather than degrade quietly. Only the wallet-balances array is reachable
    // by an airdrop, and only it recovers per entry.
    expect(() => validateTokensResponse([entry({ decimals: null })])).toThrow(
      "Invalid Khalani response: missing token.decimals",
    );
  });
});
