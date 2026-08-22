import { describe, expect, it } from "vitest";
import { buildResponseFormatPrompt } from "@vex-agent/engine/prompts/response-format.js";

describe("response format prompt", () => {
  it("keeps tool implementation details internal", () => {
    const prompt = buildResponseFormatPrompt();
    expect(prompt).toContain("## Tools Are Internal Machinery");
    expect(prompt).toContain("Tool names, aliases, toolIds, schemas, and parameter shapes are implementation detail");
    expect(prompt).toContain("never enumerate or tabulate them to the user");
    expect(prompt).toContain("translating intent to tools is your job");
  });
});
