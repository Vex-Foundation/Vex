/**
 * D-DS7 DRIFT GATE.
 *
 * Owner decision D-DS7: the coordinator authors every retrieval passage
 * personally in
 * `src/vex-agent/tools/tool-surface-spec/dexscreener-site/tool-descriptions-v1.md`,
 * and builders consume them VERBATIM. Codex's final review found four
 * independent drifts anyway (narratives rewrote two sentences, trades invented
 * an example intent, chains_list was rewritten outside the workflow, spotlight
 * and batch text contradicted measured behavior), because nothing mechanically
 * compared the shipped artifacts with the source.
 *
 * This test is that mechanism. It parses the authored document and asserts
 * that the four RETRIEVAL fields of every DexScreener discovery entry
 * (canonicalSummary, embeddingText, aliases, exampleIntents) match it word for
 * word. Only whitespace is normalized, because the document is hard-wrapped at
 * 76 columns and the TypeScript artifacts re-wrap to their own margin; no
 * other transformation is permitted here. A correction therefore has exactly
 * one legal path: edit the document first, then regenerate the artifact.
 *
 * `description` is deliberately NOT compared. It is a per-tool model-visible
 * string owned by the manifest and carries schema detail (param names, units,
 * caps) that the document records only as a draft.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ToolDiscoveryMetadata } from "../../../vex-agent/tools/protocols/types.js";
import { DEXSCREENER_SCREENING_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/screening.js";
import { DEXSCREENER_RESOLVE_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/resolve.js";
import { DEXSCREENER_DEEP_DIVE_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/deep-dive.js";
import { DEXSCREENER_MARKET_CONTEXT_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/market-context.js";

const SOURCE_PATH = fileURLToPath(
  new URL(
    "../../../vex-agent/tools/tool-surface-spec/dexscreener-site/tool-descriptions-v1.md",
    import.meta.url,
  ),
);

/** One tool block as the coordinator authored it. */
interface AuthoredEntry {
  readonly toolId: string;
  readonly publicName: string;
  readonly canonicalSummary: string;
  readonly embeddingText: string;
  readonly aliases: readonly string[];
  readonly exampleIntents: readonly string[];
}

/**
 * Collapse every whitespace run to one space. This is the ONLY normalization
 * the gate allows: it absorbs the document's hard wrap and the artifact's
 * template-literal wrap, and nothing else.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Read a `key:`-introduced block up to the next blank line or next key. */
function blockAfter(body: string, key: string): string {
  const pattern = new RegExp(
    `^${key}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n\\s*\\n|\\n(?:canonicalSummary|embeddingText|aliases|exampleIntents|description)\\b)`,
    "m",
  );
  const match = pattern.exec(body);
  if (!match) throw new Error(`source document has no "${key}:" block`);
  return flatten(match[1] ?? "");
}

/** Split a comma-separated alias line into its entries. */
function splitAliases(line: string): readonly string[] {
  return line.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Split the quoted, comma-separated exampleIntents line into its entries. */
function splitIntents(line: string): readonly string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map((match) => flatten(match[1] ?? ""));
}

function parseSource(): readonly AuthoredEntry[] {
  const document = readFileSync(SOURCE_PATH, "utf8");
  const blocks = document.split(/^## \d+\. /m).slice(1);
  return blocks.map((block) => {
    const heading = block.split("\n", 1)[0] ?? "";
    const publicName = heading.split(/\s/, 1)[0] ?? "";
    const toolId = /`([^`]+)`/.exec(heading)?.[1] ?? "";
    if (!publicName || !toolId) {
      throw new Error(`unparseable tool heading: ${heading}`);
    }
    return {
      toolId,
      publicName,
      canonicalSummary: blockAfter(block, "canonicalSummary"),
      embeddingText: blockAfter(block, "embeddingText"),
      aliases: splitAliases(blockAfter(block, "aliases")),
      exampleIntents: splitIntents(blockAfter(block, "exampleIntents")),
    };
  });
}

const SHIPPED: Record<string, ToolDiscoveryMetadata> = {
  ...DEXSCREENER_SCREENING_DISCOVERY,
  ...DEXSCREENER_RESOLVE_DISCOVERY,
  ...DEXSCREENER_DEEP_DIVE_DISCOVERY,
  ...DEXSCREENER_MARKET_CONTEXT_DISCOVERY,
};

describe("DexScreener retrieval text matches the coordinator's source document", () => {
  const authored = parseSource();

  it("parses all 18 authored tool blocks", () => {
    expect(authored).toHaveLength(18);
  });

  it("ships exactly the toolIds the document authors, and no others", () => {
    expect(Object.keys(SHIPPED).sort()).toEqual(
      authored.map((entry) => entry.toolId).sort(),
    );
  });

  for (const entry of authored) {
    describe(`${entry.publicName} (${entry.toolId})`, () => {
      const shipped = (): ToolDiscoveryMetadata => {
        const found = SHIPPED[entry.toolId];
        if (!found) throw new Error(`no shipped discovery entry for ${entry.toolId}`);
        return found;
      };

      it("canonicalSummary is verbatim", () => {
        expect(flatten(shipped().canonicalSummary ?? "")).toBe(entry.canonicalSummary);
      });

      it("embeddingText is verbatim", () => {
        expect(flatten(shipped().embeddingText ?? "")).toBe(entry.embeddingText);
      });

      it("aliases are verbatim, in order, with nothing added", () => {
        expect((shipped().aliases ?? []).map(flatten)).toEqual([...entry.aliases]);
      });

      it("exampleIntents are verbatim, in order, with nothing added", () => {
        expect((shipped().exampleIntents ?? []).map(flatten)).toEqual([...entry.exampleIntents]);
      });
    });
  }
});
