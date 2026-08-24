#!/usr/bin/env tsx
/**
 * The Batch 3 inventory scan - the generator behind `inventory.json`.
 *
 *   INVENTORY_SHA=$(git rev-parse HEAD) pnpm exec tsx \
 *     src/vex-agent/tools/tool-surface-spec/batch3/inventory-scan.ts > \
 *     src/vex-agent/tools/tool-surface-spec/batch3/inventory.json
 *
 * It measures the LIVE TREE, never a document. Every count in `inventory.md`
 * comes from here, which is the point: Batch 3's acceptance gate is an explicit
 * frozen inventory rather than "the allowlists got smaller", and a gate whose
 * numbers were transcribed by hand is not a gate. The plan's expectations came
 * from a review; this run is the authority, and any disagreement is resolved in
 * favour of this file.
 *
 * Sits beside the artifact rather than in `src/vex-agent/scripts/` because it is
 * one batch's evidence generator with one reader, not a maintenance command.
 * `prompt-budget-report.ts` went the other way - it is re-run after Wave 2 to
 * show the effect, so it earned a package script.
 */

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { PROTOCOL_NAMESPACE_NAVIGATION } from "@vex-agent/tools/protocols/descriptions.js";
import { getAllTools } from "@vex-agent/tools/registry.js";
import { MANIFEST_LINT_ALLOWLIST } from "@vex-agent/tools/protocols/_manifest-lint/allowlist.js";
import { INTERNAL_DESCRIPTION_ALLOWLIST } from "@vex-agent/tools/protocols/_manifest-lint/internal-description-allowlist.js";

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function navFacetsFor(toolId: string): string[] {
  const out: string[] = [];
  for (const nav of Object.values(PROTOCOL_NAMESPACE_NAVIGATION)) {
    for (const facet of nav.facets) {
      if (facet.toolPrefixes.some((p) => toolId === p || toolId.startsWith(p))) out.push(`${nav.namespace}:${facet.label}`);
    }
  }
  return out;
}

const protocols = PROTOCOL_TOOLS.map((m) => ({
  toolId: m.toolId,
  publicName: m.publicName,
  namespace: m.namespace,
  descriptionBytes: bytes(m.description),
  mutating: m.mutating,
  actionKind: m.actionKind,
  paramCount: m.params.length,
  paramDescriptionBytes: m.params.reduce((a, p) => a + bytes(p.description), 0),
  hasEmbeddingText: Boolean(m.discovery?.embeddingText),
  embeddingTextBytes: m.discovery?.embeddingText ? bytes(m.discovery.embeddingText) : 0,
  hasCanonicalSummary: Boolean(m.discovery?.canonicalSummary),
  aliasCount: m.discovery?.aliases?.length ?? 0,
  exampleIntentCount: m.discovery?.exampleIntents?.length ?? 0,
  navigationFacets: navFacetsFor(m.toolId),
}));

const internal = getAllTools().map((t) => ({
  name: t.name,
  descriptionBytes: bytes(t.description),
  mutating: t.mutating,
  actionKind: t.actionKind,
}));

function tally<T>(rows: readonly T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const general = MANIFEST_LINT_ALLOWLIST;
const generalToolDesc = general.filter((e) => e.rule === "tool-description");
const nsOf = (subject: string): string => {
  const dot = subject.indexOf(".");
  const dus = subject.indexOf("__");
  if (dot > 0 && (dus < 0 || dot < dus)) return subject.slice(0, dot);
  if (dus > 0) return subject.slice(0, dus);
  return "(internal)";
};

const report = {
  measuredAt: new Date().toISOString(),
  sha: process.env.INVENTORY_SHA ?? "unknown",
  totals: {
    protocolManifests: protocols.length,
    internalTools: internal.length,
    surfaces: protocols.length + internal.length,
    generalAllowlistEntries: general.length,
    generalToolDescriptionEntries: generalToolDesc.length,
    generalToolDescriptionSubjects: new Set(generalToolDesc.map((e) => e.subject)).size,
    internalDescriptionAllowlistEntries: INTERNAL_DESCRIPTION_ALLOWLIST.length,
    internalDescriptionAllowlistSubjects: new Set(INTERNAL_DESCRIPTION_ALLOWLIST.map((e) => e.subject)).size,
  },
  perNamespace: Object.fromEntries(
    [...new Set(protocols.map((p) => p.namespace))].sort().map((ns) => {
      const rows = protocols.filter((p) => p.namespace === ns);
      const nsGeneral = general.filter((e) => nsOf(e.subject) === ns);
      const nsToolDesc = generalToolDesc.filter((e) => nsOf(e.subject) === ns);
      return [
        ns,
        {
          tools: rows.length,
          mutating: rows.filter((r) => r.mutating).length,
          withEmbeddingText: rows.filter((r) => r.hasEmbeddingText).length,
          withCanonicalSummary: rows.filter((r) => r.hasCanonicalSummary).length,
          withAliases: rows.filter((r) => r.aliasCount > 0).length,
          withExampleIntents: rows.filter((r) => r.exampleIntentCount > 0).length,
          withNavigationFacet: rows.filter((r) => r.navigationFacets.length > 0).length,
          descriptionBytesTotal: rows.reduce((a, r) => a + r.descriptionBytes, 0),
          descriptionBytesMin: Math.min(...rows.map((r) => r.descriptionBytes)),
          descriptionBytesMax: Math.max(...rows.map((r) => r.descriptionBytes)),
          actionKinds: tally(rows, (r) => r.actionKind),
          allowlistEntries: nsGeneral.length,
          allowlistToolDescriptionEntries: nsToolDesc.length,
          allowlistToolDescriptionSubjects: new Set(nsToolDesc.map((e) => e.subject)).size,
          allowlistRules: tally(nsGeneral, (e) => e.rule),
        },
      ];
    }),
  ),
  allowlistByRule: tally(general, (e) => e.rule),
  allowlistBySubjectNamespace: tally(general, (e) => nsOf(e.subject)),
  toolDescriptionByDetail: tally(generalToolDesc, (e) => e.detail ?? "(none)"),
  toolDescriptionByNamespace: tally(generalToolDesc, (e) => nsOf(e.subject)),
  internalAllowlistByDetail: tally(INTERNAL_DESCRIPTION_ALLOWLIST, (e) => e.detail ?? "(none)"),
  internalAllowlistBySubject: tally(INTERNAL_DESCRIPTION_ALLOWLIST, (e) => e.subject),
  internalTools: internal.sort((a, b) => a.name.localeCompare(b.name)),
  protocolTools: protocols.sort((a, b) => a.toolId.localeCompare(b.toolId)),
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
