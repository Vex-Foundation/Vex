/**
 * Prompt snapshots: the assembled STATIC prefix of every mode, byte-exact, as a
 * reviewed contract artifact, plus the retrieval-facing navigation and
 * embedding fields frozen by owner decision D9.
 *
 * WHY. Wave 2 rebuilds the system prompt. A prompt is a versioned product
 * artifact (rule 09), and the only honest way to review a rebuild of a 100 KB
 * prefix is a diff of what the model reads, not a diff of the TypeScript that
 * renders it. These artifacts are that diff surface. They are captured BEFORE
 * the first Wave 2 edit (the Wave 0 ledger's precondition) and regenerated
 * once, centrally, when the rebuild lands, so the review reads one contract
 * diff.
 *
 * WHAT IS SNAPSHOTTED. Only the static layers: they are pure and synchronous,
 * so the bytes are reproducible on the same tree and env posture. Turn layers
 * are not snapshotted (the runtime clock is volatile); the test pins only
 * that the safety re-anchor is the LAST turn layer, which is a structural
 * contract.
 *
 * ENV POSTURE. Two fingerprints per mode: JUPITER_API_KEY absent (the Wave 0
 * baseline posture) and present. TAVILY_API_KEY and RETTIWT_API_KEY are
 * removed for the run so the gated layers render their reduced variant in
 * both fingerprints, which is the posture every budget measurement in this
 * program used. The sentinel value is not a credential: the availability
 * gate tests presence only and no handler runs here.
 *
 * REGENERATION.
 *   UPDATE_PROMPTSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/engine/prompts/promptsnaps.test.ts
 * rewrites the twelve prompt artifacts. It does NOT touch the retrieval
 * fixture: that fixture is derived from the pre-wave revision and must never
 * be regenerated from the completed rebuild, because its whole purpose is to
 * prove the rebuild left the D9-frozen fields byte-identical. It has its own
 * flag, UPDATE_RETRIEVAL_FIELDS_FIXTURE=true, for the day the owner unfreezes
 * them.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import {
  buildPromptStack,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import { PROTOCOL_TOOLS } from "../../../../vex-agent/tools/protocols/catalog.js";
import { PROTOCOL_NAMESPACE_NAVIGATION } from "../../../../vex-agent/tools/protocols/descriptions.js";
import { makeContext } from "./_prompt-stack-helpers.js";

const SNAP_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../vex-agent/engine/prompts/__promptsnaps__",
);
const UPDATING = process.env.UPDATE_PROMPTSNAPS === "true";
const UPDATING_FIXTURE = process.env.UPDATE_RETRIEVAL_FIELDS_FIXTURE === "true";
const REMEDY =
  "run `UPDATE_PROMPTSNAPS=true pnpm exec vitest run "
  + "src/__tests__/vex-agent/engine/prompts/promptsnaps.test.ts` once, centrally, and review the "
  + "artifact diff as a contract diff";

/** `buildTurnEnvelope` joins layers with this exact separator. */
const LAYER_SEPARATOR = "\n\n---\n\n";
const SENTINEL_VALUE = "vex-eval-sentinel-not-a-credential";
const GATED_KEYS = ["JUPITER_API_KEY", "TAVILY_API_KEY", "RETTIWT_API_KEY"] as const;

interface PromptMode {
  readonly slug: string;
  readonly context: EngineContext;
}

/** The same six modes the budget report measures, selected from context only. */
const MODES: readonly PromptMode[] = [
  { slug: "agent-restricted", context: makeContext({}) },
  { slug: "agent-full", context: makeContext({ sessionPermission: "full" }) },
  { slug: "mission-setup-restricted", context: makeContext({ sessionKind: "mission" }) },
  {
    slug: "mission-setup-full",
    context: makeContext({ sessionKind: "mission", sessionPermission: "full" }),
  },
  {
    slug: "mission-run-restricted",
    context: makeContext({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }),
  },
  {
    slug: "mission-run-full",
    context: makeContext({
      sessionKind: "mission",
      missionId: "m-1",
      missionRunId: "r-1",
      sessionPermission: "full",
    }),
  },
];

const FINGERPRINTS = [
  { slug: "nojupiter", jupiter: false },
  { slug: "jupiter", jupiter: true },
] as const;

function renderStatic(context: EngineContext): string {
  resetProtocolsPromptCache();
  const stack = buildPromptStack(context, {});
  return stack.staticLayers.join(LAYER_SEPARATOR);
}

function firstDifference(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const limit = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return `first difference at line ${index + 1}:\n  artifact: ${JSON.stringify(expectedLines[index])}\n  rendered: ${JSON.stringify(actualLines[index])}`;
    }
  }
  return "no line difference (trailing bytes differ)";
}

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of GATED_KEYS) saved[key] = process.env[key];
  mkdirSync(SNAP_DIR, { recursive: true });
});

afterAll(() => {
  for (const key of GATED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetProtocolsPromptCache();
});

describe("prompt snapshots - the static prefix per mode and env fingerprint", () => {
  for (const fingerprint of FINGERPRINTS) {
    for (const mode of MODES) {
      const file = join(SNAP_DIR, `${mode.slug}.${fingerprint.slug}.md`);
      it(`${mode.slug} / ${fingerprint.slug} matches ${file.split("/").slice(-1)[0]}`, () => {
        delete process.env.TAVILY_API_KEY;
        delete process.env.RETTIWT_API_KEY;
        if (fingerprint.jupiter) process.env.JUPITER_API_KEY = SENTINEL_VALUE;
        else delete process.env.JUPITER_API_KEY;

        const rendered = renderStatic(mode.context);
        // Render twice: the static prefix must be deterministic (contract S2).
        expect(renderStatic(mode.context)).toBe(rendered);

        if (UPDATING) {
          writeFileSync(file, rendered, "utf8");
          return;
        }
        expect(existsSync(file), `missing prompt snapshot ${file}; ${REMEDY}`).toBe(true);
        const expected = readFileSync(file, "utf8");
        if (expected !== rendered) {
          throw new Error(
            `prompt snapshot drift for ${mode.slug} / ${fingerprint.slug} `
            + `(${Buffer.byteLength(expected, "utf8")} B on disk, ${Buffer.byteLength(rendered, "utf8")} B rendered); `
            + `${firstDifference(expected, rendered)}\nIf the change is intended, ${REMEDY}.`,
          );
        }
      });
    }
  }

  it("keeps the safety re-anchor as the LAST turn layer in every mode", () => {
    for (const mode of MODES) {
      const stack = buildPromptStack(mode.context, {});
      const last = stack.turnLayers[stack.turnLayers.length - 1] ?? "";
      expect(last, mode.slug).toContain("# Safety Re-anchor");
    }
  });
});

/**
 * The D9-frozen retrieval surface, per namespace: navigation aliases, facets
 * (label, summary, toolPrefixes, hints), discoveryHints and exampleQueries,
 * plus a digest per tool of the manifest's own discovery record
 * (embeddingText, canonicalSummary, aliases, exampleIntents). The rebuild may
 * add a declaration to a navigation entry; it may not move a byte of these.
 */
interface RetrievalFieldsFixture {
  readonly navigation: Record<string, unknown>;
  readonly toolDiscoveryDigests: Record<string, string>;
}

function retrievalFieldsNow(): RetrievalFieldsFixture {
  const navigation: Record<string, unknown> = {};
  for (const entry of Object.values(PROTOCOL_NAMESPACE_NAVIGATION)) {
    navigation[entry.namespace] = {
      aliases: [...entry.aliases],
      discoveryHints: [...entry.discoveryHints],
      exampleQueries: [...entry.exampleQueries],
      facets: entry.facets.map((facet) => ({
        label: facet.label,
        summary: facet.summary,
        toolPrefixes: [...facet.toolPrefixes],
        hints: [...facet.hints],
      })),
    };
  }
  const toolDiscoveryDigests: Record<string, string> = {};
  for (const manifest of PROTOCOL_TOOLS) {
    const discovery = manifest.discovery ?? {};
    const material = JSON.stringify({
      embeddingText: typeof discovery.embeddingText === "string" ? discovery.embeddingText : null,
      canonicalSummary: typeof discovery.canonicalSummary === "string" ? discovery.canonicalSummary : null,
      aliases: Array.isArray(discovery.aliases) ? discovery.aliases : null,
      exampleIntents: Array.isArray(discovery.exampleIntents) ? discovery.exampleIntents : null,
    });
    toolDiscoveryDigests[manifest.toolId] = createHash("sha256").update(material).digest("hex");
  }
  return { navigation, toolDiscoveryDigests };
}

describe("retrieval fields frozen by D9", () => {
  const fixtureFile = join(SNAP_DIR, "navigation-retrieval-fields.json");

  it("match the pre-wave fixture byte for byte", () => {
    const now = retrievalFieldsNow();
    const serialized = `${JSON.stringify(now, null, 2)}\n`;
    if (UPDATING_FIXTURE) {
      writeFileSync(fixtureFile, serialized, "utf8");
      return;
    }
    expect(
      existsSync(fixtureFile),
      `missing ${fixtureFile}; it is captured once from the pre-wave revision with UPDATE_RETRIEVAL_FIELDS_FIXTURE=true`,
    ).toBe(true);
    const expected = readFileSync(fixtureFile, "utf8");
    if (expected !== serialized) {
      throw new Error(
        "a D9-frozen retrieval field changed (navigation aliases, facets, discoveryHints, "
        + "exampleQueries, or a manifest's embeddingText/canonicalSummary/aliases/exampleIntents). "
        + `${firstDifference(expected, serialized)}\nThese fields are frozen by owner decision D9; `
        + "a change needs an owner ruling, not a fixture update.",
      );
    }
  });
});
