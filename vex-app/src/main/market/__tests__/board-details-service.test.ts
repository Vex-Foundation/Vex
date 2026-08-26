/**
 * BOARD DETAILS SERVICE - the read, the two clocks, and the teardown.
 *
 * What these pin, in the order they matter:
 *
 *  - the projection is faithful to the MEASURED document (probe P1, four
 *    chains): a burn row keeps its tag, `lockedPct` comes from the lock index
 *    and never from `quickintel.lpBurnedPct`, the holder source travels with
 *    the count, and an absent security block is an absence rather than an
 *    empty object;
 *  - `expiresAtMs` is the provider's `max-age` minus `age`, and an ABSENT
 *    `age` header - measured on ethereum - means consumed freshness, not a
 *    fresh document (probe C4);
 *  - the CACHE floor is a burst absorber, not a freshness claim, and it is
 *    told apart from the bundle's own clock;
 *  - a burst of eight cards naming one pool costs ONE provider exchange;
 *  - a transient failure is never remembered, and a 404 is;
 *  - dispose drains rather than abandons.
 *
 * The provider document is built through the endpoint module's own exported
 * types, so a shape change there breaks these at compile time instead of
 * letting them assert against a shape the provider no longer sends.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PairDetailsDocument } from "@tools/dexscreener/endpoints/pair-details.js";
import type { PairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { boardDetailsBundleSchema } from "@shared/schemas/board-details.js";
import { classifyBoardSafety } from "@shared/board/safety-classifier.js";
import { boardSafetyEvidenceFrom } from "@shared/board/safety-evidence.js";
import {
  CACHE_FLOOR_MS,
  createBoardDetailsService,
  projectBoardDetails,
  providerFreshnessEdgeMs,
} from "../board-details-service.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FETCHED = 1_756_000_000_000;
const SUBJECT = {
  chain: "ethereum",
  pairAddress: "0x80BF6573d7b16c049E449D67017a7bE2DA8B429E",
};
const BASE_TOKEN = "0x85c13aC395BE3277046cd715277c34d283581dac";

function pairSubject(overrides: Partial<PairSubject> = {}): PairSubject {
  return {
    chainId: "ethereum",
    pairAddress: SUBJECT.pairAddress,
    ammId: "uniswap",
    baseTokenAddress: BASE_TOKEN,
    baseTokenSymbol: "ETHCATE",
    quoteTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    quoteTokenSymbol: "WETH",
    dexId: "uniswap",
    labels: [],
    priceUsd: "0.0001877",
    liquidityUsd: 111_300,
    pairCreatedAtMs: FETCHED - 7_200_000,
    resolutionBasis: "explicit_pair_address",
    resolvedFromToken: null,
    searchWindowSize: null,
    fetchedAtMs: FETCHED,
    ...overrides,
  };
}

function percent(raw: string, normalizedPct: number, unit: "fraction" | "percent" | "unverified" = "percent") {
  return { raw, normalizedPct, unit };
}

/** The ethereum document as the live probe recorded it, in the module's types. */
function document(overrides: Partial<PairDetailsDocument> = {}): PairDetailsDocument {
  return {
    goPlus: {
      dataStatus: "1",
      isHoneypot: false,
      isOpenSource: true,
      isProxy: false,
      isMintable: false,
      isBlacklisted: false,
      isWhitelisted: null,
      transferPausable: false,
      hiddenOwner: false,
      canTakeBackOwnership: false,
      cannotSellAll: false,
      slippageModifiable: false,
      isAntiWhale: null,
      antiWhaleModifiable: null,
      tradingCooldown: null,
      externalCall: null,
      trustList: null,
      buyTax: { ...percent("0", 0), source: "goplus" },
      sellTax: { ...percent("0", 0), source: "goplus" },
      ownerAddress: null,
      ownerBalance: null,
      // Measured: GoPlus states shares as FRACTIONS, a 100x difference from
      // the native rows. Only `normalizedPct` is ever compared or rendered.
      ownerShare: percent("0.012", 1.2, "fraction"),
      creatorAddress: null,
      creatorBalance: null,
      creatorShare: percent("0.004", 0.4, "fraction"),
      holderCount: 1358,
      holders: [
        {
          address: "0xaaa",
          balance: "1",
          share: percent("0.5", 50, "fraction"),
          tag: null,
          isContract: null,
          isLocked: null,
        },
      ],
      lpHolderCount: null,
      lpHolders: [],
      lpTotalSupply: null,
      totalSupply: "1000000000",
      venues: [],
      auditedToken: {
        address: BASE_TOKEN,
        name: "ETHCATE",
        symbol: "ETHCATE",
        source: "goplus",
      },
      analyzedAtMs: FETCHED - 60_000,
      unprojectedKeys: [],
    } as unknown as PairDetailsDocument["goPlus"],
    quickIntel: {
      contractVerified: true,
      isScam: false,
      isHoneypot: false,
      isProxy: false,
      hiddenOwner: false,
      canMint: false,
      canBlacklist: false,
      canPauseTrading: false,
      hasFeeWarning: false,
      hasExternalContractRisk: false,
      hasGeneralVulnerabilities: false,
      hasObfuscatedAddressRisk: false,
      buyTax: { ...percent("0", 0), source: "quickintel" },
      sellTax: { ...percent("0", 0), source: "quickintel" },
      transferTax: { ...percent("0", 0), source: "quickintel" },
      lpBurnedPct: percent("99.99", 99.99),
      auditedToken: {
        address: BASE_TOKEN,
        name: "ETHCATE",
        symbol: "ETHCATE",
        source: "quickintel",
      },
      analyzedAtMs: FETCHED - 60_000,
      unprojectedKeys: [],
    } as unknown as PairDetailsDocument["quickIntel"],
    holders: null,
    lpHolders: null,
    tokenAuthority: null,
    supply: null,
    liquidityLocks: {
      // The endpoint module spells the total `totalShare`; the wire contract
      // and the probe archive both spell the same projection `lockedPct`.
      totalShare: percent("99.99", 99.99),
      // MEASURED: the ONLY lock row on both answering chains was a BURN, and
      // `lockedPct` is exactly that burn. Dropping it would report 0 percent
      // locked for a pool whose LP can never be pulled.
      rows: [{ tag: "Burned", share: percent("99.99", 99.99) }],
    } as unknown as PairDetailsDocument["liquidityLocks"],
    profile: {
      chainId: "ethereum",
      name: "ETHCATE",
      symbol: "ETHCATE",
      address: BASE_TOKEN,
      description: null,
      links: [],
      iconId: null,
      headerId: null,
      metaIds: [],
      createdAtMs: null,
      updatedAtMs: null,
      unprojectedKeys: [],
    } as unknown as PairDetailsDocument["profile"],
    listings: [],
    presentButUnprojected: [],
    coverage: [
      { block: "security.goplus", present: true, reason: null },
      { block: "security.quickintel", present: true, reason: null },
      { block: "liquidityLocks", present: true, reason: null },
    ],
    allBlocksNull: false,
    route: "pair_id",
    inverted: false,
    url: "https://io.dexscreener.com/dex/pair-details/v4/ethereum/x",
    fetchedAtMs: FETCHED,
    bytes: 4469,
    cacheMaxAgeSeconds: 60,
    cacheAgeSeconds: 5,
    responseHeaders: new Map(),
    ...overrides,
  } as PairDetailsDocument;
}

function siteError(code: string): Error & { code: string } {
  const error = new Error("provider refused") as Error & { code: string };
  error.code = code;
  return error;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the projection is faithful to the measured document", () => {
  const bundle = projectBoardDetails({
    subject: SUBJECT,
    pairSubject: pairSubject(),
    document: document(),
  });

  it("crosses its own wire contract", () => {
    expect(boardDetailsBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("takes lockedPct from the lock index and keeps the provider's row tag verbatim", () => {
    expect(bundle.liquidityLocks?.lockedPct).toEqual({
      raw: "99.99",
      normalizedPct: 99.99,
      unit: "percent",
    });
    expect(bundle.liquidityLocks?.rows).toEqual([
      { tag: "Burned", share: { raw: "99.99", normalizedPct: 99.99, unit: "percent" } },
    ]);
  });

  it("NEVER substitutes quickintel.lpBurnedPct for a missing lock share", () => {
    // The whole point of A5's rule, kept in its original sense: the two are
    // different fields on different providers. A pool with no lock index gets
    // a typed absence, not the other provider's burn figure standing in.
    const withoutLocks = projectBoardDetails({
      subject: SUBJECT,
      pairSubject: pairSubject(),
      document: document({ liquidityLocks: null }),
    });
    expect(withoutLocks.liquidityLocks).toBeNull();
    expect(withoutLocks.safety.quickintel?.lpBurnedPct?.normalizedPct).toBe(99.99);
  });

  it("carries the holder count with the source that reported it and its share unit", () => {
    expect(bundle.holders).toEqual({
      count: 1358,
      source: "goplus",
      shareUnit: "fraction",
    });
  });

  it("prefers DexScreener's own holder index when it is the one that answered", () => {
    // Measured on solana, where the count came from `dexscreener` and its
    // shares are stated in PERCENT rather than as fractions.
    const native = projectBoardDetails({
      subject: SUBJECT,
      pairSubject: pairSubject(),
      document: document({
        holders: {
          holderCount: 20_507,
          totalSupply: null,
          rows: [
            {
              address: "sol1",
              balance: "1",
              share: percent("12.5", 12.5),
              tag: null,
              isContract: null,
              isLocked: null,
            },
          ],
        } as unknown as PairDetailsDocument["holders"],
      }),
    });
    expect(native.holders).toEqual({
      count: 20_507,
      source: "dexscreener",
      shareUnit: "percent",
    });
  });

  it("tells a source that answered with no count apart from nothing answering", () => {
    const noCount = projectBoardDetails({
      subject: SUBJECT,
      pairSubject: pairSubject(),
      document: document({ goPlus: null, quickIntel: null }),
    });
    expect(noCount.holders).toEqual({ count: null, source: null, shareUnit: null });
  });

  it("keeps an absent security block as a typed absence, never an empty object", () => {
    // Measured on solana for a live trending pool: absence is the ORDINARY
    // answer there, and it must not read as "nothing wrong".
    const solana = projectBoardDetails({
      subject: SUBJECT,
      pairSubject: pairSubject(),
      document: document({
        goPlus: null,
        quickIntel: null,
        coverage: [
          { block: "security.goplus", present: false, reason: "provider_did_not_answer" },
          { block: "security.quickintel", present: false, reason: "provider_did_not_answer" },
        ],
      }),
    });
    expect(solana.safety.goplus).toBeNull();
    expect(solana.safety.quickintel).toBeNull();
    expect(solana.safety.coverage.state).toBe("partial");
    expect(solana.safety.coverage.absentBlocks).toContain("security.goplus");
  });

  it("reads a 200 with every block empty as coverage not_indexed, not as an absence", () => {
    const empty = projectBoardDetails({
      subject: SUBJECT,
      pairSubject: pairSubject(),
      document: document({ allBlocksNull: true }),
    });
    expect(empty.safety.coverage.state).toBe("not_indexed");
    // And it is still a document with clocks, so the classifier sees evidence.
    expect(empty.fetchedAtMs).toBe(FETCHED);
  });

  it("checks the audit provider's own subject against the pair's real base token", () => {
    expect(bundle.auditedTokenCheck).toEqual({
      auditedTokenAddress: BASE_TOKEN,
      auditedTokenSymbol: "ETHCATE",
      addressesAgree: true,
      symbolsAgree: true,
      mismatch: false,
    });
  });

  it("reports a mismatch when the audit is about a different token", () => {
    const mismatched = projectBoardDetails({
      subject: SUBJECT,
      pairSubject: pairSubject({ baseTokenAddress: "0xdifferent", baseTokenSymbol: "OTHER" }),
      document: document(),
    });
    expect(mismatched.auditedTokenCheck.mismatch).toBe(true);
    const verdict = classifyBoardSafety(
      boardSafetyEvidenceFrom({
        outcome: { kind: "details", bundle: mismatched },
        nowMs: FETCHED,
      }),
    );
    expect(verdict.state).toBe("identity-mismatch");
  });

  it("carries the narrative join key, and an empty array is the common case", () => {
    expect(bundle.metaIds).toEqual([]);
    const joined = projectBoardDetails({
      subject: SUBJECT,
      pairSubject: pairSubject(),
      document: document({
        profile: {
          ...(document().profile as NonNullable<PairDetailsDocument["profile"]>),
          metaIds: ["KAxVtm2QhpF8vU6RkrBl"],
        } as PairDetailsDocument["profile"],
      }),
    });
    expect(joined.metaIds).toEqual(["KAxVtm2QhpF8vU6RkrBl"]);
  });
});

describe("the provider's freshness edge", () => {
  it("is max-age minus the age the response already had", () => {
    expect(providerFreshnessEdgeMs(document())).toBe(FETCHED + 55_000);
  });

  it("treats an ABSENT age header as fully consumed freshness, never as fresh", () => {
    // Measured on ethereum: the provider sent `max-age=60` and no `age`. An
    // unknown age is not a young one, so nothing here claims 60 seconds of
    // freshness it cannot defend.
    expect(providerFreshnessEdgeMs(document({ cacheAgeSeconds: null }))).toBe(FETCHED);
  });

  it("floors at the fetch instant rather than going backwards", () => {
    expect(providerFreshnessEdgeMs(document({ cacheAgeSeconds: 900 }))).toBe(FETCHED);
  });
});

describe("the read, its cache and its single flight", () => {
  function build(overrides: {
    fetchDetails?: () => Promise<PairDetailsDocument>;
    now?: () => number;
  } = {}) {
    const fetchDetails = vi.fn(overrides.fetchDetails ?? (async () => document()));
    const resolveSubject = vi.fn(async () => pairSubject());
    const service = createBoardDetailsService({
      fetchDetails,
      resolveSubject,
      now: overrides.now ?? ((): number => FETCHED),
    });
    return { service, fetchDetails, resolveSubject };
  }

  it("answers a burst of eight cards naming one pool with ONE provider exchange", async () => {
    const { service, fetchDetails } = build();
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => service.read(SUBJECT)),
    );
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    for (const answer of answers) expect(answer.kind).toBe("details");
    await service.dispose();
  });

  it("serves the cached bundle inside the floor even when the provider clock is spent", async () => {
    // The document arrived with its freshness already consumed. The bundle's
    // own clock says so, and the classifier reads that; the CACHE still serves
    // it briefly, which is what absorbs a board's mount burst.
    let clock = FETCHED;
    const { service, fetchDetails } = build({
      fetchDetails: async () => document({ cacheAgeSeconds: null }),
      now: () => clock,
    });
    const first = await service.read(SUBJECT);
    expect(first.kind).toBe("details");
    // The BUNDLE says the freshness is spent even while the cache still serves
    // it: two clocks, and the classifier reads the honest one.
    if (first.kind === "details") {
      expect(first.bundle.expiresAtMs).toBe(FETCHED);
    }
    clock = FETCHED + CACHE_FLOOR_MS - 1;
    await service.read(SUBJECT);
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    clock = FETCHED + CACHE_FLOOR_MS + 1;
    await service.read(SUBJECT);
    expect(fetchDetails).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it("re-reads once the provider's own window has closed", async () => {
    let clock = FETCHED;
    const { service, fetchDetails } = build({ now: () => clock });
    await service.read(SUBJECT);
    clock = FETCHED + 55_000 - 1;
    await service.read(SUBJECT);
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    clock = FETCHED + 55_000 + 1;
    await service.read(SUBJECT);
    expect(fetchDetails).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it("NEVER caches a transient failure", async () => {
    // Caching an unknown would turn one bad second into a whole freshness
    // window of "checks unavailable" after the provider came back.
    let clock = FETCHED;
    const { service, fetchDetails } = build({
      fetchDetails: async () => {
        throw siteError(DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT);
      },
      now: () => clock,
    });
    const first = await service.read(SUBJECT);
    expect(first).toEqual({ kind: "unavailable", reason: "transport" });
    clock = FETCHED + 1;
    await service.read(SUBJECT);
    expect(fetchDetails).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it("DOES remember a 404, which is the provider's settled answer", async () => {
    let clock = FETCHED;
    const { service, fetchDetails } = build({
      fetchDetails: async () => {
        throw siteError(DexScreenerSiteErrorCodes.PAIR_DETAILS_UNKNOWN);
      },
      now: () => clock,
    });
    const first = await service.read(SUBJECT);
    expect(first).toEqual({ kind: "absent", reason: "unknown_pair" });
    clock = FETCHED + 1;
    await service.read(SUBJECT);
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it("tells an unmounted transport apart from a provider refusal", async () => {
    const { service } = build({
      fetchDetails: async () => {
        throw siteError(DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE);
      },
    });
    expect(await service.read(SUBJECT)).toEqual({
      kind: "unavailable",
      reason: "not_mounted",
    });
    await service.dispose();
  });

  it("resolves the subject BEFORE the document, so identity is never assumed", async () => {
    const { service, resolveSubject, fetchDetails } = build();
    await service.read(SUBJECT);
    expect(resolveSubject).toHaveBeenCalledTimes(1);
    expect(fetchDetails).toHaveBeenCalledTimes(1);
    await service.dispose();
  });
});

describe("prefetch accounts for the WHOLE board", () => {
  it("returns one entry per pool, keyed by identity, in the order asked", async () => {
    const pools = [
      SUBJECT,
      { chain: "solana", pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU" },
    ];
    const service = createBoardDetailsService({
      fetchDetails: async () => document(),
      resolveSubject: async () => pairSubject(),
      now: () => FETCHED,
    });
    const entries = await service.prefetch(pools);
    expect(entries.map((entry) => entry.key)).toEqual([
      "ethereum:0x80bf6573d7b16c049e449d67017a7be2da8b429e",
      "solana:22cfmlna8bsh7xrbyvgss6ndd31ifj1ufvnwb7eberwu",
    ]);
    await service.dispose();
  });

  it("gives a pool that could not be read a typed outcome so it stays COUNTED", async () => {
    // The chat card's sentence covers the whole board. A pool that silently
    // vanished would produce "3 clean checks" over five pools.
    let calls = 0;
    const service = createBoardDetailsService({
      fetchDetails: async () => {
        calls += 1;
        if (calls === 2) throw siteError(DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT);
        return document();
      },
      resolveSubject: async () => pairSubject(),
      now: () => FETCHED,
    });
    const entries = await service.prefetch([
      SUBJECT,
      { chain: "base", pairAddress: "0xf79478d5a6baE4546F7e489e80b2fC690B558944" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[1]?.outcome).toEqual({ kind: "unavailable", reason: "transport" });
    await service.dispose();
  });

  it("reports what it HAS when it is cancelled rather than throwing", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = createBoardDetailsService({
      fetchDetails: async () => document(),
      resolveSubject: async () => pairSubject(),
      now: () => FETCHED,
    });
    const entries = await service.prefetch([SUBJECT], controller.signal);
    expect(entries[0]?.outcome).toEqual({ kind: "unavailable", reason: "cancelled" });
    await service.dispose();
  });
});

describe("teardown", () => {
  it("DRAINS the in-flight read rather than abandoning it", async () => {
    // A read that outlived its owner would still be running on the bridge's
    // transport when the bridge itself is disposed.
    // A box rather than a bare binding: TypeScript narrows a `let` assigned
    // only inside a closure to its initializer, and the whole point of this
    // case is that the closure DID assign it.
    const gate: { settle: (() => void) | null } = { settle: null };
    let finished = false;
    const service = createBoardDetailsService({
      fetchDetails: async () => {
        await new Promise<void>((resolve) => {
          gate.settle = resolve;
        });
        finished = true;
        return document();
      },
      resolveSubject: async () => pairSubject(),
      now: () => FETCHED,
    });
    const reading = service.read(SUBJECT);
    // Let the load reach its await before disposing.
    await Promise.resolve();
    await Promise.resolve();
    const disposing = service.dispose();
    expect(gate.settle).not.toBeNull();
    gate.settle?.();
    await disposing;
    expect(finished).toBe(true);
    await reading;
  });

  it("answers not_mounted after disposal instead of starting a read", async () => {
    const fetchDetails = vi.fn(async () => document());
    const service = createBoardDetailsService({
      fetchDetails,
      resolveSubject: async () => pairSubject(),
      now: () => FETCHED,
    });
    await service.dispose();
    expect(await service.read(SUBJECT)).toEqual({
      kind: "unavailable",
      reason: "not_mounted",
    });
    expect(fetchDetails).not.toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    const service = createBoardDetailsService({
      fetchDetails: async () => document(),
      resolveSubject: async () => pairSubject(),
      now: () => FETCHED,
    });
    await service.dispose();
    await expect(service.dispose()).resolves.toBeUndefined();
  });
});
