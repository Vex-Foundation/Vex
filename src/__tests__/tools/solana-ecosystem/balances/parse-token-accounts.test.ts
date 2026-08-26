/**
 * Projection of `jsonParsed` Solana token accounts into one row per mint.
 *
 * The inputs are the SANITIZED live probe responses of 2026-08-26 (owner
 * address and every ATA pubkey replaced with synthetic base58 of the same
 * length; mints, amounts, decimals, `state`, `extensions` and account `space`
 * preserved verbatim), plus two hand-built accounts for variants no live
 * response carried: a frozen account and a non-numeric `amount`. A projection
 * that reads a field no fixture exercises is a projection nothing is asserting
 * about (rule 10, fixture adequacy).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { projectTokenAccounts, type RawTokenAccountEntry } from "@tools/solana-ecosystem/balances/read-wallet-balances.js";

import splResponse from "../../../fixtures/solana/spl-response.json" with { type: "json" };
import token2022Response from "../../../fixtures/solana/t22-response.json" with { type: "json" };
import frozenFixture from "../../../fixtures/solana/frozen-account.json" with { type: "json" };
import malformedFixture from "../../../fixtures/solana/malformed-amount-account.json" with { type: "json" };
import u8DecimalsFixture from "../../../fixtures/solana/u8-decimals-account.json" with { type: "json" };
import zeroConflictFixture from "../../../fixtures/solana/zero-amount-decimals-conflict.json" with { type: "json" };

/**
 * The fixtures are read through a schema rather than a cast: a fixture that
 * drifts out of the probe shape should fail here, loudly, instead of being
 * asserted through.
 */
const probeAccountSchema = z.object({
  pubkey: z.string(),
  account: z.object({ data: z.unknown() }),
});
const probeResponseSchema = z.object({ result: z.object({ value: z.array(probeAccountSchema) }) });
/** The hand-built fixtures wrap one probe account beside an explanatory note. */
const singleAccountFixtureSchema = z.object({ account: probeAccountSchema });
const parsedInfoSchema = z.object({ parsed: z.object({ info: z.object({ mint: z.string() }) }) });
/** Every field the projection reads, so a re-parsed account stays projectable. */
const tokenAccountDataSchema = z.object({
  parsed: z.object({
    type: z.string(),
    info: z.object({
      mint: z.string(),
      owner: z.string(),
      state: z.string(),
      tokenAmount: z.object({ amount: z.string(), decimals: z.number() }),
    }),
  }),
});

function entriesOf(response: unknown): RawTokenAccountEntry[] {
  return probeResponseSchema
    .parse(response)
    .result.value.map((account) => ({ pubkey: account.pubkey, data: account.account.data }));
}

function entryOf(fixture: unknown): RawTokenAccountEntry {
  const { account } = singleAccountFixtureSchema.parse(fixture);
  return { pubkey: account.pubkey, data: account.account.data };
}

const LIVE_ENTRIES: RawTokenAccountEntry[] = [
  ...entriesOf(splResponse),
  ...entriesOf(token2022Response),
];

const JLP = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const NFT_LIKE = "4vHCzjiwUmcPHDpCaF5tD3bhbrkw2kDbKQoE4bvvXzy4";
const TOKEN_2022_MINT = "58Cf5RWZM8dhPgTTUYWk7FyDFFvV3Vf4Rhv6f1Zvpump";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("projectTokenAccounts (live probe fixtures)", () => {
  it("turns 12 probed accounts into 8 non-zero mint rows, 4 zero accounts skipped", () => {
    const projection = projectTokenAccounts(LIVE_ENTRIES);

    expect(LIVE_ENTRIES).toHaveLength(12);
    expect(projection.failures).toEqual([]);
    expect(projection.zeroSkipped).toBe(4);
    expect(projection.frozenAccounts).toBe(0);
    expect(projection.holdings).toHaveLength(8);
    expect(projection.holdings.every((holding) => holding.amountRaw !== "0")).toBe(true);
  });

  it("keeps every u64 amount as its exact string, and decimals from the account", () => {
    const byMint = new Map(projectTokenAccounts(LIVE_ENTRIES).holdings.map((h) => [h.mint, h]));
    expect(byMint.get(JLP)).toMatchObject({ amountRaw: "1110870", decimals: 6, accountCount: 1 });
    // 15 significant digits: exactly the range where a float round-trip starts
    // to lie, which is why the amount never passes through `Number`.
    expect(byMint.get("2dnH9aPEtnJ2PcGvCUqmGH8xq4PZzwZJrBf6aiDJJ5eC")?.amountRaw).toBe("478930624197716");
  });

  it("keeps an NFT-shaped holding (amount 1, decimals 0) as an ordinary row", () => {
    const holding = projectTokenAccounts(LIVE_ENTRIES).holdings.find((h) => h.mint === NFT_LIKE);
    expect(holding).toMatchObject({ amountRaw: "1", decimals: 0, frozen: false });
  });

  it("projects Token-2022 accounts identically despite their extensions block", () => {
    const holding = projectTokenAccounts(LIVE_ENTRIES).holdings.find((h) => h.mint === TOKEN_2022_MINT);
    expect(holding).toMatchObject({ amountRaw: "964105", decimals: 6, accountCount: 1 });
  });

  it("sums duplicate ATAs for one mint into a single row", () => {
    const duplicated = [
      ...LIVE_ENTRIES,
      ...LIVE_ENTRIES.filter((entry) => parsedInfoSchema.parse(entry.data).parsed.info.mint === JLP),
    ];
    const projection = projectTokenAccounts(duplicated);
    const holding = projection.holdings.find((h) => h.mint === JLP);
    expect(holding).toMatchObject({ amountRaw: "2221740", accountCount: 2 });
    expect(projection.holdings).toHaveLength(8);
  });

  it("keeps a frozen holding and counts it", () => {
    const projection = projectTokenAccounts([entryOf(frozenFixture)]);
    expect(projection.frozenAccounts).toBe(1);
    expect(projection.holdings).toEqual([
      { mint: BONK, amountRaw: "250000", decimals: 5, frozen: true, accountCount: 1 },
    ]);
  });

  it("reports a non-numeric amount as a FAILURE, never as a zero balance", () => {
    const projection = projectTokenAccounts([entryOf(malformedFixture)]);
    expect(projection.failures).toEqual([
      { pubkey: "B3S5sj9HLTTNT2eAYN8UFgA49utunRnmtVuXgfTGBvqs", reason: "schema-parse-failed" },
    ]);
    expect(projection.zeroSkipped).toBe(0);
    expect(projection.holdings).toEqual([]);
  });

  it("fails closed when two accounts claim different decimals for one mint", () => {
    const [first] = LIVE_ENTRIES;
    if (!first) throw new Error("fixture is empty");
    const conflicting: RawTokenAccountEntry = {
      pubkey: "CoNf1ictAccountPubkey11111111111111111111111",
      data: structuredClone(first.data),
    };
    const mutable = tokenAccountDataSchema.parse(conflicting.data);
    mutable.parsed.info.tokenAmount.decimals = 9;
    conflicting.data = mutable;
    const projection = projectTokenAccounts([first, conflicting]);
    expect(projection.failures).toEqual([
      { pubkey: "CoNf1ictAccountPubkey11111111111111111111111", reason: "mint-decimals-conflict" },
    ]);
  });

  it("accepts decimals at the top of the SPL mint's u8 range (255)", () => {
    // The Mint account stores `decimals` as a u8, so 255 is legal on-chain. The
    // old <= 32 cap would have turned this account into a schema failure, and a
    // failure makes the sync owner skip the WHOLE chain.
    const projection = projectTokenAccounts([entryOf(u8DecimalsFixture)]);
    expect(projection.failures).toEqual([]);
    expect(projection.holdings).toEqual([
      {
        mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
        amountRaw: "7",
        decimals: 255,
        frozen: false,
        accountCount: 1,
      },
    ]);
  });

  it("rejects decimals above the u8 range as a schema failure", () => {
    const entry = entryOf(u8DecimalsFixture);
    const mutable = tokenAccountDataSchema.parse(structuredClone(entry.data));
    mutable.parsed.info.tokenAmount.decimals = 256;
    const projection = projectTokenAccounts([{ pubkey: entry.pubkey, data: mutable }]);
    expect(projection.failures).toEqual([
      { pubkey: entry.pubkey, reason: "schema-parse-failed" },
    ]);
    expect(projection.holdings).toEqual([]);
  });

  it("reports a ZERO account whose decimals conflict with a held account of the same mint", () => {
    // The zero account used to be skipped before the agreement check, so this
    // self-contradicting response passed as a clean read.
    const projection = projectTokenAccounts([entryOf(frozenFixture), entryOf(zeroConflictFixture)]);
    expect(projection.failures).toEqual([
      { pubkey: "ZeroConf1ictAccountPubkey111111111111111111", reason: "mint-decimals-conflict" },
    ]);
    // A conflicting account is a failure and NOTHING else: never zero-skipped.
    expect(projection.zeroSkipped).toBe(0);
    expect(projection.holdings).toEqual([
      { mint: BONK, amountRaw: "250000", decimals: 5, frozen: true, accountCount: 1 },
    ]);
  });

  it("reports the conflict in the same way when the ZERO account arrives FIRST", () => {
    // Order independence matters: the first account seen sets the mint's
    // decimals, and either ordering must still fail closed rather than write a
    // holding at whichever spelling happened to arrive first.
    const projection = projectTokenAccounts([entryOf(zeroConflictFixture), entryOf(frozenFixture)]);
    expect(projection.failures).toEqual([
      { pubkey: "CKMW8Bz4GMqQ4rN49AswqiEaQiCSXJ6tk5933e5HTmoc", reason: "mint-decimals-conflict" },
    ]);
    expect(projection.holdings).toEqual([]);
    expect(projection.zeroSkipped).toBe(1);
    expect(projection.frozenAccounts).toBe(0);
  });

  it("rejects an account whose parsed type is not a token account", () => {
    const projection = projectTokenAccounts([
      { pubkey: "M1ntAccountPubkey1111111111111111111111111111", data: { parsed: { type: "mint", info: {} } } },
    ]);
    expect(projection.failures).toHaveLength(1);
    expect(projection.holdings).toEqual([]);
  });
});
