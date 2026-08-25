/**
 * Manifest contract for the DexScreener namespace, after the S3.5 retirement.
 *
 * WHAT THIS FILE LOST. Its previous body pinned the honesty clauses of the 12
 * public-API tools: the "at most 30 provider-chosen rows" window disclosure,
 * the CTO no-price-prediction claim, the orders spend-record framing, the
 * profiles-are-not-a-creation-feed claim. Those tools were retired whole and
 * alias-free (owner decision D-DS2), so every one of those assertions lost its
 * subject and is DELETED rather than weakened to keep a green suite.
 *
 * WHAT SURVIVES, because it is a property of the namespace and not of one
 * retired tool: the completeness pin, the read-only invariant, the
 * no-API-key invariant, description and passage minimums, and the rule that a
 * description may never contradict the runtime. Each of those is re-pinned
 * against the 14 tools that now exist.
 *
 * WHAT IS NEW. The three tools S3.5 landed carry the claims that most need
 * pinning, because each one can mislead in a specific measured way:
 * `pairs_search` must never imply a page it cannot serve, `token_pairs_list`
 * must never present a sample of pools as the market, and `narratives_list`
 * must never send the model the slug where the screener needs the id.
 */

import { describe, it, expect } from "vitest";
import type {
  ProtocolParamDef,
  ProtocolToolManifest,
} from "../../../vex-agent/tools/protocols/types.js";
import { DEXSCREENER_TOOLS } from "../../../vex-agent/tools/protocols/dexscreener/manifest.js";

function toolById(toolId: string): ProtocolToolManifest {
  const tool = DEXSCREENER_TOOLS.find(t => t.toolId === toolId);
  if (tool === undefined) throw new Error(`no manifest declares ${toolId}`);
  return tool;
}

function descriptionOf(toolId: string): string {
  return toolById(toolId).description;
}

function passageOf(toolId: string): string {
  const passage = toolById(toolId).discovery?.embeddingText;
  if (passage === undefined) throw new Error(`no embeddingText for ${toolId}`);
  return passage;
}

function paramKeys(toolId: string): string[] {
  return toolById(toolId).params.map((param) => param.key);
}

/** A param lookup that fails loudly instead of asserting non-null. */
function paramOf(toolId: string, key: string): ProtocolParamDef {
  const param = toolById(toolId).params.find((entry) => entry.key === key);
  if (param === undefined) throw new Error(`${toolId} declares no param "${key}"`);
  return param;
}

describe("dexscreener manifest", () => {
  // ── Completeness ─────────────────────────────────────────────────

  // 14 before the Batch 2 near-duplicate merges (owner decision D7) retired
  // `dexscreener.profiles.recent` and `dexscreener.boosts.top` into their
  // siblings' `feed` param.
  // 20 before the site resolve family (stage S3) added the three tools it could
  // land: the single-pair snapshot, the spotlight feeds and the batch refresh.
  // 23 before stage S3.5 retired the 12 public-API tools whole and landed the
  // three that were blocked on their identities. Net: 23 - 12 + 3 = 14, and
  // this is the only step in the namespace's history that made it smaller.
  // 14 before stage S4 added the deep-dive family (4): the pair safety report,
  // candles, trades and the trader leaderboard. All four are NEW identities.
  it("has 18 tools total", () => {
    expect(DEXSCREENER_TOOLS).toHaveLength(18);
  });

  const EXPECTED_TOOL_IDS = [
    // Site screening surface, stage S2b (8).
    "dexscreener.pairs.trending",
    "dexscreener.pairs.top",
    "dexscreener.gainers",
    "dexscreener.losers",
    "dexscreener.pairs.new",
    "dexscreener.launchpad.pairs",
    "dexscreener.chains",
    "dexscreener.tokens.screen",
    // Site resolve family (5): three from stage S3, two from S3.5.
    "dexscreener.pair.get",
    "dexscreener.spotlight",
    "dexscreener.pairs.batch",
    // RECLAIMED identities: the public-API tools that held these toolIds were
    // retired, and the site-channel tools answering the same questions took
    // both the toolId and the publicName over unchanged.
    "dexscreener.search",
    "dexscreener.tokenPairs",
    // Site market context (1, stage S3.5). Also a reclaimed identity.
    "dexscreener.trending",
    // Site deep dive (4, stage S4): one pool in depth. New identities, because
    // none of the retired public-API tools answered any part of these
    // questions - there was no safety, candle, trade or trader surface at all.
    "dexscreener.pair.details",
    "dexscreener.candles",
    "dexscreener.trades",
    "dexscreener.top.traders",
  ];

  it("expected toolId count matches manifest count", () => {
    expect(EXPECTED_TOOL_IDS).toHaveLength(18);
  });

  for (const toolId of EXPECTED_TOOL_IDS) {
    it(`declares ${toolId}`, () => {
      const tool = DEXSCREENER_TOOLS.find(t => t.toolId === toolId);
      expect(tool).toBeDefined();
    });
  }

  it("has no tools beyond expected list", () => {
    const expectedSet = new Set(EXPECTED_TOOL_IDS);
    const unexpected = DEXSCREENER_TOOLS.filter(t => !expectedSet.has(t.toolId));
    expect(unexpected).toHaveLength(0);
  });

  // The retirement is what this test exists to make irreversible by accident:
  // a later change that re-adds one of these names, as an alias or otherwise,
  // fails here. D-DS2 is total, and D5 forbids a deprecation alias row.
  const RETIRED_TOOL_IDS = [
    "dexscreener.pairs",
    "dexscreener.tokens",
    "dexscreener.orders",
    "dexscreener.ads",
    "dexscreener.profiles",
    "dexscreener.boosts",
    "dexscreener.communityTakeovers",
    "dexscreener.attention",
    "dexscreener.meta",
  ];

  for (const toolId of RETIRED_TOOL_IDS) {
    it(`does not declare the retired ${toolId}, under any lifecycle`, () => {
      expect(DEXSCREENER_TOOLS.find(t => t.toolId === toolId)).toBeUndefined();
    });
  }

  it("declares no deprecated public name for a retired tool", () => {
    const retiredPublicNames = new Set([
      "dexscreener__pairs_get",
      "dexscreener__tokens_get",
      "dexscreener__token_orders_list",
      "dexscreener__ads_list",
      "dexscreener__profiles_list",
      "dexscreener__boosts_list",
      "dexscreener__community_takeovers_list",
      "dexscreener__attention_list",
      "dexscreener__narrative_get",
    ]);
    for (const tool of DEXSCREENER_TOOLS) {
      expect(retiredPublicNames.has(tool.publicName)).toBe(false);
    }
  });

  // ── Namespace ────────────────────────────────────────────────────

  it("all tools belong to dexscreener namespace", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.namespace).toBe("dexscreener");
    }
  });

  it("all tools are active lifecycle", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.lifecycle).toBe("active");
    }
  });

  it("all toolIds start with dexscreener.", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.toolId).toMatch(/^dexscreener\./);
    }
  });

  // ── Mutating flags (all read-only) ────────────────────────────────

  it("all tools are read-only (not mutating)", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
    }
  });

  // ── Required params ──────────────────────────────────────────────

  it("dexscreener.search requires query and nothing else", () => {
    const required = toolById("dexscreener.search").params
      .filter(p => p.required)
      .map(p => p.key);
    expect(required).toEqual(["query"]);
  });

  it("dexscreener.tokenPairs requires chain and tokenAddress", () => {
    const required = toolById("dexscreener.tokenPairs").params
      .filter(p => p.required)
      .map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("tokenAddress");
  });

  it("dexscreener.trending (narratives) has no required params", () => {
    const required = toolById("dexscreener.trending").params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  // ── No requiresEnv (DexScreener is free) ─────────────────────────

  it("no tools require ENV", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.requiresEnv).toBeUndefined();
    }
  });

  // ── Descriptions quality ──────────────────────────────────────────

  it("every tool has non-empty description", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(15);
    }
  });

  it("every param has non-empty description", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      for (const param of tool.params) {
        expect(param.description.length).toBeGreaterThan(3);
      }
    }
  });

  it("every tool has retrieval-only embedding text", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(
        tool.discovery?.embeddingText,
        `${tool.toolId} missing discovery.embeddingText`,
      ).toBeTruthy();
      expect(tool.discovery!.embeddingText!.length).toBeGreaterThan(80);
    }
  });

  it("every tool carries an example call", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(
        Object.keys(tool.exampleParams ?? {}).length,
        `${tool.toolId} has no exampleParams`,
      ).toBeGreaterThan(0);
    }
  });

  // ── The bounded, non-pageable disclosure (tools 7 and 8) ─────────
  //
  // The search channel serves 30 rows per request and offers NO continuation:
  // no page, no offset, no cursor. A tool that advertised an `offset` here
  // would be selling a page that cannot exist, which is worse than a small
  // answer because the agent would believe it had walked the set. Both tools
  // must therefore say the bound AND refuse to declare the parameter.

  const BOUNDED_NON_PAGEABLE = ["dexscreener.search", "dexscreener.tokenPairs"];

  for (const toolId of BOUNDED_NON_PAGEABLE) {
    it(`${toolId} declares no offset parameter`, () => {
      expect(paramKeys(toolId)).not.toContain("offset");
    });

    it(`${toolId} states the 30-row provider bound and the absence of continuation`, () => {
      const description = descriptionOf(toolId);
      expect(description).toContain("30");
      expect(description).toMatch(/no continuation|non-pageable/i);
      expect(description).toContain("providerCapped");
    });
  }

  it("dexscreener.search states that the chain scope is honoured server-side", () => {
    // The one capability the public API did not have at all. If the
    // description stopped saying it, the reclaim would look cosmetic and the
    // agent would keep filtering a global window locally.
    expect(descriptionOf("dexscreener.search")).toMatch(/server-side/i);
    expect(descriptionOf("dexscreener.search")).toContain("chain");
  });

  it("dexscreener.search warns that a ticker is not identity", () => {
    const description = descriptionOf("dexscreener.search");
    expect(description).toMatch(/copycat/i);
    expect(description).toContain("liquidityUsd");
    expect(description).toContain("pairAgeSeconds");
  });

  it("dexscreener.search declares the chain/chainIds exclusion rather than only prosing it", () => {
    // Prose alone cannot be enforced by the runtime or shown by discovery.
    const groups = toolById("dexscreener.search").exclusiveParamGroups ?? [];
    expect(groups.some((group) => group.includes("chain") && group.includes("chainIds"))).toBe(true);
  });

  it("dexscreener.tokenPairs never claims its shares describe the whole market", () => {
    // The failure this pin exists to prevent: shares over a capped window add
    // to 100 percent of a SAMPLE, and a caller routing a swap on that
    // difference picks the wrong pool.
    const description = descriptionOf("dexscreener.tokenPairs");
    expect(description).toContain("deepest among the returned window");
    expect(description).toContain("never a global claim");
    expect(description).toContain("resolutionBasis");
    expect(description).toMatch(/not of the market|a sample and not/i);
  });

  it("dexscreener.tokenPairs takes an address and says a ticker will not do", () => {
    const tokenAddress = paramOf("dexscreener.tokenPairs", "tokenAddress");
    expect(tokenAddress.description).toMatch(/ticker is not identity/i);
    expect(tokenAddress.description).toContain("dexscreener__pairs_search");
  });

  // ── The narrative handoff (tool 14) ──────────────────────────────

  it("dexscreener.trending sends the model the id and warns off the slug", () => {
    // Measured: the screener matches 0 pairs on the slug and 243 on the id.
    // Sending the slug produces an empty board that reads as a real answer,
    // which is the single most expensive mistake this tool can cause.
    const description = descriptionOf("dexscreener.trending");
    expect(description).toContain("metaIds");
    expect(description).toContain("`id`");
    expect(description).toMatch(/not.*`slug`|slug.*zero pairs/i);
    expect(description).toContain("243");
  });

  it("dexscreener.trending says it returns narratives and not individual tokens", () => {
    // The exact confusion the rename to `dexscreener__narratives_list` exists
    // to end, restated on the reclaimed identity.
    expect(descriptionOf("dexscreener.trending")).toMatch(/NARRATIVES, not individual tokens/i);
  });

  it("dexscreener.trending calls narrative membership a provider classification", () => {
    expect(descriptionOf("dexscreener.trending")).toMatch(/opaque classification/i);
    expect(descriptionOf("dexscreener.trending")).toMatch(/not a measured/i);
  });

  it("dexscreener.trending answers a quiet chain instead of refusing it, and says so", () => {
    // CONTRACT CHANGE (S8 / I10). This test used to pin the opposite: that a
    // chain whose catalog entry said `metasEnabled: false` was REFUSED BY NAME
    // rather than answered empty. The premise was measured false. That flag is
    // the SITE'S VISIBILITY LABEL, not a data gate: narratives aggregate
    // normally on chains the site does not surface, confirmed live on
    // robinhood (7 of 18 active), ton and polygon. The refusal was therefore
    // denying real data to protect against an ambiguity that does not exist.
    //
    // The replacement contract is stricter, not weaker: an empty answer must
    // not read as "narratives do not exist here" either, so the tool must
    // distinguish a QUIET chain from an unsupported one in words, and must not
    // go on advertising a refusal it no longer performs.
    const description = descriptionOf("dexscreener.trending");
    expect(description).toMatch(/quiet/i);
    expect(description).not.toMatch(/refused by name/i);
    const chain = paramOf("dexscreener.trending", "chain").description;
    expect(chain).not.toMatch(/REFUSED/);
    // The one refusal that remains is a slug that is not a chain at all.
    expect(description).toMatch(/visibility|not a data gate/i);
  });

  it("dexscreener.trending accounts for topTokens rather than leaving a thin row ambiguous", () => {
    expect(descriptionOf("dexscreener.trending")).toContain("topTokens");
    const topTokens = paramOf("dexscreener.trending", "topTokens");
    expect(topTokens.type).toBe("number");
    expect(topTokens.description).toContain("topTokensCoverage");
  });

  // ── Passages carry the same corrections ──────────────────────────
  //
  // The passage is what retrieval matches on, so a claim corrected only in the
  // description keeps being taught. These pin the bounded semantic facts, not
  // the prose.

  it("the search passage keeps identity honesty and names its successors", () => {
    const passage = passageOf("dexscreener.search");
    expect(passage.toLowerCase()).toContain("ticker is not identity");
    expect(passage).toContain("dexscreener__pair_get");
    expect(passage).toContain("dexscreener__token_pairs_list");
  });

  it("the token-pools passage never promises every pool", () => {
    const passage = passageOf("dexscreener.tokenPairs");
    expect(passage.toLowerCase()).toContain("returned window");
    expect(passage.toLowerCase()).not.toContain("every pool");
  });

  it("the narratives passage routes individual pairs elsewhere", () => {
    const passage = passageOf("dexscreener.trending");
    expect(passage.toLowerCase()).toContain("individual pairs live in the screening tools");
    expect(passage.toLowerCase()).toContain("narrative id");
  });

  // ── Descriptions must not contradict the runtime ─────────────────

  it("no description teaches a foreign param without saying whose it is", () => {
    // The cheapest class of description defect: a sentence that survived a
    // param rename and now names a key its tool does not accept.
    //
    // Naming a FOREIGN param is legitimate in exactly two shapes, and both are
    // load-bearing on this surface, so both are allowed rather than special-
    // cased away:
    //   1. a HANDOFF - the sentence also names the tool that owns the param
    //      (`dexscreener__...`), or the vocabulary it supplies. This is how
    //      `chains` advertises `chainIds`/`dexIds`/`labels` and how
    //      `narratives_list` points `id` at the screeners' `metaIds`.
    //   2. an explicit ABSENCE - the sentence says the param is NOT offered.
    //      `pairs_search` and `token_pairs_list` must be able to say "there is
    //      deliberately no `offset`", because an agent that assumes one exists
    //      is the failure the sentence prevents.
    // Anything else is a stale sentence teaching a key that will be rejected.
    const everyParamKey = new Set(
      DEXSCREENER_TOOLS.flatMap((tool) => tool.params.map((param) => param.key)),
    );
    // "another tool owns this" reads, in practice, as one of: the tool's
    // public name, a screening reference, or a verb of transfer.
    const HANDOFF = /dexscreener__|screening|comes? from|supplies|discover valid|passing this|accepts as a filter|parameter needs/i;
    const ABSENCE = /\bno\b|\bnot\b|never|without|absent|deliberately/i;

    const problems: string[] = [];
    for (const tool of DEXSCREENER_TOOLS) {
      const declared = new Set(tool.params.map((param) => param.key));
      for (const sentence of tool.description.split(/(?<=[.!?])\s+/)) {
        for (const match of sentence.matchAll(/`([a-z][A-Za-z0-9]*)`/g)) {
          const token = match[1];
          if (token === undefined) continue;
          if (!everyParamKey.has(token) || declared.has(token)) continue;
          if (HANDOFF.test(sentence) || ABSENCE.test(sentence)) continue;
          problems.push(
            `${tool.toolId} teaches \`${token}\`, which it does not declare, `
            + `without naming its owner or its absence: "${sentence}"`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  /* ---------------------------------------------------------------- */
  /* The token channel's vocabulary is not the pair channel's          */
  /* ---------------------------------------------------------------- */

  describe("dexscreener__tokens_screen declares only what the v2 channel honours", () => {
    const TOKENS = "dexscreener.tokens.screen";

    it("does not declare requireProfile, which this channel ignores", () => {
      // Measured: baseline, `filters[enhancedTokenInfo]=true` and `=false`
      // returned byte-identical 91,955-byte frames with the same 100 tokens.
      // Declaring it let the envelope echo it in `filtersApplied` as if it had
      // selected something. The same filter is an exact partition on the v7
      // pairs channel (30,847 true / 33,554 false of 64,401), so it stays
      // there and only here is it removed.
      expect(paramKeys(TOKENS)).not.toContain("requireProfile");
      for (const pairsTool of [
        "dexscreener.pairs.trending",
        "dexscreener.pairs.top",
        "dexscreener.gainers",
        "dexscreener.losers",
      ]) {
        expect(paramKeys(pairsTool)).toContain("requireProfile");
      }
    });

    it("answers a requireProfile call with the reason, not a bare unknown-key", () => {
      const reason = toolById(TOKENS).rejectedParams?.["requireProfile"];
      expect(reason).toBeDefined();
      expect(reason).toContain("profile-carrying tokens ONLY");
    });

    it("offers pairAge and sortDir, and refuses marketCap as a rank key", () => {
      const sortBy = paramOf(TOKENS, "sortBy");
      // pairAge and a direction are the two axes the channel honours and the
      // tool could not reach: without them there was no way to ask this
      // channel for the newest tokens at all.
      expect(sortBy.enum).toContain("pairAge");
      expect(paramKeys(TOKENS)).toContain("sortDir");
      // marketCap is accepted by the provider and answers with a degenerate
      // board: 43 rows in total, 18 of 42 adjacent pairs out of order on the
      // ranked column, JUP at 3.68 trillion USD.
      expect(sortBy.enum).not.toContain("marketCap");
      expect(sortBy.description).toContain("marketCap");
    });

    it("states the three semantic hazards in the model-visible description", () => {
      const description = toolById(TOKENS).description;
      // Aggregates, representative-pool valuation, profile-only coverage. Each
      // one produces a wrong answer when it is missing, and the previous
      // description ("deduplicated by base token") asserted the opposite.
      expect(description).toContain("SUMMED across the token's pools");
      expect(description).toContain("representative-pool values");
      expect(description).toContain("profile-carrying tokens only");
      expect(description).toContain("repeats are flagged by token");
      expect(description).not.toContain("deduplicated by base token");
    });
  });
});
