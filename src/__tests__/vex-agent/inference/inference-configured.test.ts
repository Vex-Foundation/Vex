/**
 * `isInferenceConfigured()`: THE gate the six background workers ask before
 * claiming work that needs a model call (wake, compaction executor and
 * chunker, compaction branch, memory manager, regime worker).
 *
 * Pure over an env record, so every row is the gate itself, not a model of
 * it. The rows that matter most: a Vex Cloud configuration with a session
 * and no OpenRouter key IS configured (the old inline gates said no, so every
 * worker would have stayed idle in Vex Cloud mode), and a Vex Cloud selection
 * with only an OpenRouter key is NOT (the key belongs to another backend).
 */

import { describe, expect, it } from "vitest";
import { isInferenceConfigured, resolveInferenceMode } from "../../../vex-agent/inference/config.js";

const MODEL = "anthropic/claude-haiku-5.5";

describe("isInferenceConfigured", () => {
  it.each([
    ["bring your own key, implicit", { OPENROUTER_API_KEY: "sk-or-x", AGENT_MODEL: MODEL }, true],
    ["bring your own key, explicit", { AGENT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-x", AGENT_MODEL: MODEL }, true],
    ["Vex Cloud with a session and no OpenRouter key", { AGENT_PROVIDER: "vexcloud", VEX_CLOUD_SESSION_TOKEN: "vxs_t", AGENT_MODEL: MODEL }, true],
    ["Vex Cloud, any casing", { AGENT_PROVIDER: " VexCloud ", VEX_CLOUD_SESSION_TOKEN: "vxs_t", AGENT_MODEL: MODEL }, true],
    ["Vex Cloud with only an OpenRouter key", { AGENT_PROVIDER: "vexcloud", OPENROUTER_API_KEY: "sk-or-x", AGENT_MODEL: MODEL }, false],
    ["OpenRouter with only a Vex Cloud session", { AGENT_PROVIDER: "openrouter", VEX_CLOUD_SESSION_TOKEN: "vxs_t", AGENT_MODEL: MODEL }, false],
    ["no model", { OPENROUTER_API_KEY: "sk-or-x" }, false],
    ["a whitespace model", { OPENROUTER_API_KEY: "sk-or-x", AGENT_MODEL: "  " }, false],
    ["a whitespace key", { OPENROUTER_API_KEY: "  ", AGENT_MODEL: MODEL }, false],
    ["a locked vault (no credential at all)", { AGENT_PROVIDER: "vexcloud", AGENT_MODEL: MODEL }, false],
    ["an unknown provider", { AGENT_PROVIDER: "bogus", OPENROUTER_API_KEY: "sk-or-x", AGENT_MODEL: MODEL }, false],
  ] as const)("%s -> %s", (_name, env, expected) => {
    expect(isInferenceConfigured(env)).toBe(expected);
  });
});

describe("resolveInferenceMode", () => {
  it("defaults to OpenRouter, honours Vex Cloud, refuses the unknown", () => {
    expect(resolveInferenceMode({})).toBe("openrouter");
    expect(resolveInferenceMode({ AGENT_PROVIDER: "vexcloud" })).toBe("vexcloud");
    expect(resolveInferenceMode({ AGENT_PROVIDER: "bogus" })).toBeNull();
  });
});
