/**
 * The pair-details parser, against two real captured documents from two chain
 * classes.
 *
 * The assertions that matter here are unit assertions. This channel is the
 * pre-trade safety read, so the two failures worth catching are a percentage
 * read in the wrong unit (wrong by 100x) and an unanswered document rendered
 * as a clean one. Both are asserted directly against the captures.
 */

import { describe, expect, it } from "vitest";
import {
  parsePairDetails,
  pairDetailsUrl,
} from "@tools/dexscreener/endpoints/pair-details.js";
import { loadJsonFixture } from "./_fixtures.js";

const PAIR_ROUTE = { route: "pair_id", inverted: false } as const;

function ethereum(): ReturnType<typeof parsePairDetails> {
  return parsePairDetails(
    loadJsonFixture("pair-details-ethereum-pepe").bytes,
    PAIR_ROUTE
  );
}

function solana(): ReturnType<typeof parsePairDetails> {
  return parsePairDetails(
    loadJsonFixture("pair-details-solana-live").bytes,
    PAIR_ROUTE
  );
}

describe("pair-details URL", () => {
  it("lowercases the WHOLE path, which the endpoint requires", () => {
    expect(
      pairDetailsUrl("Ethereum", "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f", false)
    ).toBe(
      "https://io.dexscreener.com/dex/pair-details/v4/ethereum/0xa43fe16908251ee70ef74718545e4fe6c5ccec9f"
    );
  });

  it("appends inverted=1 only when the report is about the quote token", () => {
    expect(pairDetailsUrl("solana", "Abc", false)).not.toContain("inverted");
    expect(pairDetailsUrl("solana", "Abc", true)).toContain("?inverted=1");
  });
});

describe("percentage units are normalized per source and never mixed", () => {
  it("reads a GoPlus holder share as a FRACTION: 0.0868... becomes 8.68 percent", () => {
    const holder = ethereum().goPlus?.holders[0];
    // The captured raw value, unchanged, next to the normalized one.
    expect(holder?.share?.raw).toBe("0.086817222047280560");
    expect(holder?.share?.unit).toBe("fraction");
    expect(holder?.share?.normalizedPct).toBeCloseTo(8.6817222, 5);
  });

  it("reads a DexScreener holder share as ALREADY a percent: 5.44 stays 5.44", () => {
    const holder = solana().holders?.rows[0];
    expect(holder?.share?.raw).toBe("5.44");
    expect(holder?.share?.unit).toBe("percent");
    expect(holder?.share?.normalizedPct).toBe(5.44);
  });

  it("keeps the two units far enough apart that a 100x error cannot hide", () => {
    // The same numeric magnitude means two different things on the two blocks.
    // This is the whole hazard, asserted as one comparison.
    const goPlusShare = ethereum().goPlus?.holders[0]?.share;
    const nativeShare = solana().holders?.rows[0]?.share;
    expect(goPlusShare?.unit).not.toBe(nativeShare?.unit);
    expect(Number(goPlusShare?.raw)).toBeLessThan(1);
    expect(goPlusShare?.normalizedPct).toBeGreaterThan(1);
  });

  it("carries GoPlus owner and creator shares in the same normalized form", () => {
    const gp = ethereum().goPlus;
    expect(gp?.ownerShare).toEqual({
      raw: "0.0",
      normalizedPct: 0,
      unit: "fraction",
    });
    expect(gp?.creatorShare?.unit).toBe("fraction");
  });

  it("reads a GoPlus tax as the FRACTION it is, against a document that can tell", () => {
    // The 100x class, on the money path, in the direction that makes a taxed
    // token look clean. GoPlus and QuickIntel describe the SAME 4 percent buy
    // tax on this token in two different scales: gp "0.04" and qi "4.0". Every
    // other committed pair-details capture carries a tax of 0 or null, which
    // cannot discriminate a fraction from a percent, so reading gp as
    // percent-scaled looked correct against all of them and rendered a 4
    // percent tax as 0.04 percent here.
    const taxed = parsePairDetails(
      loadJsonFixture("pair-details-goplus-fraction-tax").bytes,
      PAIR_ROUTE
    );
    expect(taxed.goPlus?.buyTax).toEqual({
      raw: "0.04",
      normalizedPct: 4,
      unit: "fraction",
      source: "goplus",
    });
    // The independent auditor's number for the same fact, in its own scale.
    expect(taxed.quickIntel?.buyTax).toEqual({
      raw: "4.0",
      normalizedPct: 4,
      unit: "percent",
      source: "quickintel",
    });
    // The point of normalizing at all: after it, the two auditors AGREE.
    expect(taxed.goPlus?.buyTax?.normalizedPct).toBe(
      taxed.quickIntel?.buyTax?.normalizedPct
    );
  });

  it("names the source on every tax value, because the two providers differ", () => {
    const parsed = ethereum();
    expect(parsed.goPlus?.buyTax?.source).toBe("goplus");
    expect(parsed.quickIntel?.buyTax?.source).toBe("quickintel");
    expect(parsed.quickIntel?.sellTax).toEqual({
      raw: "0.0",
      normalizedPct: 0,
      unit: "percent",
      source: "quickintel",
    });
  });
});

describe("an all-null 200 is not_indexed_yet and never a pass", () => {
  it("flags a document whose every known block is null", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        gp: null, qi: null, holders: null, lpHolders: null, ta: null,
        ll: null, su: null, cms: null, cg: null, cmc: null, ts: null,
        ti: null, hpi: null,
      })
    );
    const parsed = parsePairDetails(body, PAIR_ROUTE);
    expect(parsed.allBlocksNull).toBe(true);
    for (const entry of parsed.coverage) {
      expect(entry.present).toBe(false);
      expect(entry.reason).toBe("not_indexed_yet");
    }
    // Nothing in the parsed document reads as a passed audit.
    expect(parsed.goPlus).toBeNull();
    expect(parsed.quickIntel).toBeNull();
  });

  it("does not flag a real document, and reports absent blocks differently", () => {
    const parsed = solana();
    expect(parsed.allBlocksNull).toBe(false);
    const goPlus = parsed.coverage.find((c) => c.block === "security.goplus");
    expect(goPlus).toEqual({
      block: "security.goplus",
      present: false,
      reason: "provider_did_not_answer",
    });
  });
});

describe("coverage comes from the response", () => {
  it("reports the EVM class: audits present, native holder block absent", () => {
    const parsed = ethereum();
    expect(parsed.goPlus).not.toBeNull();
    expect(parsed.quickIntel).not.toBeNull();
    expect(parsed.holders).toBeNull();
    // The corrected v1.1 fact: GoPlus DOES return holders on EVM.
    expect(parsed.goPlus?.holders).toHaveLength(10);
    expect(parsed.goPlus?.lpHolders).toHaveLength(10);
    expect(parsed.goPlus?.holderCount).toBe(580_992);
  });

  it("reports the Solana class: holders and authority present, no audits", () => {
    const parsed = solana();
    expect(parsed.goPlus).toBeNull();
    expect(parsed.quickIntel).toBeNull();
    expect(parsed.holders?.rows).toHaveLength(40);
    expect(parsed.tokenAuthority).toEqual({
      solanaMintable: false,
      solanaFreezable: false,
      solanaBridgeMintOnly: null,
      solanaMintableReason: null,
    });
  });

  it("projects the root lpHolders block the first recon pass recorded as null", () => {
    const parsed = solana();
    expect(parsed.lpHolders?.rows).toHaveLength(30);
    expect(parsed.lpHolders?.rows[0]?.share?.normalizedPct).toBe(98.13);
    // Coverage names the SOURCE of the holder rows: the native block and the
    // GoPlus block are different blocks with different units, and one row for
    // both was measured reporting "absent" on a response carrying ten GoPlus
    // rows. See pair-details-safety.test.ts for that regression.
    expect(
      parsed.coverage.find((entry) => entry.block === "lpHolders.native")?.present
    ).toBe(true);
  });
});

describe("the remaining blocks", () => {
  it("carries liquidity locks with their tag and share", () => {
    const locks = solana().liquidityLocks;
    expect(locks?.totalShare?.normalizedPct).toBe(98.13);
    expect(locks?.rows[0]?.tag).toBe("Raydium Burn & Earn");
    expect(locks?.rows[0]?.amount).toBe("490815.647672221");
  });

  it("carries GoPlus venues, so where-else-does-this-trade needs no second call", () => {
    const venues = ethereum().goPlus?.venues ?? [];
    expect(venues).toHaveLength(26);
    expect(venues[0]).toEqual({
      name: "UniswapV2",
      liquidityUsd: "14483171.03991239",
      pairAddress: "0xa43fe16908251ee70ef74718545e4fe6c5ccec9f",
    });
  });

  it("reports QuickIntel's problem flag verbatim rather than merging it", () => {
    // Measured on the SEMI capture: `problem` and the block's own flags can
    // disagree. The parser must not resolve that into one verdict.
    const qi = ethereum().quickIntel;
    expect(qi?.problem).toBe(false);
    expect(qi?.hasScams).toBe(false);
    expect(qi?.contractRenounced).toBe(true);
    expect(qi?.canBlacklist).toBe(true);
  });

  it("carries the issuer profile and its metaIds handoff", () => {
    const profile = ethereum().profile;
    expect(profile?.symbol).toBe("PEPE");
    expect(profile?.metaIds).toHaveLength(3);
    expect(profile?.links.map((link) => link.url)).toContain(
      "https://www.pepe.vip/"
    );
  });

  it("names the provider keys it does not project instead of dropping them silently", () => {
    const gp = ethereum().goPlus;
    expect(gp?.unprojectedKeys).toEqual(
      expect.arrayContaining(["isInDex", "isTrueToken", "otherPotentialRisks"].filter(
        (key) => (gp?.unprojectedKeys ?? []).includes(key)
      ))
    );
    // Whatever the set is, it is a sorted list of real provider field names.
    for (const key of gp?.unprojectedKeys ?? []) {
      expect(typeof key).toBe("string");
    }
  });
});

describe("the route is recorded because route-keyed caches diverge", () => {
  it("echoes the route the caller used", () => {
    const viaToken = parsePairDetails(
      loadJsonFixture("pair-details-solana-live").bytes,
      { route: "token_id", inverted: true }
    );
    expect(viaToken.route).toBe("token_id");
    expect(viaToken.inverted).toBe(true);
    expect(solana().route).toBe("pair_id");
  });
});

/* ------------------------------------------------------------------ */
/* The QuickIntel nested depth gap                                     */
/* ------------------------------------------------------------------ */

function pulsechain(): ReturnType<typeof parsePairDetails> {
  return parsePairDetails(
    loadJsonFixture("pair-details-quickintel-nested-pulsechain").bytes,
    PAIR_ROUTE
  );
}

function floki(): ReturnType<typeof parsePairDetails> {
  return parsePairDetails(
    loadJsonFixture("pair-details-lock-address-shortened-floki").bytes,
    { route: "token_id", inverted: false }
  );
}

function usdcInverted(): ReturnType<typeof parsePairDetails> {
  return parsePairDetails(
    loadJsonFixture("pair-details-inverted-audited-token").bytes,
    { route: "pair_id", inverted: true }
  );
}

describe("QuickIntel fields are visible one level down, not silently dropped", () => {
  /*
   * THE MEASURED DEFECT. `unprojectedKeys` was computed over the QuickIntel
   * ROOT only, and the payload is three nested objects, so it reported an
   * EMPTY list on all 13 live documents while 24 nested fields were discarded
   * without trace. Four of them are risk flags of exactly the class this tool
   * exists to report and one is a per-trade size limit, which is a money-path
   * fact for a buy decision. The tool's own promise, that a block the provider
   * populated and this projection cannot read is NAMED, was true at the root
   * and false one level below it.
   */
  it("names an unprojected NESTED field as path.key, not as nothing at all", () => {
    const keys = pulsechain().quickIntel?.unprojectedKeys ?? [];
    // `contractLinks` and the renounce family live in quickiAudit and are not
    // projected. Before the fix this list was empty.
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("quickiAudit.contractLinks");
    expect(keys).toContain("quickiAudit.cantPauseTradingRenounced");
    expect(keys).toContain("tokenDetails.quickiTokenHash");
    expect(keys).toContain("tokenDynamicDetails.lpPair");
    // Every nested entry carries its path, so a follow-up capture knows where
    // to look rather than guessing which of the three objects it came from.
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z]+(\.[A-Za-z0-9]+)?$/u);
    }
  });

  it("never names the three nested containers themselves, which ARE read", () => {
    const keys = pulsechain().quickIntel?.unprojectedKeys ?? [];
    expect(keys).not.toContain("tokenDetails");
    expect(keys).not.toContain("tokenDynamicDetails");
    expect(keys).not.toContain("quickiAudit");
  });

  it("names a field the moment it stops being projected", () => {
    // The projected set and the reported set must partition the payload: any
    // key of the three nested objects is in exactly one of them.
    const block = pulsechain().quickIntel;
    expect(block).not.toBeNull();
    const reported = new Set(block?.unprojectedKeys ?? []);
    expect(reported.has("quickiAudit.hasExternalContractRisk")).toBe(false);
    expect(reported.has("tokenDynamicDetails.tokenSupplyBurned")).toBe(false);
  });
});

describe("the QuickIntel safety-flag family is projected, because it is the point of the tool", () => {
  it("carries the four risk flags the pulsechain document sent", () => {
    const block = pulsechain().quickIntel;
    expect(block?.hasExternalContractRisk).toBe(false);
    expect(block?.hasGeneralVulnerabilities).toBe(false);
    expect(block?.hasObfuscatedAddressRisk).toBe(false);
    expect(block?.canMultiBlacklist).toBe(false);
  });

  it("carries hasFeeWarning, which only some documents send", () => {
    expect(floki().quickIntel?.hasFeeWarning).toBe(false);
    // Absent on this one, and absence is UNKNOWN rather than false.
    expect(pulsechain().quickIntel?.hasFeeWarning).toBeNull();
  });

  it("carries the proxy implementation, which changes what every other flag means", () => {
    expect(usdcInverted().quickIntel?.proxyImplementation).toBe(
      "0xa2327a938febf5fec13bacfb16ae10ecbc4cbdcf"
    );
    expect(floki().quickIntel?.proxyImplementation).toBeNull();
  });

  it("carries the per-trade size limit as an exact decimal string", () => {
    const block = parsePairDetails(
      loadJsonFixture("pair-details-goplus-fraction-tax").bytes,
      PAIR_ROUTE
    ).quickIntel;
    expect(block?.maxTransaction).toBe("100000000");
    // The SHARE is not normalized: "0.1" beside 100000000 tokens is consistent
    // with either scale, and asserting one would be the 100x defect again.
    expect(block?.maxTransactionPercent?.raw).toBe("0.1");
    expect(block?.maxTransactionPercent?.unit).toBe("unverified");
    expect(block?.maxTransactionPercent?.normalizedPct).toBeNull();
  });

  it("carries priceImpact and tokenSupplyBurned with their units declared", () => {
    expect(floki().quickIntel?.priceImpact?.raw).toBe("15.8");
    expect(floki().quickIntel?.priceImpact?.unit).toBe("unverified");
    // A token AMOUNT, not a share, and lossless: the provider sent it as a
    // JSON number and the exact lexeme survives.
    expect(pulsechain().quickIntel?.tokenSupplyBurned).toBe("12575428.18160413");
  });
});

describe("the provider states WHICH token it analysed, and it is now readable", () => {
  it("reads the QuickIntel subject address verbatim, case preserved", () => {
    // The same pool answers with a DIFFERENT subject on the inverted route,
    // which is what makes this field a real cross-check rather than an echo.
    expect(usdcInverted().quickIntel?.auditedToken?.address).toBe(
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    );
    expect(usdcInverted().quickIntel?.auditedToken?.symbol).toBe("USDC");
    expect(usdcInverted().quickIntel?.auditedToken?.source).toBe("quickintel");
    expect(pulsechain().quickIntel?.auditedToken?.symbol).toBe("HEX");
  });

  it("reads the GoPlus subject, which is a symbol and no address", () => {
    expect(floki().goPlus?.auditedToken?.symbol).toBe("FLOKI");
    expect(floki().goPlus?.auditedToken?.address).toBeNull();
    expect(floki().goPlus?.auditedToken?.source).toBe("goplus");
  });

  it("is null rather than an object of nulls when the provider said nothing", () => {
    // A subject that was never stated must not read as one that was checked.
    expect(pulsechain().goPlus?.auditedToken ?? null).toBeNull();
  });
});

describe("a lock reference is not an address until it is one", () => {
  /*
   * MEASURED: the provider sent
   * "1-0x663a5c229c09b049e36dcc11a9b0d4a8eb9db2" for a lock whose real holder,
   * present in the SAME document's GoPlus LP holder list, is
   * 0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214. It is chain-id-prefixed and
   * two hex characters short, and it was being handed to the model under the
   * name `address`. A model that pastes that into an explorer or a transfer
   * resolves a different identity or none.
   */
  it("keeps the provider's shortened reference verbatim and withholds the address claim", () => {
    const lock = floki().liquidityLocks?.rows[0];
    expect(lock?.providerLockRef).toBe(
      "1-0x663a5c229c09b049e36dcc11a9b0d4a8eb9db2"
    );
    expect(lock?.address).toBeNull();
  });

  it("proves the same document carries the real address elsewhere", () => {
    // The two live side by side, which is why "the provider only had this" is
    // not an available excuse for emitting the short one as an address.
    expect(floki().goPlus?.lpHolders[0]?.address).toBe(
      "0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214"
    );
  });

  it("does populate address when the reference really is one", () => {
    // The solana capture's Raydium lock is a full base58 account.
    const lock = solana().liquidityLocks?.rows[0];
    expect(lock?.providerLockRef).toBe(
      "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH"
    );
    expect(lock?.address).toBe(lock?.providerLockRef);
  });
});
