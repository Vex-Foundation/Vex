/**
 * B-3: the "Mark uncertainty" rule is scoped to memory and lesson claims.
 *
 * It stays: the memory manager derives provenance from the model's hedges, so
 * removing it would let a guessed lesson be recorded as an observed fact.
 * What changed is its reach: it no longer asks the model to narrate doubt
 * about every tool result before acting.
 */
import { describe, expect, it } from "vitest";

import { buildMemoryPolicyPrompt } from "../../../../vex-agent/engine/prompts/memory-policy.js";

describe("memory policy: Mark uncertainty", () => {
  const prompt = buildMemoryPolicyPrompt();

  it("keeps the rule, its hedge examples and the provenance reason", () => {
    expect(prompt).toContain("**Mark uncertainty in memory and lesson claims.**");
    expect(prompt).toContain("\"I think\" / \"this looks like\" / \"I am not sure\" are acceptable");
    expect(prompt).toContain("The memory manager derives provenance from your wording");
    expect(prompt).toContain("silent confidence on thin evidence is not");
  });

  it("scopes it to memory and lessons instead of every tool result", () => {
    expect(prompt).toContain("When you state a remembered fact, draw a lesson, or propose one with `MemorySuggest`");
    expect(prompt).toContain("not a reason to pause routine tool work to narrate doubt");
    expect(prompt).not.toContain("If a tool result is ambiguous or a precondition is unproven, say so before acting");
  });
});
