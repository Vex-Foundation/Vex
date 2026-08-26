/**
 * The versioned proposal digest.
 *
 * The property under test is COVERAGE, not stability: for every sign-relevant
 * field, changing that field alone must change the digest. A digest that moved
 * only with the payload would let the chain, the wallet, the fee ceiling, the
 * decoded effects or the expiry drift under an approval that still verified.
 *
 * The preimage is asserted too, because the digest is a hex string and a hex
 * string is unreadable in a failure. A reviewer needs to see WHAT was hashed.
 */

import { describe, it, expect } from "vitest";

import {
  computeProposalDigest,
  proposalDigestPreimage,
  WALLET_TRANSACTION_INTENTS_RESOURCE,
  type ProposalDigestInput,
} from "@vex-agent/tools/internal/wallet/transaction/proposal-digest.js";
import {
  PROPOSAL_DIGEST_VERSION,
  type DecodedEvmCall,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";

/** Kept separately typed so a spread override stays inside the EVM arm of the
 * decoded union rather than widening to it. */
const BASE_DECODED: DecodedEvmCall = {
  family: "eip155",
  role: "approve",
  standard: "erc20",
  functionName: "approve",
  contract: "0x2222222222222222222222222222222222222222",
  criticalArgs: { spender: "0x3333333333333333333333333333333333333333", amountRaw: "1000" },
  unlimitedApproval: false,
  warnings: [],
};

const BASE_INPUT: ProposalDigestInput = {
  intentId: "wtx-1",
  family: "eip155",
  walletAddress: "0x1111111111111111111111111111111111111111",
  chainAlias: "base",
  chainId: 8453,
  payload: {
    to: "0x2222222222222222222222222222222222222222",
    data: "0xa9059cbb",
    valueWei: "0",
  },
  decoded: BASE_DECODED,
  feeBounds: {
    mode: "eip1559",
    gasLimit: "60000",
    maxFeePerGasWei: "2000000000",
    maxPriorityFeePerGasWei: "1000000000",
    maxTotalFeeWei: "120000000000000",
  },
  recentBlockhash: null,
  lastValidBlockHeight: null,
  expiresAt: "2026-08-24T12:00:00.000Z",
};

function digestOf(overrides: Partial<ProposalDigestInput>): string {
  return computeProposalDigest({ ...BASE_INPUT, ...overrides }).digest;
}

const BASELINE = digestOf({});

describe("the digest covers every sign-relevant field", () => {
  const mutations: readonly [string, Partial<ProposalDigestInput>][] = [
    ["the intent id (a digest may not be replayed against another row)", { intentId: "wtx-2" }],
    ["the wallet address", { walletAddress: "0x9999999999999999999999999999999999999999" }],
    ["the chain alias", { chainAlias: "arbitrum" }],
    ["the numeric chain id", { chainId: 42161 }],
    [
      "the payload target",
      { payload: { ...BASE_INPUT.payload, to: "0x8888888888888888888888888888888888888888" } },
    ],
    ["the payload calldata", { payload: { ...BASE_INPUT.payload, data: "0x095ea7b3" } }],
    ["the payload native value", { payload: { ...BASE_INPUT.payload, valueWei: "1" } }],
    [
      "a decoded argument the user reads on the card",
      {
        decoded: {
          ...BASE_DECODED,
          criticalArgs: { spender: "0x3333333333333333333333333333333333333333", amountRaw: "2000" },
        },
      },
    ],
    [
      "the unlimited-approval flag",
      { decoded: { ...BASE_DECODED, unlimitedApproval: true } },
    ],
    [
      "the fee ceiling",
      {
        feeBounds: {
          mode: "eip1559",
          gasLimit: "60000",
          maxFeePerGasWei: "9000000000",
          maxPriorityFeePerGasWei: "1000000000",
          maxTotalFeeWei: "540000000000000",
        },
      },
    ],
    ["the expiry", { expiresAt: "2026-08-24T13:00:00.000Z" }],
    ["the Solana blockhash evidence", { recentBlockhash: "GfV1", lastValidBlockHeight: 5 }],
  ];

  for (const [name, override] of mutations) {
    it(`changes when ${name} changes`, () => {
      expect(digestOf(override)).not.toBe(BASELINE);
    });
  }

  it("does NOT change when nothing changes", () => {
    expect(digestOf({})).toBe(BASELINE);
  });

  it("is stable under key insertion order", () => {
    // Canonical serialization sorts keys at every depth, so an object built in
    // a different order is the same proposal.
    const reordered: ProposalDigestInput = {
      expiresAt: BASE_INPUT.expiresAt,
      lastValidBlockHeight: BASE_INPUT.lastValidBlockHeight,
      recentBlockhash: BASE_INPUT.recentBlockhash,
      feeBounds: BASE_INPUT.feeBounds,
      decoded: BASE_INPUT.decoded,
      payload: { valueWei: "0", data: "0xa9059cbb", to: BASE_INPUT.payload.to },
      chainId: BASE_INPUT.chainId,
      chainAlias: BASE_INPUT.chainAlias,
      walletAddress: BASE_INPUT.walletAddress,
      family: BASE_INPUT.family,
      intentId: BASE_INPUT.intentId,
    };
    expect(computeProposalDigest(reordered).digest).toBe(BASELINE);
  });

  it("treats EVM wallet address case as insignificant", () => {
    expect(digestOf({ walletAddress: BASE_INPUT.walletAddress.toUpperCase() })).toBe(BASELINE);
  });

  it("preserves Solana wallet address CASE - base58 is case-sensitive (non-blocking #3)", () => {
    const solanaInput: ProposalDigestInput = {
      intentId: "wtx-sol",
      family: "solana",
      walletAddress: "So11111111111111111111111111111111111111112",
      chainAlias: null,
      chainId: null,
      payload: { messageBase64: "QUJD", feePayer: "So11111111111111111111111111111111111111112" },
      decoded: {
        family: "solana",
        role: "spl_instruction_set",
        instructions: [
          {
            program: "system",
            variant: "transfer",
            programId: "11111111111111111111111111111111",
            criticalArgs: { lamports: "1000" },
          },
        ],
        accountKeys: ["So11111111111111111111111111111111111111112"],
        addressTableLookupsResolved: true,
        warnings: [],
      },
      feeBounds: {
        mode: "solana",
        computeUnitLimit: "200000",
        computeUnitPriceMicroLamports: "1000",
        baseFeeLamports: "5000",
        maxPriorityFeeLamports: "200",
        maxTotalFeeLamports: "5200",
      },
      recentBlockhash: "GfV1",
      lastValidBlockHeight: 555,
      expiresAt: "2026-08-24T12:00:00.000Z",
    };
    const preimage = proposalDigestPreimage(solanaInput);
    // The mixed-case base58 pubkey survives verbatim - it is NOT lowercased,
    // which would corrupt it into a different (or colliding) key.
    expect(preimage).toContain("So11111111111111111111111111111111111111112");
    // A case-flipped pubkey is a DIFFERENT wallet and must hash differently.
    const flipped = computeProposalDigest({
      ...solanaInput,
      walletAddress: "so11111111111111111111111111111111111111112",
    });
    expect(flipped.digest).not.toBe(computeProposalDigest(solanaInput).digest);
  });
});

describe("the preimage", () => {
  it("names the version and the resource TABLE, not just the intent id", () => {
    const preimage = proposalDigestPreimage(BASE_INPUT);
    expect(preimage).toContain(`"digestVersion":"${PROPOSAL_DIGEST_VERSION}"`);
    // Two intent tables exist. Binding the digest to the table is what stops a
    // confirm from consuming the other one's row on a matching id.
    expect(preimage).toContain(`"resourceTable":"${WALLET_TRANSACTION_INTENTS_RESOURCE}"`);
  });

  it("contains no JSON numbers at all", () => {
    // A number in the preimage would reintroduce float formatting on the money
    // path: the digest must not depend on how a runtime prints 1e21. Checked by
    // walking the parsed structure rather than by a regex, because an ISO
    // timestamp contains digits after a colon and a regex cannot tell those
    // apart from a numeric value.
    const preimage = proposalDigestPreimage({
      ...BASE_INPUT,
      chainId: 8453,
      lastValidBlockHeight: 987654321,
      recentBlockhash: "GfV1",
    });
    const numericPaths: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === "number") numericPaths.push(path);
      else if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`));
      else if (node !== null && typeof node === "object") {
        for (const [key, item] of Object.entries(node)) walk(item, `${path}.${key}`);
      }
    };
    walk(JSON.parse(preimage), "$");
    expect(numericPaths).toEqual([]);
    expect(preimage).toContain('"chainId":"8453"');
    expect(preimage).toContain('"lastValidBlockHeight":"987654321"');
  });

  it("distinguishes an absent field from the literal string null", () => {
    const asNull = digestOf({ chainAlias: null });
    const asLiteral = digestOf({ chainAlias: "null" });
    // "no chain alias" and "a chain alias literally spelled null" are different
    // proposals: the first is the bare token, the second is JSON-escaped.
    expect(asNull).not.toBe(asLiteral);
  });

  it("stamps the version alongside the digest", () => {
    expect(computeProposalDigest(BASE_INPUT).version).toBe(PROPOSAL_DIGEST_VERSION);
    expect(computeProposalDigest(BASE_INPUT).digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
