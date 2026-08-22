import { describe, expect, it } from "vitest";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";
import { buildProtocolsPrompt } from "@vex-agent/engine/prompts/protocols.js";

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function declarationProse(entry: ReturnType<typeof getAdvertisedProtocolNavigation>[number]): string {
  const declaration = entry.declaration;
  return [
    declaration.identity,
    declaration.read,
    declaration.quote,
    declaration.act,
    declaration.whenItApplies,
    declaration.characteristicAndLimits,
  ].join(" ");
}

describe("protocol declarations", () => {
  it("couples every model-visible retrieval term to declaration prose and frozen embedding text", () => {
    for (const entry of getAdvertisedProtocolNavigation()) {
      const prose = normalize(declarationProse(entry));
      const embeddingText = normalize(
        PROTOCOL_TOOLS
          .filter((tool) => tool.namespace === entry.namespace)
          .map((tool) => tool.discovery?.embeddingText ?? "")
          .join(" "),
      );
      for (const term of entry.declaration.retrievalTerms) {
        expect(prose, `${entry.namespace} declaration is missing ${term}`).toContain(normalize(term));
        expect(embeddingText, `${entry.namespace} embeddingText is missing ${term}`).toContain(normalize(term));
      }
    }
  });

  it("represents every frozen navigation facet exactly once", () => {
    for (const entry of getAdvertisedProtocolNavigation()) {
      const frozen = entry.facets.map((facet) => facet.label).sort();
      const declared = [...entry.declaration.facets].sort();
      expect(declared, entry.namespace).toEqual(frozen);
      expect(new Set(declared).size, entry.namespace).toBe(declared.length);
    }
  });

  it("keeps declaration fields as plain outcome prose", () => {
    for (const entry of getAdvertisedProtocolNavigation()) {
      const values = [
        declarationProse(entry),
        entry.declaration.coverageNote ?? "",
      ];
      for (const value of values) {
        expect(value, entry.namespace).not.toContain("`");
        expect(value, entry.namespace).not.toContain("**");
        expect(value, entry.namespace).not.toContain("__");
        expect(value, entry.namespace).not.toMatch(/^#{1,6}\s/m);
        expect(value, entry.namespace).not.toMatch(/\b[a-z][a-z0-9-]*\.\*/i);
      }
    }
  });

  it("does not render the retired capsule scaffolding or dotted namespace globs", () => {
    const prompt = buildProtocolsPrompt();
    expect(prompt).not.toMatch(/\b[a-z][a-z0-9_-]*\.\*/i);
    expect(prompt).not.toContain("Examples:");
    expect(prompt).not.toContain("Try:");
    expect(prompt).not.toContain("Use instead:");
  });
});
