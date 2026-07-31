/**
 * Pins the young/niche-token research guidance on BOTH of its declared surfaces
 * (`registry/web.ts` header contract: the tool description and the research
 * prompt shape guidance change together). Guards the concrete threshold and the
 * fallback tool set so neither surface can silently drift from the other.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { buildResearchPrompt } from "@vex-agent/engine/prompts/research.js";
import { WEB_TOOLS } from "@vex-agent/tools/registry/web.js";

/** Tokens both surfaces must carry — the shared young-token contract. */
const SHARED_TOKENS = [
  "30 days old",
  "under a few thousand holders",
  "CONTRACT ADDRESS",
  "timeRange",
  "dexscreener.*",
  "twitter_account",
  "virtuals.*",
  "not evidence the token is fake",
] as const;

describe("young-token guidance (two-surface contract)", () => {
  beforeEach(() => {
    // The research prompt only teaches web_research when its env gate is up.
    vi.stubEnv("TAVILY_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the web_research tool description carries the full guidance", () => {
    const description = WEB_TOOLS.find((t) => t.name === "web_research")?.description;
    expect(description).toBeDefined();
    for (const token of SHARED_TOKENS) {
      expect(description).toContain(token);
    }
    expect(description).toContain('topic: "news"');
  });

  it("the research prompt carries the same guidance", () => {
    const prompt = buildResearchPrompt();
    for (const token of SHARED_TOKENS) {
      expect(prompt).toContain(token);
    }
    expect(prompt).toContain('topic="news"');
  });
});
