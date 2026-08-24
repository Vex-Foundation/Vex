/**
 * W0 — manifest convention linter.
 *
 * Freezes the param/description convention (`protocols/conventions.ts`) across
 * BOTH model-facing lanes: the protocol manifests reached through
 * `discover_tools`/`execute_tool`, and the action-alias + wallet JSON schemas
 * the model reaches first. Every alias-vs-protocol drift found by the audit
 * (D9, D10) existed because only one lane was pinned.
 *
 * The tree is out of convention today, so `_manifest-lint/allowlist.ts` lists
 * every current violation. This suite therefore proves three things at once:
 * no NEW violation, no STALE allowlist entry, and no silent widening of a rule.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import { WALLET_TOOLS } from "@vex-agent/tools/registry/wallet.js";
import { WALLET_TRANSACTION_TOOLS } from "@vex-agent/tools/registry/wallet-transaction.js";
import { CANONICAL_CHAIN_SLUGS } from "@vex-agent/tools/protocols/conventions.js";
import { readRejectedParamReason } from "@vex-agent/tools/protocols/runtime/params.js";
import { listLocalChains } from "@tools/evm-chains/registry.js";
import { PROTOCOL_NAMESPACE_NAVIGATION } from "@vex-agent/tools/protocols/descriptions.js";
import type { ProtocolNamespaceNavigation } from "@vex-agent/tools/protocols/navigation/types.js";
// Deep import: the dotted rule's two subject builders are internal projections
// with no consumer outside this suite, so they are not widened onto the
// `_manifest-lint` public gate merely to be tested.
import {
  lintDottedToolIdReferences,
  navigationProseSubject,
  toolProseSubject,
} from "@vex-agent/tools/protocols/_manifest-lint/dotted-toolid-rules.js";
import {
  isLinterOwnSource,
  lintGenericErrorLiterals,
  lintSlippageDefaultHome,
  lintStaleOutputCapClaims,
  lintToolSubject,
  MANIFEST_LINT_ALLOWLIST,
  SLIPPAGE_DEFAULT_OWNER,
  staleAllowlistKeys,
  toLintSubject,
  toSchemaLintSubject,
  withoutAllowlisted,
  type ManifestLintIssue,
  type SourceFile,
} from "@vex-agent/tools/protocols/_manifest-lint.js";

const REPO_ROOT = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function readSources(relativeDir: string): SourceFile[] {
  return walk(join(REPO_ROOT, relativeDir)).map((file) => ({
    path: relative(REPO_ROOT, file).split(sep).join("/"),
    text: readFileSync(file, "utf-8"),
  })).filter((source) => !isLinterOwnSource(source.path));
}

function format(issues: readonly ManifestLintIssue[]): string {
  return issues.map((i) => `  - ${i.subject} [${i.rule}/${i.detail}] ${i.message}`).join("\n");
}

const protocolIssues = PROTOCOL_TOOLS.flatMap((manifest) => lintToolSubject(toLintSubject(manifest)));

const aliasIssues = [...ACTION_ALIAS_TOOLS, ...WALLET_TOOLS, ...WALLET_TRANSACTION_TOOLS].flatMap((tool) =>
  lintToolSubject(
    toSchemaLintSubject({
      name: tool.name,
      description: tool.description,
      mutating: tool.mutating,
      parameters: tool.parameters,
    }),
  ),
);

const protocolSources = readSources("src/vex-agent/tools/protocols");

/**
 * The scan roots for `stale-output-cap-claim`, which is DELIBERATELY wider than
 * the protocol tree.
 *
 * The phantom 16,384 B cap was asserted from four different owners: the research
 * system prompt (`engine/prompts`), two internal tool definitions
 * (`tools/registry`), a runtime error returned to the model (`tools/internal`),
 * and protocol manifests + their comments (`tools/protocols`). A rule scoped to
 * the protocol tree alone would have caught three of eight model-facing sites,
 * so it would not be the guard it claims to be.
 */
const OUTPUT_CAP_SCAN_ROOTS: readonly string[] = [
  "src/vex-agent/engine/prompts",
  "src/vex-agent/tools/protocols",
  "src/vex-agent/tools/registry",
  "src/vex-agent/tools/internal",
];

const outputCapSources = OUTPUT_CAP_SCAN_ROOTS.flatMap((root) => readSources(root));

const sourceIssues = [
  ...lintGenericErrorLiterals(protocolSources),
  ...lintSlippageDefaultHome([...protocolSources, ...readSources("src/tools")]),
  ...lintStaleOutputCapClaims(outputCapSources),
];

/**
 * Batch 3 Wave 1: the dotted-toolId sweep's guard. Read off the LIVE catalog
 * rather than the `tool-surface-spec/mappings/*.json` artifacts on purpose -
 * `public-name-gate` already proves those two agree in both directions, and a
 * lint that re-reads the artifact would fail for artifact drift under a rule
 * about prose.
 */
const dottedCatalog = PROTOCOL_TOOLS.map((manifest) => ({
  toolId: manifest.toolId,
  publicName: manifest.publicName,
}));

/**
 * Both model-visible prose lanes, in ONE issue stream against ONE catalog.
 *
 * The manifests are what `discover_tools` returns; the namespace navigation is
 * what `engine/prompts/protocols.ts` renders into the standing protocols layer.
 * A dotted id costs the model the same wasted turn either way, so they are held
 * to the same zero. The navigation records are NOT catalog identities: a
 * namespace is not a callable tool, and `navigationProseSubject` keys its issues
 * by the namespace without ever claiming a `publicName` for it.
 */
const dottedIssues = lintDottedToolIdReferences(dottedCatalog, [
  ...PROTOCOL_TOOLS.map((manifest) => toolProseSubject({
    toolId: manifest.toolId,
    publicName: manifest.publicName,
    description: manifest.description,
    params: manifest.params.map((param) => ({ key: param.key, description: param.description })),
  })),
  ...Object.values(PROTOCOL_NAMESPACE_NAVIGATION).map(navigationProseSubject),
]);

const allIssues = [...protocolIssues, ...aliasIssues, ...sourceIssues, ...dottedIssues];

/** Three live Morpho ids, as identity only, for the reintroduction fixture. */
const MORPHO_FIXTURE_CATALOG = [
  { toolId: "morpho.market.get", publicName: "morpho__market_get" },
  { toolId: "morpho.market.quote", publicName: "morpho__market_quote" },
  { toolId: "morpho.markets.discover", publicName: "morpho__markets_discover" },
];

/** A navigation record with every required field, overridden per case. */
function navigationFixture(
  overrides: Partial<ProtocolNamespaceNavigation>,
): ProtocolNamespaceNavigation {
  return {
    namespace: "morpho",
    advertised: true,
    groupId: "evm-trading",
    groupLabel: "EVM trading",
    summary: "fixture",
    whenToUse: "fixture",
    exampleQueries: [],
    aliases: [],
    discoveryHints: [],
    facets: [],
    declaration: {
      identity: "fixture",
      read: "fixture",
      quote: "fixture",
      act: "fixture",
      whenItApplies: "fixture",
      characteristicAndLimits: "fixture",
      retrievalTerms: [],
      facets: [],
    },
    ...overrides,
  };
}

describe("W0 — manifest convention linter", () => {
  it("reads a non-empty surface (sanity)", () => {
    expect(PROTOCOL_TOOLS.length).toBeGreaterThan(0);
    expect(ACTION_ALIAS_TOOLS.length + WALLET_TOOLS.length).toBeGreaterThan(0);
    expect(protocolSources.length).toBeGreaterThan(0);
  });

  it("no protocol manifest violates the convention outside the allowlist", () => {
    const live = withoutAllowlisted(protocolIssues);
    expect(live, `unallowlisted protocol manifest violations:\n${format(live)}`).toEqual([]);
  });

  it("no action-alias or wallet tool violates the convention outside the allowlist", () => {
    const live = withoutAllowlisted(aliasIssues);
    expect(live, `unallowlisted alias/wallet violations:\n${format(live)}`).toEqual([]);
  });

  it("no source-level violation (generic errors, second slippage default) outside the allowlist", () => {
    const live = withoutAllowlisted(sourceIssues);
    expect(live, `unallowlisted source violations:\n${format(live)}`).toEqual([]);
  });

  // W4b: the slippage default now has EXACTLY ONE home. This is stronger than
  // "no unallowlisted violation" above — it proves the debt is gone rather than
  // merely recorded, so a future copy cannot be re-admitted by adding a line to
  // the allowlist.
  it("exactly one module declares a slippage default, and no entry allowlists a second", () => {
    const slippageIssues = lintSlippageDefaultHome([
      ...protocolSources,
      ...readSources("src/tools"),
    ]);
    expect(
      slippageIssues,
      `a second slippage default exists — move it onto ${SLIPPAGE_DEFAULT_OWNER}:\n${format(slippageIssues)}`,
    ).toEqual([]);
    expect(MANIFEST_LINT_ALLOWLIST.filter((e) => e.rule === "slippage-default-home")).toEqual([]);
  });

  // Batch 3 Wave 0: the phantom output cap. Modelled on the W4b slippage test
  // rather than on the debt tables, and for the same reason: the goal is ZERO
  // occurrences, not a recorded set. Asserting the allowlist is empty for this
  // rule is what stops a future claim from being re-admitted as debt.
  it("no model-visible string asserts a global tool-output cap, and none is allowlisted", () => {
    const capIssues = lintStaleOutputCapClaims(outputCapSources);
    expect(
      capIssues,
      "these strings assert a tool-output byte cap the runtime does not enforce:\n"
        + format(capIssues),
    ).toEqual([]);
    expect(MANIFEST_LINT_ALLOWLIST.filter((e) => e.rule === "stale-output-cap-claim")).toEqual([]);
  });

  // Batch 3 Wave 1: the dotted tool id. Same zero-and-empty-allowlist shape as
  // the output-cap test above, for the same reason - a manifest that names
  // `morpho.market.get` costs the model a turn and an unknown-tool refusal,
  // because `publicName` is the only name `injected-protocol-tools.ts`
  // projects. There is no version of that worth recording as debt.
  it("no manifest, param or navigation prose names a dotted tool id, and none is allowlisted", () => {
    expect(
      dottedIssues,
      "these model-visible strings tell the model to call a name it cannot call:\n"
        + format(dottedIssues),
    ).toEqual([]);
    expect(MANIFEST_LINT_ALLOWLIST.filter((e) => e.rule === "dotted-toolid-reference")).toEqual([]);
  });

  // Proves the rule above is not vacuously green: same live catalog, one
  // description mutated back to the pre-sweep spelling. Without this, a regex
  // that silently stopped matching would read as a clean tree.
  it("flags a dotted tool id reintroduced into a description, and resolves its publicName", () => {
    const issues = lintDottedToolIdReferences(MORPHO_FIXTURE_CATALOG, [
      toolProseSubject({
        toolId: "morpho.market.quote",
        publicName: "morpho__market_quote",
        description: "Quote a supply. Read the market with morpho.market.get first.",
        params: [{ key: "marketId", description: "The id from morpho.markets.discover." }],
      }),
    ]);

    expect(issues.map((issue) => `${issue.subject} ${issue.detail}`)).toEqual([
      "morpho.market.quote description/morpho.market.get",
      "morpho.market.quote param:marketId/morpho.markets.discover",
    ]);
    expect(issues[0]?.message).toContain("morpho__market_get");
    expect(issues[1]?.message).toContain("morpho__markets_discover");
  });

  // A dotted shape in a live namespace that resolves to NO live tool is the
  // worse case, not the safer one: it names something retired or invented, so
  // the rule must fail loudly rather than propose an unverified substitution.
  it("flags a dotted shape that resolves to no live tool, without inventing a replacement", () => {
    const issues = lintDottedToolIdReferences(
      [{ toolId: "pendle.market.get", publicName: "pendle__market_get" }],
      [toolProseSubject({
        toolId: "pendle.market.get",
        publicName: "pendle__market_get",
        description: "Read a market. For the raw feed call pendle.oracle.read instead.",
        params: [],
      })],
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toBe("description/pendle.oracle.read");
    expect(issues[0]?.message).toContain("not a live tool id at all");
  });

  // A MERGED tool's retired id (`dexscreener.boosts.top` folded into
  // `dexscreener.boosts` under D7) prefix-resolves to the survivor, and the
  // message must say the dropped segment became a parameter rather than
  // proposing a name with a stray suffix welded on.
  it("resolves a merged-away id to the surviving tool and names the leftover as a parameter", () => {
    const issues = lintDottedToolIdReferences(
      [{ toolId: "dexscreener.boosts", publicName: "dexscreener__boosts_list" }],
      [toolProseSubject({
        toolId: "dexscreener.boosts",
        publicName: "dexscreener__boosts_list",
        description: "Read boosts. For the top slice call dexscreener.boosts.top instead.",
        params: [],
      })],
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toBe("description/dexscreener.boosts.top");
    expect(issues[0]?.message).toContain("dexscreener__boosts_list");
    expect(issues[0]?.message).toContain("express it as that tool's parameter");
  });

  // The brand and the hostname are not tool ids, and excusing them as debt
  // would misfile them. Decided in the rule, asserted here so a later edit to
  // `NON_TOOL_TOKENS` cannot quietly widen it.
  it("does not flag the venue brand or a hostname that contains a namespace", () => {
    const issues = lintDottedToolIdReferences(
      [{ toolId: "pools.tokens", publicName: "pools__tokens_discover" }],
      [toolProseSubject({
        toolId: "pools.tokens",
        publicName: "pools__tokens_discover",
        description: "Newly launched tokens on pools.fun. Merkle claims are made at app.pendle.finance.",
        params: [],
      })],
    );

    expect(issues).toEqual([]);
  });

  // ── The navigation lane ───────────────────────────────────────────────────
  //
  // A namespace navigation record is model-visible prose (the protocols prompt
  // layer renders `summary`, `whenToUse`, `preferInstead`, the facet lines and
  // the `Try:` line verbatim) but it is NOT a tool. These cases pin that it is
  // scanned as prose against the tool catalog, and never admitted to it.

  it("flags a dotted tool id in navigation preferInstead and names its publicName", () => {
    const issues = lintDottedToolIdReferences(
      [{ toolId: "solana.lend.earn.deposit", publicName: "solana__lend_earn_deposit" }],
      [navigationProseSubject(navigationFixture({
        preferInstead: "Use solana.lend.earn.deposit for lending on Solana.",
      }))],
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.subject).toBe("morpho");
    expect(issues[0]?.detail).toBe("preferInstead/solana.lend.earn.deposit");
    expect(issues[0]?.message).toContain("solana__lend_earn_deposit");
    // The COMPLETE field, not a window around the match.
    expect(issues[0]?.message).toContain("Use solana.lend.earn.deposit for lending on Solana.");
  });

  it("does not flag a bare namespace word in navigation prose", () => {
    const issues = lintDottedToolIdReferences(
      [{ toolId: "solana.lend.earn.deposit", publicName: "solana__lend_earn_deposit" }],
      [navigationProseSubject(navigationFixture({
        preferInstead: "Use solana for lending on Solana.",
        summary: "Morpho lends on EVM chains; solana does the Solana side.",
      }))],
    );

    expect(issues).toEqual([]);
  });

  it("never scans toolPrefixes, which are durable dotted identity", () => {
    const issues = lintDottedToolIdReferences(
      [{ toolId: "morpho.market.quote", publicName: "morpho__market_quote" }],
      [navigationProseSubject(navigationFixture({
        facets: [{
          label: "Markets",
          summary: "Blue markets.",
          // Both fields below are matched against `toolId` by the catalog, so
          // dotted is CORRECT here and flagging it would invert the rule.
          toolPrefixes: ["morpho.market.", "morpho.markets."],
          hints: ["quote a borrow on morpho.market.quote"],
        }],
      }))],
    );

    expect(issues).toEqual([]);
  });

  it("does not flag the venue brand in navigation prose", () => {
    const issues = lintDottedToolIdReferences(
      [{ toolId: "pools.tokens", publicName: "pools__tokens_discover" }],
      [navigationProseSubject(navigationFixture({
        summary: "Token launches on pools.fun.",
        exampleQueries: ["what launched on pools.fun today"],
      }))],
    );

    expect(issues).toEqual([]);
  });

  it("the allowlist carries no stale entry (a fixed violation must be deleted, not kept)", () => {
    const stale = staleAllowlistKeys(allIssues);
    expect(
      stale,
      `these allowlist entries no longer match a live violation — delete them:\n${stale.map((k) => `  - ${k}`).join("\n")}`,
    ).toEqual([]);
  });

  // An enum whose members differ only by case is a MANIFEST DEFECT, not a
  // style question: `runtime/params.ts` resolves a case-insensitive match to the
  // FIRST declared member, so `["base","BASE"]` silently discards the second
  // spelling and makes the handler-visible value depend on declaration order.
  // The approval fingerprint hashes that order for the same reason; the linter
  // is what stops an ambiguous enum reaching the fleet in the first place.
  it("no enum declares two members that differ only by case", () => {
    const ambiguous = allIssues.filter((issue) => issue.rule === "enum-case-uniqueness");
    expect(
      ambiguous,
      `an ambiguous enum can never yield its later spelling:\n${format(ambiguous)}`,
    ).toEqual([]);
    expect(MANIFEST_LINT_ALLOWLIST.filter((e) => e.rule === "enum-case-uniqueness")).toEqual([]);
  });

  it("flags an enum whose members collide case-insensitively", () => {
    const issues = lintToolSubject({
      subject: "test.enum",
      description: "fixture",
      mutating: false,
      params: [{
        key: "chain",
        type: "string",
        description: "fixture",
        required: true,
        enum: ["base", "BASE"],
      }],
    });

    const flagged = issues.filter((issue) => issue.rule === "enum-case-uniqueness");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.detail).toBe("chain");
    expect(flagged[0]?.message).toContain("base");
  });

  it("accepts an enum whose members are distinct case-insensitively", () => {
    const issues = lintToolSubject({
      subject: "test.enum",
      description: "fixture",
      mutating: false,
      params: [{
        key: "chain",
        type: "string",
        description: "fixture",
        required: true,
        enum: ["base", "Arbitrum", "solana"],
      }],
    });

    expect(issues.filter((issue) => issue.rule === "enum-case-uniqueness")).toEqual([]);
  });

  // `rejectedParams` is read by the param boundary and its text is spliced into
  // a message the agent reads, so the table itself is a contract — fleet-wide,
  // not per-namespace. Each rule below closes a way the table can be wrong:
  //
  //  - a PROTOTYPE-inherited key (`constructor`, `toString`) is not data. The
  //    boundary indexes this table with a MODEL-SUPPLIED key, so before the
  //    `Object.hasOwn` guard landed, sending `constructor` put
  //    "function Object() { [native code] }" into the rejection message.
  //  - a non-string or empty value would splice `undefined`/nothing into that
  //    same sentence, which is the generic-error failure the table exists to
  //    prevent.
  //  - a key that is ALSO a declared param advertises a filter as working and
  //    explains it as impossible in the same manifest.
  it("every rejectedParams table is own-key, string-valued, and disjoint from declared params", () => {
    const problems: string[] = [];
    for (const manifest of PROTOCOL_TOOLS) {
      const table = manifest.rejectedParams;
      if (table === undefined) continue;

      // Asserted through the ACCESSOR the boundary itself uses, not a copy of
      // its rule: every object literal inherits these keys, so what has to hold
      // is that the lookup refuses them, not that the object lacks them.
      for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
        if (readRejectedParamReason(manifest, key) !== undefined) {
          problems.push(`${manifest.toolId}: "${key}" resolves to an explanation through the prototype chain`);
        }
      }

      const declared = new Set(manifest.params.map((param) => param.key));
      for (const key of Object.keys(table)) {
        const value = table[key];
        if (typeof value !== "string" || value.trim().length === 0) {
          problems.push(`${manifest.toolId}.${key}: rejection reason must be a non-empty string`);
        }
        if (declared.has(key)) {
          problems.push(
            `${manifest.toolId}.${key}: declared as a real param AND listed as rejected — pick one`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("CANONICAL_CHAIN_SLUGS covers every locally-registered chain", () => {
    const uncovered = listLocalChains().filter(
      (chain) => !chain.aliases.some((alias) => CANONICAL_CHAIN_SLUGS.has(alias)),
    );
    expect(
      uncovered.map((c) => c.name),
      "a chain in the local EVM registry has no canonical slug — add it to CANONICAL_CHAIN_SLUGS deliberately",
    ).toEqual([]);
  });
});
