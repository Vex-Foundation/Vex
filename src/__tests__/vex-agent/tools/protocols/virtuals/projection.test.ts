/**
 * The projection contract: what a live provider row becomes, and what it never
 * becomes.
 *
 * This runs against SANITIZED COPIES OF REAL CAPTURES (`../../../../virtuals/
 * fixtures/`), not hand-built objects, because the two defects this projection
 * exists to prevent are both properties of the real payload and neither would
 * appear in a tidy fixture: the creator block carries a masked email and a
 * Privy account DID, and an agent's whole `description` can be a bare markdown
 * image embed pointing at a remote URL.
 *
 * It replaces `tools/virtuals-projectors.test.ts`. The contract changes it
 * encodes, deliberately:
 *   - `antiSniper` is now side-specific and anchored on `launchedAt`;
 *   - the detail projection carries the full row dictionary (addresses,
 *     launchInfo, genesis, vibesInfo, cores, creator, flags) and states its own
 *     omissions in `omittedFreeText`;
 *   - `tradingRoute` distinguishes the curve market from the DEX market.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeAgent,
  validateVirtualsList,
  validateVirtualDetail,
} from "@tools/virtuals/validation.js";
import {
  projectVirtualsDetail,
  projectVirtualsListItem,
} from "@vex-agent/tools/protocols/virtuals/projectors.js";
import LIST_PAGE from "../../../../virtuals/fixtures/agents-list-page.json" with { type: "json" };
import DETAIL from "../../../../virtuals/fixtures/agent-detail.json" with { type: "json" };

const detail = validateVirtualDetail(DETAIL)!;
const list = validateVirtualsList(LIST_PAGE);

describe("the fixtures are the real thing", () => {
  it("parses the captured list page and detail payload", () => {
    expect(list.agents.length).toBeGreaterThanOrEqual(3);
    expect(detail.id).toBe(96200);
    expect(detail.symbol).toBe("VEX");
  });
});

describe("personal data never crosses the boundary", () => {
  it("drops creator.email and creator.username at the validator, keeping the public wallet", () => {
    // The fixture still HAS them, which is the point: the drop must be the
    // validator's doing, not the fixture's.
    const rawCreator = (DETAIL.data as Record<string, unknown>).creator as Record<string, unknown>;
    expect(rawCreator.email).toBeTruthy();
    expect(rawCreator.username).toBeTruthy();

    expect(detail.creator).not.toBeNull();
    expect(Object.keys(detail.creator!).sort()).toEqual(["id", "walletAddress"]);
    expect(JSON.stringify(detail)).not.toContain("@e***.invalid");
    expect(JSON.stringify(detail)).not.toContain("did:privy");
  });

  it("keeps neither identifier in the projected detail", () => {
    const projected = JSON.stringify(projectVirtualsDetail(detail));
    expect(projected).not.toContain("@");
    expect(projected).not.toContain("privy");
  });
});

describe("free text is stripped of markup before it is bounded", () => {
  it("turns a description that is only an image embed into nothing, not a URL", () => {
    // Agent 96200's entire description is `![Upload](https://s3.../...jpg)`.
    expect(detail.description).toContain("![Upload](https://");
    const projected = projectVirtualsDetail(detail);
    // The alt text survives (it is the author's own words); the remote URL and
    // the markup around it do not, which is the property that matters.
    expect(projected.descriptionExcerpt).toBe("Upload");
    expect(projected.descriptionExcerpt).not.toContain("http");
  });

  it("keeps link text but never the target", () => {
    const agent = normalizeAgent({
      ...(DETAIL.data as Record<string, unknown>),
      description: "See [our docs](https://example.invalid/secret) and https://example.invalid/raw for more.",
    })!;
    const excerpt = projectVirtualsDetail(agent).descriptionExcerpt!;
    expect(excerpt).toContain("our docs");
    expect(excerpt).not.toContain("example.invalid");
    expect(excerpt).not.toContain("http");
  });

  it("bounds a long description and marks the cut", () => {
    const agent = normalizeAgent({
      ...(DETAIL.data as Record<string, unknown>),
      description: "word ".repeat(400),
    })!;
    const excerpt = projectVirtualsDetail(agent).descriptionExcerpt!;
    expect(excerpt.length).toBeLessThanOrEqual(284);
    expect(excerpt.endsWith("...")).toBe(true);
  });

  it("drops the big blobs and SAYS which ones it dropped", () => {
    const projected = projectVirtualsDetail(detail);
    expect(detail.overview).toBeTruthy();
    expect(detail.tokenUtility).toBeTruthy();
    expect(detail.roadmap).toBeTruthy();
    expect(JSON.stringify(projected)).not.toContain(detail.overview!.slice(0, 40));
    // Rule 05: a bounded projection reports what it left out.
    expect(projected.omittedFreeText).toEqual(
      expect.arrayContaining(["overview", "tokenUtility", "roadmap"]),
    );
  });
});

describe("money-shaped fields stay integer strings", () => {
  it("keeps virtualTokenValue verbatim with its declared 18 decimals", () => {
    const row = projectVirtualsListItem(detail);
    expect(row.priceInVirtualRaw).toBe("6576470588235294");
    expect(row.priceInVirtualDecimals).toBe(18);
    // Never a float anywhere near it.
    expect(typeof row.priceInVirtualRaw).toBe("string");
  });

  it("refuses a non-integer string rather than rounding it", () => {
    const agent = normalizeAgent({
      ...(DETAIL.data as Record<string, unknown>),
      virtualTokenValue: "6.5765e15",
      totalValueLocked: "250326.5",
    })!;
    expect(agent.virtualTokenValue).toBeNull();
    expect(agent.totalValueLocked).toBeNull();
  });

  it("carries totalValueLocked with NO declared scale, because the provider declares none", () => {
    const projected = projectVirtualsDetail(detail);
    expect(projected.totalValueLockedRaw).toBe("250326");
  });
});

describe("the detail projection carries the row dictionary", () => {
  const projected = projectVirtualsDetail(detail);

  it("projects the graduation block including the curve pair", () => {
    expect(projected.graduation.graduated).toBe(true);
    expect(projected.graduation.lpAddress).toBe("0x817f16F5D8da83d1B089B082c0172af3923618dA");
    expect(projected.graduation.preTokenPair).toBe("0xFB899EFC1Ad4128118cD33Eb3A0d912aceC6c8eE");
  });

  it("projects the full launchInfo, not the three-field subset", () => {
    expect(projected.launchInfo).toMatchObject({
      launchMode: 0,
      antiSniperTaxType: 1,
      airdropPercent: 0,
      needAcf: true,
      isProject60days: false,
      launchRadarEnabled: false,
      isRobotics: false,
    });
  });

  it("projects the address book through the address validator", () => {
    expect(projected.addresses.dao).toBe("0x715dA6B1a2B96fF47610de4AD3736105cc77B70D");
    expect(projected.addresses.tokenBoundAccount).toBe("0x4201615ca3b32141AC09C124f59D86DEfd4437c7");
    expect(projected.addresses.staking).toBeNull();
  });

  it("projects the agent's cores and its tokenomics with the truncation stated", () => {
    expect(projected.tokenomics.totalSupply).toBe(1_000_000_000);
    expect(projected.tokenomics.totalAllocations).toBe(detail.tokenomics.length);
    expect(projected.tokenomics.truncated).toBe(false);
    expect(Array.isArray(projected.cores)).toBe(true);
  });

  it("validates the image URL rather than passing it through", () => {
    const hostile = normalizeAgent({
      ...(DETAIL.data as Record<string, unknown>),
      image: { url: "javascript:alert(1)" },
    })!;
    expect(projectVirtualsDetail(hostile).imageUrl).toBeNull();
  });
});

describe("tradingRoute distinguishes the curve from the DEX", () => {
  function routeFor(overrides: Record<string, unknown>) {
    const agent = normalizeAgent({ ...(DETAIL.data as Record<string, unknown>), ...overrides })!;
    return projectVirtualsDetail(agent).tradingRoute;
  }

  it("routes a graduated Robinhood agent to uniswap through its pool", () => {
    const route = routeFor({});
    expect(route).toMatchObject({ tradable: true, market: "dex", venue: "uniswap", namespace: "uniswap" });
    expect(route.poolAddress).toBe("0x817f16F5D8da83d1B089B082c0172af3923618dA");
  });

  it("routes a graduated Base agent to kyberswap", () => {
    expect(routeFor({ chain: "BASE" })).toMatchObject({ tradable: true, venue: "kyberswap" });
  });

  it("routes a BONDING Solana agent to Jupiter today, naming the curve", () => {
    const route = routeFor({
      chain: "SOLANA",
      status: "UNDERGRAD",
      tokenAddress: null,
      lpAddress: null,
      preToken: "GpjfBrAwQL9wArUfxXK4BjqqArXFZZfLpLnxL5HMvirt",
      preTokenPair: "2Lbmw3eru759d1FYzuob1PG57Mm7THdZYDuQHjN1dtXd",
    });
    expect(route).toMatchObject({ tradable: true, market: "curve", venue: "jupiter", namespace: "solana" });
    expect(route.note).toMatch(/Meteora/);
  });

  it("refuses to name a venue for an EVM bonding curve, and says what it is instead", () => {
    const route = routeFor({
      status: "UNDERGRAD",
      tokenAddress: null,
      lpAddress: null,
      preTokenPair: "0xFB899EFC1Ad4128118cD33Eb3A0d912aceC6c8eE",
    });
    expect(route.tradable).toBe(false);
    expect(route.market).toBe("curve");
    expect(route.venue).toBeNull();
    expect(route.poolAddress).toBe("0xFB899EFC1Ad4128118cD33Eb3A0d912aceC6c8eE");
    expect(route.note).toMatch(/BondingV5 \/ FRouterV3/);
  });
});

describe("the anti-sniper block on a real row", () => {
  it("is NOT applicable for the graduated capture, and says why", () => {
    const row = projectVirtualsListItem(detail);
    expect(row.antiSniper.applicable).toBe(false);
    expect(row.antiSniper.note).toMatch(/graduated/);
  });

  it("is anchored on launchedAt, not on lpCreatedAt, while still bonding", () => {
    const agent = normalizeAgent({
      ...(DETAIL.data as Record<string, unknown>),
      status: "UNDERGRAD",
      tokenAddress: null,
      lpAddress: null,
      lpCreatedAt: null,
      launchedAt: "2026-09-04T12:00:00.000Z",
    })!;
    const row = projectVirtualsListItem(agent, Date.parse("2026-09-04T12:00:30.000Z"));
    expect(row.antiSniper.applicable).toBe(true);
    expect(row.antiSniper.windowActive).toBe(true);
    expect(row.antiSniper.buy.antiSniperTaxPct).toBe(49);
    expect(row.antiSniper.sell.applies).toBe(false);
  });
});

describe("structural drift degrades, never passes through", () => {
  it("nulls an unknown chain/status/factory and warns the row is suspect", () => {
    const agent = normalizeAgent({
      ...(DETAIL.data as Record<string, unknown>),
      chain: "MOONBASE",
      status: "TOTALLY_NEW",
      factory: "NOT_A_FACTORY",
    })!;
    const row = projectVirtualsListItem(agent);
    expect(row.chain).toBeNull();
    expect(row.status).toBeNull();
    expect(row.factory).toBeNull();
    expect(row.warning).toMatch(/unrecognized chain\/status\/factory/);
  });

  it("accepts the row statuses the provider really uses", () => {
    for (const status of ["UNDERGRAD", "AVAILABLE", "GENESIS", "DRAFT"]) {
      const agent = normalizeAgent({ ...(DETAIL.data as Record<string, unknown>), status })!;
      expect(projectVirtualsListItem(agent).status).toBe(status);
    }
  });

  it("re-serialises timestamps rather than echoing upstream bytes", () => {
    const agent = normalizeAgent({
      ...(DETAIL.data as Record<string, unknown>),
      createdAt: "2026-07-03T16:34:58.003+00:00",
    })!;
    expect(projectVirtualsListItem(agent, Date.parse("2026-09-04T00:00:00Z")).ageDays).toBeCloseTo(62.3, 1);
  });
});

describe("the price series is bounded and labelled", () => {
  it("attaches the provider's own 24h samples when the row carries them", () => {
    const withSeries = list.agents.find((a) => a.sparkline !== null && a.sparkline.length > 0);
    expect(withSeries, "the captured page should include a sparkline row").toBeDefined();
    const row = projectVirtualsListItem(withSeries!);
    expect(row.priceSeries24h!.returned).toBe(withSeries!.sparkline!.length);
    expect(row.priceSeries24h!.truncated).toBe(false);
    expect(row.priceSeries24h!.note).toMatch(/not OHLC candles/);
  });

  it("omits the block entirely when the row has no series", () => {
    const bare = normalizeAgent({ ...(DETAIL.data as Record<string, unknown>) })!;
    expect(projectVirtualsListItem(bare).priceSeries24h).toBeUndefined();
  });

  it("keeps the NEWEST points and states how many it dropped", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ timestamp: 1_000 + i, price: i }));
    const agent = normalizeAgent({ ...(DETAIL.data as Record<string, unknown>), sparkline: many })!;
    const series = projectVirtualsListItem(agent).priceSeries24h!;
    expect(series.truncated).toBe(true);
    expect(series.returned).toBe(96);
    // Newest kept, oldest dropped - and the note says exactly how many.
    expect(series.points.at(-1)!.timestampSeconds).toBe(1_299);
    expect(series.note).toMatch(/oldest 204 of 300 points/);
  });
});
