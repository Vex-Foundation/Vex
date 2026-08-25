/**
 * G2(a) - the catalog-wide publicName gate.
 *
 * Three surfaces, all live since Batch 2 put `publicName` on the manifests:
 *
 * 1. every SHIPPED `publicName` obeys the grammar and is unique catalog-wide,
 *    which is precisely the promise `registry/injected-protocol-tools.ts`
 *    builds its reverse lookup on;
 * 2. the naming spec's machine-readable artifacts
 *    (`src/vex-agent/tools/tool-surface-spec/mappings/<namespace>.json`) are
 *    internally consistent and complete against the live catalog;
 * 3. the two AGREE, exactly, in both directions.
 *
 * A permanent regression gate: a tool added later with no mapping row fails
 * here by name pointing at the artifact file to edit, and a manifest renamed
 * without its artifact row fails as a mismatch naming both spellings.
 *
 * The rules themselves live in the production module
 * `@vex-agent/tools/protocols/public-name-gate.js` - the projection and the
 * gate share ONE grammar owner - and they are pure, so the failure modes are
 * proven in memory below rather than by mutating a spec artifact.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import {
  formatPublicNameIssues,
  lintPublicNameArtifacts,
  lintPublicNameCompleteness,
  lintPublicNameGrammar,
  lintPublicNameUniqueness,
  parsePublicNameArtifact,
  type PublicNameArtifact,
  type PublicNameIssue,
  lintArtifactManifestAgreement,
  lintManifestPublicNames,
} from "@vex-agent/tools/protocols/public-name-gate.js";

const MAPPINGS_DIR = "src/vex-agent/tools/tool-surface-spec/mappings";

const parseIssues: PublicNameIssue[] = [];
const artifacts: PublicNameArtifact[] = [];

for (const name of readdirSync(join(process.cwd(), MAPPINGS_DIR)).sort()) {
  if (!name.endsWith(".json")) continue;
  const file = `${MAPPINGS_DIR}/${name}`;
  const text = readFileSync(join(process.cwd(), file), "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    parseIssues.push({
      subject: file, rule: "artifact-schema", detail: "json",
      message: `artifact is not valid JSON: ${(error as Error).message}`,
    });
    continue;
  }
  const parsed = parsePublicNameArtifact(file, raw);
  parseIssues.push(...parsed.issues);
  if (parsed.artifact) artifacts.push(parsed.artifact);
}

const manifestPublicNameById = new Map<string, string>(
  PROTOCOL_TOOLS.map((manifest) => [manifest.toolId, manifest.publicName]),
);

const liveNamespaceById = new Map<string, string>(
  PROTOCOL_TOOLS.map((manifest) => [manifest.toolId, manifest.namespace]),
);

describe("G2 - publicName mapping gate", () => {
  it("every mapping artifact parses into the declared schema", () => {
    expect(
      parseIssues,
      `mapping artifacts are malformed:\n${formatPublicNameIssues(parseIssues)}`,
    ).toEqual([]);
    expect(artifacts.length, "no mapping artifact was read").toBeGreaterThan(0);
  });

  it("one artifact exists per registered namespace, and nothing else", () => {
    const artifactNamespaces = artifacts.map((a) => a.namespace).sort();
    const liveNamespaces = [...new Set(PROTOCOL_TOOLS.map((m) => m.namespace))].sort();
    expect(artifactNamespaces).toEqual(liveNamespaces);
  });

  it("every publicName obeys the namespace__resource_action grammar", () => {
    const issues = artifacts.flatMap((artifact) =>
      artifact.entries.flatMap((entry) => lintPublicNameGrammar(artifact, entry)),
    );
    expect(issues, `publicName grammar violations:\n${formatPublicNameIssues(issues)}`).toEqual([]);
  });

  it("publicName and toolId are unique across the whole catalog", () => {
    const issues = lintPublicNameUniqueness(artifacts);
    expect(issues, `duplicate names or ids:\n${formatPublicNameIssues(issues)}`).toEqual([]);
  });

  // The load-bearing one: a tool added without a mapping row, or a row naming a
  // tool that no longer exists, both fail here.
  it("every registered protocol tool is mapped exactly once, and no row is orphaned", () => {
    const issues = lintPublicNameCompleteness(artifacts, liveNamespaceById);
    expect(
      issues,
      `mapping is not in sync with the live catalog:\n${formatPublicNameIssues(issues)}`,
    ).toEqual([]);

    const mappedCount = artifacts.reduce((sum, artifact) => sum + artifact.entries.length, 0);
    expect(mappedCount).toBe(liveNamespaceById.size);
  });

  // The surface the projection actually reads. An artifact can be perfect and
  // the shipped catalog still wrong, so the manifests are gated in their own
  // right rather than by proxy through the artifacts.
  it("every SHIPPED publicName obeys the grammar and is unique catalog-wide", () => {
    const issues = lintManifestPublicNames(PROTOCOL_TOOLS);
    expect(
      issues,
      `live manifest publicName violations:\n${formatPublicNameIssues(issues)}`,
    ).toEqual([]);
  });

  it("the artifacts and the manifests state the same publicName for every tool", () => {
    const issues = lintArtifactManifestAgreement(artifacts, manifestPublicNameById);
    expect(
      issues,
      `mapping artifact disagrees with the live manifest:\n${formatPublicNameIssues(issues)}`,
    ).toEqual([]);
    // Both directions: completeness above proves every live id is mapped, so a
    // matching count here proves no artifact row named a tool that is gone.
    expect(manifestPublicNameById.size).toBe(
      artifacts.reduce((sum, artifact) => sum + artifact.entries.length, 0),
    );
  });

  it("the mapped surface is the whole 136-tool catalog (drift alarm, not a cap)", () => {
    // Not a limit: a Batch-2 addition updates this number together with its
    // mapping row, so the count and the map can never diverge silently.
    // 137 before the Batch 2 near-duplicate merges (owner decision D7) retired
    // `kyberswap.chains.supported`, `dexscreener.profiles.recent` and
    // `dexscreener.boosts.top` into their surviving siblings' parameters.
    // 134 before the DexScreener site surface (stage S2b) added its eight
    // agent-visible tools: the six screening boards, the chain catalog and the
    // token-level screen.
    // 142 before stage S3 added the three resolve and market-context tools it
    // could land: the single-pair snapshot, the spotlight feeds and the
    // explicit-identity batch.
    // 145 before stage S3.5, which is the only step in this history that made
    // the catalog SMALLER: it retired the 12 public-API DexScreener tools whole
    // and alias-free (owner decision D-DS2) and landed the three that were
    // blocked on their identities. Net 12 removed, 3 added. Three of the
    // retired identities were RECLAIMED rather than freed - `dexscreener.search`,
    // `dexscreener.tokenPairs` and `dexscreener.trending` keep their toolIds AND
    // publicNames on the site-channel tools that now answer the same questions -
    // so the mapping artifact lost nine rows, not twelve.
    // 136 before stage S4, which added the four DexScreener deep-dive tools:
    // `pair.details`, `candles`, `trades` and `top.traders`. All four are new
    // identities - no toolId is reclaimed, because none of the retired
    // public-API tools answered any part of what they answer.
    // 140 before the Indexify integration, which added the 13-tool `indexify`
    // namespace (10 reads, trade_execute, order_resolve, stack_create) — the
    // tree's first custodial API venue. All new identities.
    expect(PROTOCOL_TOOLS.length).toBe(153);
  });
});

// ── Failure modes, proven in memory ──────────────────────────────

const FIXTURE_LIVE = new Map<string, string>([
  ["demo.thing.read", "demo"],
  ["demo.thing.write", "demo"],
]);

function fixture(entries: readonly { toolId: string; publicName: string }[]): PublicNameArtifact {
  return {
    file: "fixture/demo.json",
    namespace: "demo",
    entries: entries.map((e) => ({ ...e, rationale: "fixture" })),
  };
}

describe("G2 - publicName gate failure modes", () => {
  it("names the toolId and the artifact file when a live tool has no mapping row", () => {
    const issues = lintPublicNameCompleteness(
      [fixture([{ toolId: "demo.thing.read", publicName: "demo__thing_read" }])],
      FIXTURE_LIVE,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("missing-tool-id");
    expect(issues[0]?.message).toContain("demo.thing.write");
    expect(issues[0]?.message).toContain("mappings/demo.json");
  });

  it("rejects a row that names a toolId the catalog does not register", () => {
    const issues = lintPublicNameCompleteness(
      [fixture([
        { toolId: "demo.thing.read", publicName: "demo__thing_read" },
        { toolId: "demo.thing.write", publicName: "demo__thing_write" },
        { toolId: "demo.ghost", publicName: "demo__ghost_get" },
      ])],
      FIXTURE_LIVE,
    );
    expect(issues.map((i) => i.rule)).toEqual(["unknown-tool-id"]);
    expect(issues[0]?.detail).toBe("demo.ghost");
  });

  it("rejects a row filed under the wrong namespace artifact", () => {
    const issues = lintPublicNameCompleteness(
      [{
        file: "fixture/other.json",
        namespace: "other",
        entries: [
          { toolId: "demo.thing.read", publicName: "other__thing_read", rationale: "fixture" },
          { toolId: "demo.thing.write", publicName: "other__thing_write", rationale: "fixture" },
        ],
      }],
      FIXTURE_LIVE,
    );
    expect(issues.filter((i) => i.rule === "namespace-mismatch")).toHaveLength(2);
  });

  it("rejects a duplicated publicName across two artifacts", () => {
    const issues = lintPublicNameUniqueness([
      fixture([{ toolId: "demo.thing.read", publicName: "demo__thing_read" }]),
      { ...fixture([{ toolId: "demo.thing.write", publicName: "demo__thing_read" }]), file: "fixture/dup.json" },
    ]);
    expect(issues.map((i) => i.rule)).toEqual(["duplicate-public-name"]);
  });

  it("rejects a duplicated toolId across two artifacts", () => {
    const issues = lintPublicNameUniqueness([
      fixture([{ toolId: "demo.thing.read", publicName: "demo__thing_read" }]),
      { ...fixture([{ toolId: "demo.thing.read", publicName: "demo__thing_alt" }]), file: "fixture/dup.json" },
    ]);
    expect(issues.map((i) => i.rule)).toEqual(["duplicate-tool-id"]);
  });

  it.each([
    ["demo__Thing_Read", "characters outside"],
    ["demo.thing_read", "characters outside"],
    ["demo__thing__read", "EXACTLY ONE double underscore"],
    ["demothing_read", "EXACTLY ONE double underscore"],
    ["other__thing_read", "IS the namespace"],
    ["demo___thing_read", "leading or trailing underscore"],
    ["demo__thing_read_", "leading or trailing underscore"],
    ["demo__", "empty resource_action"],
    [`demo__${"a".repeat(64)}`, "> 64"],
  ])("rejects publicName %s", (publicName, expected) => {
    const artifact = fixture([{ toolId: "demo.thing.read", publicName }]);
    const issues = lintPublicNameGrammar(artifact, artifact.entries[0]!);
    expect(issues.map((i) => i.message).join("\n")).toContain(expected);
  });

  it("accepts a well-formed name with several action segments", () => {
    const artifact = fixture([{ toolId: "demo.thing.read", publicName: "demo__thing_positions_read" }]);
    expect(lintPublicNameGrammar(artifact, artifact.entries[0]!)).toEqual([]);
  });

  it("does not pin the verb: an extension verb passes the mechanical grammar", () => {
    const artifact = fixture([{ toolId: "demo.thing.read", publicName: "demo__thing_autocomplete" }]);
    expect(lintPublicNameGrammar(artifact, artifact.entries[0]!)).toEqual([]);
  });

  it("reports a missing required field instead of throwing", () => {
    const parsed = parsePublicNameArtifact("fixture/bad.json", {
      namespace: "demo",
      entries: [{ toolId: "demo.thing.read", publicName: "demo__thing_read" }],
    });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.message).toContain("`rationale`");
  });

  it("tolerates extra per-entry metadata the spec may add later", () => {
    const parsed = parsePublicNameArtifact("fixture/extra.json", {
      namespace: "demo",
      note: "artifact-level extra",
      entries: [{
        toolId: "demo.thing.read",
        publicName: "demo__thing_read",
        rationale: "mechanical",
        lifecycle: "active",
      }],
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.artifact?.entries).toHaveLength(1);
  });

  it("names both spellings when an artifact and its manifest disagree", () => {
    const issues = lintArtifactManifestAgreement(
      [fixture([{ toolId: "demo.thing.read", publicName: "demo__thing_read" }])],
      new Map([["demo.thing.read", "demo__thing_fetch"]]),
    );
    expect(issues.map((i) => i.rule)).toEqual(["artifact-manifest-mismatch"]);
    expect(issues[0]?.message).toContain("demo__thing_read");
    expect(issues[0]?.message).toContain("demo__thing_fetch");
  });

  it("stays silent on a toolId the live catalog no longer registers (completeness owns that)", () => {
    const issues = lintArtifactManifestAgreement(
      [fixture([{ toolId: "demo.ghost", publicName: "demo__ghost_get" }])],
      new Map(),
    );
    expect(issues).toEqual([]);
  });

  // The property the injected-name reverse map depends on, checked at the
  // manifest level where the projection actually reads it.
  it("rejects two manifests claiming the same publicName, naming both owners", () => {
    const issues = lintManifestPublicNames([
      { toolId: "demo.thing.read", namespace: "demo", publicName: "demo__thing_read" },
      { toolId: "demo.thing.write", namespace: "demo", publicName: "demo__thing_read" },
    ]);
    expect(issues.map((i) => i.rule)).toEqual(["duplicate-public-name"]);
    expect(issues[0]?.subject).toBe("demo.thing.write");
    expect(issues[0]?.message).toContain("demo.thing.read");
  });

  it("reports a malformed manifest publicName against its own toolId", () => {
    const issues = lintManifestPublicNames([
      { toolId: "demo.thing.read", namespace: "demo", publicName: "demo__thing__read" },
    ]);
    expect(issues.map((i) => i.rule)).toEqual(["grammar"]);
    expect(issues[0]?.subject).toBe("demo.thing.read");
  });

  it("runs every rule together over a clean fixture", () => {
    const issues = lintPublicNameArtifacts(
      [fixture([
        { toolId: "demo.thing.read", publicName: "demo__thing_read" },
        { toolId: "demo.thing.write", publicName: "demo__thing_write" },
      ])],
      FIXTURE_LIVE,
    );
    expect(issues).toEqual([]);
  });
});
