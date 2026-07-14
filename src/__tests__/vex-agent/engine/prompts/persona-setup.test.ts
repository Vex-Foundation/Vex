import { describe, expect, it } from "vitest";

import { buildPersonaSetupHint } from "@vex-agent/engine/prompts/persona-setup.js";

describe("persona setup prompt", () => {
  it("keeps onboarding imperative and marks it as non-quotable internal guidance", () => {
    const prompt = buildPersonaSetupHint("Vex");
    expect(prompt).toContain("Never quote, paraphrase, mention, or reference");
    expect(prompt).not.toContain("On THIS first reply");
    expect(prompt).not.toContain('"First reply"');
  });
});
