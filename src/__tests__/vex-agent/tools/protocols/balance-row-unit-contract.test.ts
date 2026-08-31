/**
 * WP1 - the UNIT CONTRACT for agent-facing balance rows.
 *
 * THE DEFECT THIS PINS. A real agent session read the raw balance
 * `9873301706589007` at 18 decimals as 9.87 WETH instead of 0.009873, told the
 * user in bold they held about 24,900 USD, and sized a trade against it. In the
 * SAME reasoning block it divided two other 16-to-22-digit values correctly, and
 * the system prompt already carried the rule with a worked example. It is an
 * arithmetic-RELIABILITY failure, not a knowledge failure, so no amount of
 * further instruction fixes it: the fix is to stop making the model divide.
 *
 * Before this suite there was NOT ONE test asserting that a wallet row carries a
 * human amount at all. That absence is why the defect shipped, so the row
 * contract is pinned here at the conversion owner and at every lane's mapper.
 *
 * `parseUnits` appears ONLY in the round-trip test, which is the one place the
 * inverse is the subject; production code never reconstructs a raw amount.
 */

import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";

import {
  MAX_TOKEN_DECIMALS,
  isTokenDecimals,
  projectBalanceRow,
} from "../../../../vex-agent/tools/protocols/amount-display.js";
import { projectToken, projectTokens } from "../../../../vex-agent/tools/protocols/khalani/projectors.js";
import { validateChainsResponse, validateTokensResponse } from "@tools/khalani/validation.js";
import { solanaRowToWalletToken } from "../../../../vex-agent/tools/internal/wallet/solana-row.js";
import type { KhalaniToken } from "@tools/khalani/types.js";
import type { SolanaBalanceRow } from "@tools/solana-ecosystem/balances/wallet-snapshot.js";

/** The exact value from the incident transcript. */
const INCIDENT_RAW = "9873301706589007";
const INCIDENT_HUMAN = "0.009873301706589007";

describe("projectBalanceRow - the regression reproducer", () => {
  it("projects the incident's raw WETH balance to its true human amount", () => {
    const row = projectBalanceRow(INCIDENT_RAW, 18, null);

    // Reverting the conversion (or reading the raw integer as the amount) makes
    // this assertion red, which is the whole point of the test.
    expect(row.balance).toBe(INCIDENT_HUMAN);
    expect(row.balance).not.toBe("9.873301706589007");
    expect(Number(row.balance)).toBeLessThan(0.01);
  });

  it("estimates the incident's USD value from the true amount, not the raw integer", () => {
    // The price the session was working with. 0.009873 WETH is about 25 USD,
    // not the ~24,900 USD the model announced.
    const row = projectBalanceRow(INCIDENT_RAW, 18, "2522.5");

    expect(row.balance).toBe(INCIDENT_HUMAN);
    expect(Number(row.valueUsd)).toBeGreaterThan(24);
    expect(Number(row.valueUsd)).toBeLessThan(26);
  });
});

describe("projectBalanceRow - exactness and round-trip", () => {
  const cases: ReadonlyArray<{ raw: string; decimals: number; human: string }> = [
    { raw: "0", decimals: 18, human: "0" },
    { raw: "1", decimals: 18, human: "0.000000000000000001" },
    { raw: "1", decimals: 0, human: "1" },
    { raw: "1500000", decimals: 6, human: "1.5" },
    { raw: INCIDENT_RAW, decimals: 18, human: INCIDENT_HUMAN },
    // Well above 2^53: a float round-trip loses the low digits, a string does not.
    { raw: "9007199254740993", decimals: 9, human: "9007199.254740993" },
    { raw: "123456789012345678901234567890", decimals: 18, human: "123456789012.34567890123456789" },
    { raw: "1", decimals: MAX_TOKEN_DECIMALS, human: `0.${"0".repeat(35)}1` },
  ];

  for (const { raw, decimals, human } of cases) {
    it(`converts ${raw} at ${decimals} decimals exactly, and back`, () => {
      const row = projectBalanceRow(raw, decimals, null);
      expect(row.balance).toBe(human);
      expect(row.unprojectableReason).toBeUndefined();
      // The inverse reconstructs the raw amount with no digit lost.
      expect(parseUnits(row.balance as string, decimals).toString()).toBe(raw);
    });
  }

  it("accepts a bigint raw amount as well as a decimal string", () => {
    expect(projectBalanceRow(BigInt(INCIDENT_RAW), 18, null).balance).toBe(INCIDENT_HUMAN);
  });
});

describe("projectBalanceRow - poisoned decimals", () => {
  const poisoned: ReadonlyArray<{ label: string; decimals: unknown }> = [
    { label: "Infinity", decimals: Number.POSITIVE_INFINITY },
    { label: "-Infinity", decimals: Number.NEGATIVE_INFINITY },
    { label: "NaN", decimals: Number.NaN },
    { label: "-1", decimals: -1 },
    { label: "37 (past the 36 ceiling)", decimals: 37 },
    { label: "a fraction", decimals: 6.5 },
    { label: "null", decimals: null },
    { label: "undefined", decimals: undefined },
    { label: 'the STRING "18"', decimals: "18" },
  ];

  for (const { label, decimals } of poisoned) {
    it(`refuses ${label} by name and keeps the row's raw amount readable`, () => {
      expect(isTokenDecimals(decimals)).toBe(false);

      const row = projectBalanceRow(INCIDENT_RAW, decimals, "2522.5");

      expect(row.balance).toBeNull();
      expect(row.valueUsd).toBeNull();
      expect(row.unprojectableReason).toBe("decimals_invalid");
    });
  }

  it("ACCEPTS decimals 0, which is the `??` versus `||` test", () => {
    // `decimals || 18` turns a legitimate 0 into 18 and divides a whole-unit
    // balance into dust. Rabby carries that bug in nine files on its signing path.
    expect(isTokenDecimals(0)).toBe(true);

    const row = projectBalanceRow("42", 0, "2");

    expect(row.balance).toBe("42");
    expect(row.valueUsd).toBe("84");
    expect(row.unprojectableReason).toBeUndefined();
  });
});

describe("projectBalanceRow - unusable raw amounts", () => {
  it("names a missing raw amount rather than reporting zero", () => {
    for (const missing of [null, undefined, "", "   "]) {
      const row = projectBalanceRow(missing, 18, "1");
      expect(row.balance).toBeNull();
      expect(row.unprojectableReason).toBe("balance_raw_missing");
    }
  });

  it("refuses a float raw amount instead of reconstructing the lost digits", () => {
    for (const notAnInteger of ["9873301706589007.5", "9.87e15", "0x2311", "abc", 1.5]) {
      const row = projectBalanceRow(notAnInteger, 18, "1");
      expect(row.balance).toBeNull();
      expect(row.unprojectableReason).toBe("balance_raw_not_an_integer");
    }
  });
});

describe("projectBalanceRow - a missing price is never a zero", () => {
  for (const noPrice of [null, undefined, "", "not-a-number", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    it(`reports priceUnavailable for ${String(noPrice)}, never valueUsd 0`, () => {
      const row = projectBalanceRow("1500000", 6, noPrice);

      expect(row.balance).toBe("1.5");
      expect(row.valueUsd).toBeNull();
      expect(row.valueUsd).not.toBe("0");
      expect(row.priceUnavailable).toBe(true);
    });
  }

  it("treats a quoted price of exactly 0 as a real feed, not a missing one", () => {
    const row = projectBalanceRow("1500000", 6, "0");

    expect(row.valueUsd).toBe("0");
    expect(row.priceUnavailable).toBeUndefined();
  });
});

describe("lane row contract - every balance row carries the quartet", () => {
  function khalaniBalanceRow(): KhalaniToken {
    return {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      chainId: 1,
      name: "Wrapped Ether",
      symbol: "WETH",
      decimals: 18,
      extensions: { balance: INCIDENT_RAW, price: { usd: "2522.5" } },
    };
  }

  function solanaRow(overrides: Partial<SolanaBalanceRow> = {}): SolanaBalanceRow {
    return {
      mint: "So11111111111111111111111111111111111111112",
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      amountRaw: "1234567891",
      priceUsd: 150,
      usdValue: 185.185,
      isNative: true,
      ...overrides,
    };
  }

  it("khalani lane: a balances row carries balanceRaw, balance, decimals and valueUsd", () => {
    const row = projectToken(khalaniBalanceRow());

    expect(row.balanceRaw).toBe(INCIDENT_RAW);
    expect(row.balance).toBe(INCIDENT_HUMAN);
    expect(row.decimals).toBe(18);
    expect(row.priceUsd).toBe("2522.5");
    expect(Number(row.valueUsd)).toBeLessThan(26);
  });

  it("khalani lane: an identity row (no balance in the bag) stays an identity row", () => {
    // Four nulls on a `tokens.search` hit would read as "you hold zero of it",
    // which is a different claim from "this lookup never asked about a wallet".
    const row = projectToken({ ...khalaniBalanceRow(), extensions: { price: { usd: "2522.5" } } });

    expect(row).not.toHaveProperty("balanceRaw");
    expect(row).not.toHaveProperty("balance");
    expect(row).not.toHaveProperty("valueUsd");
    expect(row.priceUsd).toBe("2522.5");
  });

  it("solana lane: a row carries balanceRaw, balance, decimals and valueUsd", () => {
    const row = solanaRowToWalletToken(solanaRow());

    expect(row.balanceRaw).toBe("1234567891");
    expect(row.balance).toBe("1.234567891");
    expect(row.decimals).toBe(9);
    expect(row.priceUsd).toBe("150");
    expect(Number(row.valueUsd)).toBeCloseTo(185.185, 3);
  });

  it("solana lane: an unpriced row is null-valued and flagged, never zero-valued", () => {
    const row = solanaRowToWalletToken(solanaRow({ priceUsd: null, usdValue: null }));

    expect(row.balance).toBe("1.234567891");
    expect(row.priceUsd).toBeNull();
    expect(row.valueUsd).toBeNull();
    expect(row.priceUnavailable).toBe(true);
  });

  it("either lane: a row with impossible decimals STAYS, named, and is never guessed at 18", () => {
    const khalani = projectToken({
      ...khalaniBalanceRow(),
      decimals: Number.POSITIVE_INFINITY,
    });
    expect(khalani.symbol).toBe("WETH");
    expect(khalani.balanceRaw).toBe(INCIDENT_RAW);
    expect(khalani.balance).toBeNull();
    expect(khalani.valueUsd).toBeNull();
    expect(khalani.unprojectableReason).toBe("decimals_invalid");

    const solana = solanaRowToWalletToken(solanaRow({ decimals: -1 }));
    expect(solana.address).toBe("So11111111111111111111111111111111111111112");
    expect(solana.balanceRaw).toBe("1234567891");
    expect(solana.balance).toBeNull();
    expect(solana.valueUsd).toBeNull();
    expect(solana.unprojectableReason).toBe("decimals_invalid");
  });
});

/**
 * The BOUNDARY plus the PROJECTION, driven together.
 *
 * `token.decimals` is validated tolerantly and `chain.nativeCurrency.decimals`
 * strictly, and the asymmetry is a deliberate REACHABILITY decision recorded at
 * the call site in `validation/chains-tokens.ts`. Anyone can mint a token and
 * airdrop it; nobody can add an entry to Khalani's chain registry.
 *
 * This suite is the proof that the tolerant half does not leak: the poisoned
 * value gets through the validator and is caught one layer later, where it
 * costs ONE ROW instead of the whole chain's token list.
 */
describe("the Khalani boundary and the projection, end to end", () => {
  function poisonedToken(decimals: unknown) {
    return {
      address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      chainId: 1,
      name: "Airdropped Thing",
      symbol: "EVIL",
      decimals,
      extensions: { balance: "1000", price: { usd: "1" } },
    };
  }

  const goodToken = {
    address: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    chainId: 1,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    extensions: { balance: "1500000", price: { usd: "1.0001" } },
  };

  it("does NOT throw the whole token list away for one hostile token", () => {
    // A validator that threw here would blank a funded wallet for the price of
    // an airdrop. This is the denial of service the tolerant half prevents.
    const tokens = validateTokensResponse([
      goodToken,
      poisonedToken(Number.POSITIVE_INFINITY),
      poisonedToken(-1),
    ]);

    expect(tokens).toHaveLength(3);
  });

  it("projects the hostile row as unprojectable while its neighbours convert", () => {
    const rows = projectTokens(validateTokensResponse([
      goodToken,
      poisonedToken(Number.POSITIVE_INFINITY),
    ]));

    const good = rows.find((row) => row.symbol === "USDC");
    expect(good?.balance).toBe("1.5");
    expect(good?.unprojectableReason).toBeUndefined();

    const evil = rows.find((row) => row.symbol === "EVIL");
    // Identity and the raw amount survive: "cannot be converted" must stay
    // distinguishable from "not in your wallet".
    expect(evil?.address).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(evil?.balanceRaw).toBe("1000");
    // And it is structurally unusable for sizing.
    expect(evil?.balance).toBeNull();
    expect(evil?.valueUsd).toBeNull();
    expect(evil?.unprojectableReason).toBe("decimals_invalid");
  });

  it("keeps CHAIN native decimals strict, because that input is curated", () => {
    // A poisoned native scale is a provider defect in a 20-entry registry no
    // attacker can write to, so it fails loudly instead of degrading quietly.
    expect(() => validateChainsResponse([{
      type: "eip155",
      id: 1,
      name: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: Number.POSITIVE_INFINITY },
    }])).toThrow(/chain.nativeCurrency.decimals must be a whole number/);

    // The same registry entry with real decimals still validates.
    const chains = validateChainsResponse([{
      type: "eip155",
      id: 1,
      name: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    }]);
    expect(chains[0]?.nativeCurrency.decimals).toBe(18);
  });
});
