/**
 * The versioned wrap proposal digest.
 *
 * The property under test is COVERAGE, not stability. `deposit()` calldata is
 * the constant `0xd0e30db0` for every amount on every chain, so a digest over
 * the payload bytes would be identical for a one-wei wrap and a whole-balance
 * wrap - nothing a user consented to would be bound. The table below therefore
 * drives EVERY field of the input and requires each one, changed alone, to move
 * the digest.
 *
 * The preimage is asserted separately because the digest is a hex string, and a
 * hex string tells a reviewer nothing about what was covered.
 */

import { describe, expect, it } from "vitest";

import { WRAP_PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import {
  bindingFromDurableWrapIntent,
  computeWrapProposalDigest,
  wrapProposalDigestPreimage,
  type WrapProposalDigestInput,
} from "@vex-agent/tools/internal/wallet/wrap/proposal-digest.js";

import { consistentWrapIntent } from "./_wrap-row-fixture.js";

/**
 * Kept separately typed so a spread override stays inside the EIP-1559 arm of
 * the fee-bounds union rather than widening to it: the legacy arm has no
 * `maxFeePerGasWei`, and an override onto the union would land there.
 */
const BASE_EIP1559_BOUNDS = {
  mode: "eip1559",
  gasLimit: "60000",
  maxFeePerGasWei: "2000000000",
  maxPriorityFeePerGasWei: "1000000000",
  maxTotalFeeWei: "120000000000000",
} as const;

const BASE_INPUT: WrapProposalDigestInput = {
  intentId: "11111111-1111-4111-8111-111111111111",
  walletAddress: "0x1111111111111111111111111111111111111111",
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
  feeBounds: BASE_EIP1559_BOUNDS,
  expiresAt: "2026-08-28T12:00:00.000Z",
};

function digestOf(overrides: Partial<WrapProposalDigestInput>): string {
  return computeWrapProposalDigest({ ...BASE_INPUT, ...overrides }).digest;
}

const BASELINE = digestOf({});

describe("the digest covers every sign-relevant field", () => {
  const mutations: readonly [string, Partial<WrapProposalDigestInput>][] = [
    ["the intent id (a digest may not be replayed against another row)", {
      intentId: "22222222-2222-4222-8222-222222222222",
    }],
    ["the wallet address", { walletAddress: "0x9999999999999999999999999999999999999999" }],
    ["the chain alias", { chainAlias: "arbitrum" }],
    ["the numeric chain id (the same address exists on chains never verified)", { chainId: 42161 }],
    ["the direction, which decides which asset leaves the wallet", { direction: "unwrap" }],
    [
      "the contract ADDRESS",
      { contract: { ...BASE_INPUT.contract, address: "0x8888888888888888888888888888888888888888" } },
    ],
    [
      "the contract SYMBOL the card shows",
      { contract: { ...BASE_INPUT.contract, symbol: "WBNB" } },
    ],
    [
      // The calldata is byte for byte identical here; only the number the human
      // read changed. This row is why decimals are in the preimage at all.
      "the contract DECIMALS, which turn the raw amount into the number a human read",
      { contract: { ...BASE_INPUT.contract, decimals: 6 } },
    ],
    ["the raw amount", { amountRaw: "1500000000000000001" }],
    [
      "the payload target",
      { payload: { ...BASE_INPUT.payload, to: "0x8888888888888888888888888888888888888888" } },
    ],
    ["the payload calldata", { payload: { ...BASE_INPUT.payload, data: "0x2e1a7d4d" } }],
    [
      "the payload native VALUE, which is where a wrap's amount actually lives",
      { payload: { ...BASE_INPUT.payload, valueWei: "1" } },
    ],
    [
      "the fee-bounds gas limit",
      { feeBounds: { ...BASE_EIP1559_BOUNDS, gasLimit: "70000" } },
    ],
    [
      "the fee-bounds max fee per gas",
      { feeBounds: { ...BASE_EIP1559_BOUNDS, maxFeePerGasWei: "3000000000" } },
    ],
    [
      "the fee-bounds max priority fee per gas",
      { feeBounds: { ...BASE_EIP1559_BOUNDS, maxPriorityFeePerGasWei: "1500000000" } },
    ],
    [
      "the fee-bounds authorized TOTAL ceiling",
      { feeBounds: { ...BASE_EIP1559_BOUNDS, maxTotalFeeWei: "999000000000000" } },
    ],
    [
      "the fee-bounds pricing MODE",
      {
        feeBounds: {
          mode: "legacy",
          gasLimit: "60000",
          gasPriceWei: "2000000000",
          maxTotalFeeWei: "120000000000000",
        },
      },
    ],
    ["the intent expiry", { expiresAt: "2026-08-28T13:00:00.000Z" }],
  ];

  for (const [name, override] of mutations) {
    it(`changes when ${name} changes`, () => {
      expect(digestOf(override)).not.toBe(BASELINE);
    });
  }

  it("leaves no field of the input unexercised", () => {
    // A guard on the table itself: a new sign-relevant field added to the input
    // without a row above would otherwise be silently uncovered.
    const covered = new Set<string>();
    for (const [, override] of mutations) {
      for (const key of Object.keys(override)) covered.add(key);
    }
    expect([...covered].sort()).toEqual(Object.keys(BASE_INPUT).sort());
  });
});

describe("the digest is a function of the values, not of their spelling", () => {
  it("is stable across key insertion order at every level", () => {
    const reordered: WrapProposalDigestInput = {
      expiresAt: BASE_INPUT.expiresAt,
      feeBounds: {
        maxTotalFeeWei: BASE_EIP1559_BOUNDS.maxTotalFeeWei,
        maxPriorityFeePerGasWei: "1000000000",
        maxFeePerGasWei: "2000000000",
        gasLimit: BASE_EIP1559_BOUNDS.gasLimit,
        mode: "eip1559",
      },
      payload: {
        valueWei: BASE_INPUT.payload.valueWei,
        data: BASE_INPUT.payload.data,
        to: BASE_INPUT.payload.to,
      },
      amountRaw: BASE_INPUT.amountRaw,
      contract: {
        decimals: BASE_INPUT.contract.decimals,
        symbol: BASE_INPUT.contract.symbol,
        address: BASE_INPUT.contract.address,
      },
      direction: BASE_INPUT.direction,
      chainId: BASE_INPUT.chainId,
      chainAlias: BASE_INPUT.chainAlias,
      walletAddress: BASE_INPUT.walletAddress,
      intentId: BASE_INPUT.intentId,
    };
    expect(computeWrapProposalDigest(reordered).digest).toBe(BASELINE);
  });

  it("canonicalizes the signer address case, since EVM hex is case-insensitive", () => {
    expect(digestOf({ walletAddress: BASE_INPUT.walletAddress.toUpperCase().replace("0X", "0x") }))
      .toBe(BASELINE);
  });

  it("stamps the version it was computed under", () => {
    expect(computeWrapProposalDigest(BASE_INPUT).version).toBe(WRAP_PROPOSAL_DIGEST_VERSION);
    expect(BASELINE).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the preimage admits no JS number", () => {
  const preimage = wrapProposalDigestPreimage(BASE_INPUT);

  it("names the table and the version, so a digest cannot cross schemes or rows", () => {
    expect(preimage).toContain(`"digestVersion":"${WRAP_PROPOSAL_DIGEST_VERSION}"`);
    expect(preimage).toContain('"resourceTable":"wallet_wrap_intents"');
  });

  it("carries the numeric chain id and decimals as decimal STRINGS", () => {
    expect(preimage).toContain('"chainId":"8453"');
    expect(preimage).toContain('"decimals":"18"');
  });

  it("contains no bare numeric token anywhere", () => {
    // A JSON number would reintroduce float formatting on the money path: the
    // one thing a digest must not do is depend on how a runtime prints 1e21.
    //
    // Digits legitimately appear INSIDE string values ("1.5", "chain id 8453",
    // a timestamp), so the check removes every JSON string literal first and
    // then requires the structural skeleton that remains to hold no digit at
    // all. What survives may only be braces, brackets, colons, commas and the
    // bare literals `null`, `true` and `false`.
    const skeleton = preimage.replace(/"(?:\\.|[^"\\])*"/g, "");
    expect(skeleton).not.toMatch(/\d/);
    expect(skeleton.replace(/null|true|false/g, "")).toMatch(/^[{}[\]:,]*$/);
  });

  it("embeds the rendered card, so an edited preview_json is detectable", () => {
    expect(preimage).toContain('"preview":');
    expect(preimage).toContain("wrapped-native contract");
  });

  it("distinguishes an absent value from the four characters \"null\"", () => {
    expect(digestOf({ chainAlias: "null" })).not.toBe(digestOf({ chainAlias: "base" }));
  });
});

describe("bindingFromDurableWrapIntent refuses an unknown digest version BY NAME", () => {
  it("names both the stored version and the one this build computes", () => {
    const outcome = bindingFromDurableWrapIntent(
      consistentWrapIntent({ proposalDigestVersion: "v99" }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.code).toBe("invalid_input");
    expect(outcome.refusal.message).toContain("v99");
    expect(outcome.refusal.message).toContain(WRAP_PROPOSAL_DIGEST_VERSION);
    // Not reported as proposal drift: an operator must not be sent looking for
    // an attack that did not happen.
    expect(outcome.refusal.message).not.toMatch(/does not match/);
    expect(outcome.refusal.details).toEqual({
      intentId: "11111111-1111-4111-8111-111111111111",
      storedVersion: "v99",
      supportedVersion: WRAP_PROPOSAL_DIGEST_VERSION,
    });
  });

  it("binds a consistent row to the table, the intent id and the row's own expiry", () => {
    const intent = consistentWrapIntent();
    const outcome = bindingFromDurableWrapIntent(intent);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.value.resource).toEqual({
      table: "wallet_wrap_intents",
      intentId: intent.intentId,
    });
    expect(outcome.value.intentExpiresAt).toBe(intent.expiresAt);
    expect(outcome.value.proposalDigest).toBe(intent.proposalDigest);
  });

  it("refuses a row whose stored card is not the card its own fields render", () => {
    const intent = consistentWrapIntent();
    const outcome = bindingFromDurableWrapIntent({
      ...intent,
      preview: {
        label: intent.preview.label,
        criticalArgs: { ...intent.preview.criticalArgs, slippage: "0.5%" },
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.code).toBe("invalid_input");
    expect(outcome.refusal.message).toContain("the description a user would read was changed");
  });
});
