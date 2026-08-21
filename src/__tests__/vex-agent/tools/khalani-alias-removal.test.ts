/**
 * The three removed Khalani internal aliases stay removed.
 *
 * `khalani_chains_list`, `khalani_tokens_top` and `khalani_tokens_balances`
 * were tool-on-tool shortcuts: each one cost schema tokens in EVERY request
 * while no observed live session called it. Removed 2026-07-30 (owner
 * decision). `TokenFind` was deliberately KEPT — it is the address+decimals
 * resolution that precedes every swap and bridge, and the safety doctrine,
 * the swap chain-param docs, and `ChainRead`'s description all name it.
 *
 * The removal narrowed the FLAT tool surface only. Nothing was taken away from
 * the agent: all three protocol tools are unchanged and still reachable through
 * `discover_tools` + `execute_tool`, which the second block proves.
 */

import { describe, expect, it } from "vitest";

import { getToolDef, getAllTools } from "@vex-agent/tools/registry.js";
import { KHALANI_INTERNAL_TO_PROTOCOL } from "@vex-agent/tools/registry/khalani.js";
import { getProtocolManifest, getProtocolHandler } from "@vex-agent/tools/protocols/catalog.js";
import { TOOL_MAP_CATEGORIES } from "@vex-agent/tools/registry/tool-map.js";
import { buildToolModelPrompt } from "@vex-agent/engine/prompts/tool-model.js";

const REMOVED_ALIASES = [
  "khalani_chains_list",
  "khalani_tokens_top",
  "khalani_tokens_balances",
] as const;

const REMOVED_TARGETS = [
  "khalani.chains.list",
  "khalani.tokens.top",
  "khalani.tokens.balances",
] as const;

describe("removed Khalani aliases are gone from every agent-facing surface", () => {
  it.each(REMOVED_ALIASES)("%s is not a registered tool", (alias) => {
    expect(getToolDef(alias)).toBeUndefined();
    expect(getAllTools().some((tool) => tool.name === alias)).toBe(false);
  });

  it.each(REMOVED_ALIASES)("%s is not in the alias→protocol map", (alias) => {
    expect(Object.keys(KHALANI_INTERNAL_TO_PROTOCOL)).not.toContain(alias);
  });

  it.each(REMOVED_ALIASES)("%s is not offered in the Tool Map", (alias) => {
    const listed = TOOL_MAP_CATEGORIES.flatMap((category) => category.toolNames);
    expect(listed).not.toContain(alias);
  });

  it.each(REMOVED_ALIASES)("%s is not advertised in the Tool Model prompt", (alias) => {
    expect(buildToolModelPrompt()).not.toContain(alias);
  });

  it("keeps TokenFind — the load-bearing one — fully wired", () => {
    expect(KHALANI_INTERNAL_TO_PROTOCOL.TokenFind).toBe("khalani.tokens.search");
    expect(getToolDef("TokenFind")).toBeDefined();
    expect(buildToolModelPrompt()).toContain("TokenFind");
  });
});

describe("the capability itself was NOT removed — only the flat shortcut", () => {
  it.each(REMOVED_TARGETS)("%s is still an executable protocol tool", (toolId) => {
    expect(getProtocolManifest(toolId)).toBeDefined();
    expect(getProtocolHandler(toolId)).toBeDefined();
  });
});
