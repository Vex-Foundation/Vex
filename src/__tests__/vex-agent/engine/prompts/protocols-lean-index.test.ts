/**
 * Kairos P-5: the `# Protocols` layer as a compact index.
 *
 * Two contracts. OFF is exactly the pre-P-5 layer: `renderProtocolsPrompt(false)`
 * must equal the legacy artifacts captured from the tree before the change, in
 * both env fingerprints the prompt snapshots use. ON keeps every rule-bearing
 * declaration field verbatim (identity, Act, characteristics and limits,
 * coverage, availability) and drops only catalogue prose.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildProtocolsPrompt,
  PROTOCOLS_PROMPT_LEAN,
  renderProtocolsPrompt,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/protocols.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";

const SNAP_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../vex-agent/engine/prompts/__promptsnaps__",
);
const SENTINEL_VALUE = "vex-eval-sentinel-not-a-credential";
const GATED_KEYS = ["JUPITER_API_KEY", "TAVILY_API_KEY", "RETTIWT_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function posture(jupiter: boolean): void {
  delete process.env.TAVILY_API_KEY;
  delete process.env.RETTIWT_API_KEY;
  if (jupiter) process.env.JUPITER_API_KEY = SENTINEL_VALUE;
  else delete process.env.JUPITER_API_KEY;
  resetProtocolsPromptCache();
}

function section(prompt: string, namespace: string): string {
  return prompt.split(`### ${namespace}\n`)[1]?.split("\n\n")[0] ?? "";
}

beforeAll(() => {
  for (const key of GATED_KEYS) saved[key] = process.env[key];
});

afterAll(() => {
  for (const key of GATED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetProtocolsPromptCache();
});

describe("protocols lean index switch", () => {
  it("ships ON and production renders the lean index", () => {
    posture(false);
    expect(PROTOCOLS_PROMPT_LEAN).toBe(true);
    expect(buildProtocolsPrompt()).toBe(renderProtocolsPrompt(true));
  });

  for (const fingerprint of [
    { slug: "nojupiter", jupiter: false },
    { slug: "jupiter", jupiter: true },
  ] as const) {
    it(`OFF renders the pre-P-5 layer byte for byte (${fingerprint.slug})`, () => {
      posture(fingerprint.jupiter);
      const legacy = readFileSync(join(SNAP_DIR, `protocols-legacy.${fingerprint.slug}.md`), "utf8");
      expect(renderProtocolsPrompt(false)).toBe(legacy);
    });
  }

  it("ON is smaller than OFF", () => {
    posture(false);
    const lean = Buffer.byteLength(renderProtocolsPrompt(true), "utf8");
    const full = Buffer.byteLength(renderProtocolsPrompt(false), "utf8");
    expect(lean).toBeLessThan(full);
  });

  it("ON keeps every rule-bearing declaration field verbatim for every namespace", () => {
    for (const jupiter of [false, true]) {
      posture(jupiter);
      const lean = renderProtocolsPrompt(true);
      const full = renderProtocolsPrompt(false);
      for (const navigation of getAdvertisedProtocolNavigation()) {
        const declaration = navigation.declaration;
        const leanSection = section(lean, navigation.namespace);
        const fullSection = section(full, navigation.namespace);
        expect(leanSection, navigation.namespace).toContain(declaration.identity);
        expect(leanSection, navigation.namespace).toContain(`Act: ${declaration.act}`);
        expect(leanSection, navigation.namespace).toContain(
          `Characteristics and limits: ${declaration.characteristicAndLimits}`,
        );
        // Coverage, availability and the mutating marker are the lines after
        // the characteristics line; they must be identical in both renders.
        const tail = (text: string): string => text.split("\nCharacteristics and limits: ")[1] ?? "";
        expect(tail(leanSection), navigation.namespace).toBe(tail(fullSection));
        expect(tail(leanSection).length, navigation.namespace).toBeGreaterThan(0);
      }
    }
  });

  it("ON keeps the task-shape rules and drops only the Trigger lines", () => {
    posture(false);
    const shapes = (text: string): string => text.slice(text.indexOf("## How Vex works a task"));
    const lean = shapes(renderProtocolsPrompt(true));
    const full = shapes(renderProtocolsPrompt(false));
    expect(lean).not.toMatch(/^Trigger: /m);
    const fullWithoutTriggers = full
      .split("\n")
      .filter((line) => !line.startsWith("Trigger: "))
      .join("\n");
    expect(lean).toBe(fullWithoutTriggers);
  });
});
