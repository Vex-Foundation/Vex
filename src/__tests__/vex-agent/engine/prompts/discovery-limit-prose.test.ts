/**
 * The Tool Model prompt's discovery row counts must be the RUNTIME's counts.
 *
 * The prose said "returns up to 10 tools" while `DEFAULT_DISCOVERY_LIMIT` was 5
 * and `MAX_DISCOVERY_LIMIT` 20: the model was told a ceiling that was both
 * wrong and unreachable. The wording is now interpolated from the same
 * constants the parser and discovery read, so it cannot drift again.
 */

import { describe, it, expect } from "vitest";
import { buildToolModelPrompt } from "@vex-agent/engine/prompts/tool-model.js";
import {
  DEFAULT_DISCOVERY_LIMIT,
  MAX_DISCOVERY_LIMIT,
} from "@vex-agent/tools/protocols/discovery.js";

describe("tool-model prompt — discovery limits", () => {
  const prompt = buildToolModelPrompt();

  it("states the real default and maximum", () => {
    expect(prompt).toContain(`Returns ${DEFAULT_DISCOVERY_LIMIT} rows by default`);
    expect(prompt).toContain(`raise \`limit\` up to ${MAX_DISCOVERY_LIMIT}`);
  });

  it("tells the model an out-of-range limit is REJECTED, not clamped", () => {
    expect(prompt).toContain(`outside 1-${MAX_DISCOVERY_LIMIT} is rejected by name, not clamped`);
  });

  it("no longer carries the stale hand-typed ceiling", () => {
    expect(prompt).not.toContain("up to 10 tools");
  });
});
