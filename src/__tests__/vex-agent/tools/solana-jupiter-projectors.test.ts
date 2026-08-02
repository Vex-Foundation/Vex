import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  projectJupiterToken,
  projectJupiterTokens,
} from "../../../vex-agent/tools/protocols/solana-jupiter/projectors.js";
import { SOLANA_JUPITER_TOOLS } from "../../../vex-agent/tools/protocols/solana-jupiter/manifest.js";
import type { JupiterMintInformation } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/types.js";

/** A fully-populated raw token with all the noise fields the projector drops. */
function fullToken(): JupiterMintInformation {
  return {
    id: "So11111111111111111111111111111111111111112",
    name: "Wrapped SOL",
    symbol: "SOL",
    decimals: 9,
    icon: "https://img.example/sol.png",
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    createdAt: "2024-01-01T00:00:00Z",
    twitter: "https://twitter.com/solana",
    telegram: "https://t.me/solana",
    website: "https://solana.com",
    discord: "https://discord.gg/solana",
    instagram: "https://instagram.com/solana",
    tiktok: "https://tiktok.com/@solana",
    otherUrl: "https://other.example",
    dev: "DevPubkey11111111111111111111111111111111111",
    mintAuthority: "MintAuth1111111111111111111111111111111111",
    freezeAuthority: "FreezeAuth111111111111111111111111111111111",
    circSupply: 500_000_000,
    totalSupply: 600_000_000,
    launchpad: "pump.fun",
    partnerConfig: "PartnerCfg",
    graduatedPool: "GradPool",
    graduatedAt: "2024-02-01T00:00:00Z",
    holderCount: 12345,
    fdv: 90_000_000_000,
    mcap: 80_000_000_000,
    usdPrice: 150.25,
    priceBlockId: 987654,
    liquidity: 4_200_000,
    apy: { jupEarn: 0.07 },
    stats5m: { priceChange: 0.1, volumeChange: 2, holderChange: 1, liquidityChange: 0.5, buyVolume: 1000, sellVolume: 800, numBuys: 10, numSells: 8, numTraders: 15, extra: "noise" },
    stats1h: { priceChange: 1.2, buyVolume: 50_000, numTraders: 200 },
    stats6h: { priceChange: -0.5 },
    stats24h: { priceChange: 3.4, volumeChange: 1.1, holderChange: 0.2, liquidityChange: -0.3, buyVolume: 1_000_000, sellVolume: 900_000, numBuys: 500, numSells: 480, numTraders: 1200 },
    firstPool: { id: "PoolId123", createdAt: "2024-01-01T00:00:00Z", extra: "noise" },
    audit: { isSus: false, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 12.5, devBalancePercentage: 0, devMints: 0 },
    organicScore: 88,
    organicScoreLabel: "high",
    isVerified: true,
    tags: ["verified", "strict"],
    updatedAt: "2026-06-20T00:00:00Z",
    // Open passthrough noise — must not survive projection.
    someUnknownProviderField: { nested: "blob" },
  };
}

describe("solana-jupiter projectJupiterToken (P0-3c concise)", () => {
  it("keeps the signal set with correct values", () => {
    const out = projectJupiterToken(fullToken());

    expect(out.mint).toBe("So11111111111111111111111111111111111111112");
    expect(out.symbol).toBe("SOL");
    expect(out.name).toBe("Wrapped SOL");
    expect(out.decimals).toBe(9);
    expect(out.usdPrice).toBe(150.25);
    expect(out.marketCap).toBe(80_000_000_000);
    expect(out.fdv).toBe(90_000_000_000);
    expect(out.liquidity).toBe(4_200_000);
    expect(out.circSupply).toBe(500_000_000);
    expect(out.totalSupply).toBe(600_000_000);
    expect(out.holderCount).toBe(12345);
    expect(out.organicScore).toBe(88);
    expect(out.organicScoreLabel).toBe("high");
    expect(out.isVerified).toBe(true);
    expect(out.tags).toEqual(["verified", "strict"]);
    expect(out.launchpad).toBe("pump.fun");
    expect(out.createdAt).toBe("2024-01-01T00:00:00Z");
  });

  it("keeps the safety audit flags the agent acts on", () => {
    const out = projectJupiterToken(fullToken());

    expect(out.audit).not.toBeNull();
    expect(out.audit?.isSus).toBe(false);
    expect(out.audit?.mintAuthorityDisabled).toBe(true);
    expect(out.audit?.freezeAuthorityDisabled).toBe(true);
    expect(out.audit?.topHoldersPercentage).toBe(12.5);
    expect(out.audit?.devBalancePercentage).toBe(0);
    // Raw authority pubkeys are NOT surfaced — only the disabled-booleans.
    expect(out.audit).not.toHaveProperty("mintAuthority");
  });

  it("projects per-interval stats to the concise subset, dropping passthrough noise", () => {
    const out = projectJupiterToken(fullToken());

    expect(out.stats24h).not.toBeNull();
    expect(out.stats24h?.priceChange).toBe(3.4);
    expect(out.stats24h?.numTraders).toBe(1200);
    // `extra` passthrough on the raw stats block must not survive.
    expect(out.stats5m).not.toHaveProperty("extra");
    // Missing inner fields normalise to null, not undefined.
    expect(out.stats1h?.volumeChange).toBeNull();
    expect(out.stats1h?.priceChange).toBe(1.2);
  });

  it("drops every noise field (URLs, social links, raw sub-objects, passthrough)", () => {
    const out = projectJupiterToken(fullToken());

    // `priceBlockId` and `updatedAt` are deliberately NOT in this list: both
    // are price-STALENESS signals the agent needs to judge how old a quote is,
    // and the 2026-07-25 truncation audit restored them. Everything below is
    // genuine noise — links, authorities, and raw provider sub-objects.
    for (const dropped of [
      "icon", "twitter", "telegram", "website", "discord", "instagram", "tiktok",
      "otherUrl", "dev", "mintAuthority", "freezeAuthority", "tokenProgram",
      "partnerConfig", "graduatedPool", "graduatedAt", "apy",
      "firstPool", "someUnknownProviderField",
    ]) {
      expect(out).not.toHaveProperty(dropped);
    }
    // Pinned as PRESENT so a future "tidy the output" pass cannot silently
    // re-drop the staleness signals.
    expect(out).toHaveProperty("priceBlockId");
    expect(out).toHaveProperty("updatedAt");
  });

  it("handles a token with missing optional fields (defensive normalisation)", () => {
    const minimal: JupiterMintInformation = {
      id: "MintMin1111111111111111111111111111111111111",
      name: "Minimal",
      symbol: "MIN",
      decimals: 6,
    };

    const out = projectJupiterToken(minimal);

    expect(out.mint).toBe("MintMin1111111111111111111111111111111111111");
    expect(out.symbol).toBe("MIN");
    expect(out.decimals).toBe(6);
    // All absent optionals normalise to null, never undefined.
    expect(out.usdPrice).toBeNull();
    expect(out.marketCap).toBeNull();
    expect(out.fdv).toBeNull();
    expect(out.liquidity).toBeNull();
    expect(out.holderCount).toBeNull();
    expect(out.organicScore).toBeNull();
    expect(out.organicScoreLabel).toBeNull();
    expect(out.isVerified).toBeNull();
    expect(out.tags).toBeNull();
    expect(out.launchpad).toBeNull();
    expect(out.createdAt).toBeNull();
    expect(out.audit).toBeNull();
    expect(out.stats5m).toBeNull();
    expect(out.stats1h).toBeNull();
    expect(out.stats6h).toBeNull();
    expect(out.stats24h).toBeNull();
  });

  it("projectJupiterTokens tolerates a non-array input and maps arrays", () => {
    expect(projectJupiterTokens(null)).toEqual([]);
    expect(projectJupiterTokens(undefined)).toEqual([]);
    const arr = projectJupiterTokens([fullToken(), fullToken()]);
    expect(arr).toHaveLength(2);
    expect(arr[0]!.symbol).toBe("SOL");
  });
});

/**
 * `options.statsInterval` (W1-G) — the raw shape always carries all four
 * stats windows; this option narrows the projected row to one, cutting the
 * common-case payload without touching row count (recon-impl-tokens.md §3).
 */
describe("projectJupiterToken — statsInterval option (W1-G)", () => {
  it("defaults to 'all' when omitted, preserving every stats block (pre-existing behaviour)", () => {
    const out = projectJupiterToken(fullToken());
    expect(out.stats5m).not.toBeNull();
    expect(out.stats1h).not.toBeNull();
    expect(out.stats6h).not.toBeNull();
    expect(out.stats24h).not.toBeNull();
  });

  it("explicit 'all' keeps every stats block", () => {
    const out = projectJupiterToken(fullToken(), { statsInterval: "all" });
    expect(out.stats5m).not.toBeNull();
    expect(out.stats1h).not.toBeNull();
    expect(out.stats6h).not.toBeNull();
    expect(out.stats24h).not.toBeNull();
  });

  it("a single interval keeps only that block and nulls the other three", () => {
    const out = projectJupiterToken(fullToken(), { statsInterval: "1h" });
    expect(out.stats1h).not.toBeNull();
    expect(out.stats1h?.priceChange).toBe(1.2);
    expect(out.stats5m).toBeNull();
    expect(out.stats6h).toBeNull();
    expect(out.stats24h).toBeNull();
  });

  it("selecting an interval the token has no data for yields all-null stats", () => {
    const minimal: JupiterMintInformation = {
      id: "MintMin1111111111111111111111111111111111111",
      name: "Minimal",
      symbol: "MIN",
      decimals: 6,
      stats24h: { priceChange: 3.4 },
    };
    const out = projectJupiterToken(minimal, { statsInterval: "1h" });
    expect(out.stats1h).toBeNull();
    expect(out.stats24h).toBeNull();
  });

  it("projectJupiterTokens forwards the option to every row", () => {
    const arr = projectJupiterTokens([fullToken(), fullToken()], { statsInterval: "24h" });
    for (const row of arr) {
      expect(row.stats1h).toBeNull();
      expect(row.stats24h).not.toBeNull();
    }
  });
});

/**
 * Capture-safety fence (CC-3 / P0-3): the concise projection is only safe on
 * NON-mutating handlers — `ok()` ties output to data 1:1, so projecting a
 * MUTATING handler's data would strip `_tradeCapture` and break the capture
 * pipeline. The projector is wired only into `solana.tokens.search` /
 * `solana.tokens.trending`; this pins that both are `mutating:false` reads, so
 * projecting their `ok()` arg can never strip a capture payload.
 */
describe("capture-safety — projected token handlers are non-mutating reads", () => {
  it("both projected tool manifests are mutating:false reads", () => {
    for (const toolId of ["solana.tokens.search", "solana.tokens.trending"]) {
      const manifest = SOLANA_JUPITER_TOOLS.find((t) => t.toolId === toolId);
      expect(manifest, `manifest for ${toolId}`).toBeDefined();
      expect(manifest?.mutating).toBe(false);
      expect(manifest?.actionKind).toBe("read");
    }
  });

  // The read handlers moved from `handlers/core.ts` into its sibling
  // `handlers/core/` folder when core.ts became a façade (550-line decree);
  // `core/token-handlers.ts` is the file that owns the projector wiring now.
  it("the token read handlers wire the projector in", () => {
    const tokenHandlersPath = fileURLToPath(
      new URL(
        "../../../vex-agent/tools/protocols/solana-jupiter/handlers/core/token-handlers.ts",
        import.meta.url,
      ),
    );
    const source = readFileSync(tokenHandlersPath, "utf8");
    expect(source).toContain("projectJupiterTokens");
  });
});
