/**
 * Pre-reveal serialization sweep for the hidden Relay bridge pair (bridge
 * factory W5; Phase-1 C30 pattern). Before any route reveal, NO serialized tool
 * description, NO built tool-catalog prompt, and NO OpenAI tools projection may
 * name `bridge_quote_relay` / `bridge_execute_relay` — naming a hidden tool
 * anywhere the model can see it defeats the reveal gate. After a route reveal the
 * pair joins the real LLM-facing tool list (parity with the Uniswap hidden pair).
 */
import { describe, it, expect, vi } from "vitest";

// Imports the visibility + prompt-catalog + openai-tools module graph — first-
// import cost can exceed the 10s default.
vi.setConfig({ testTimeout: 120_000 });

import { ACTION_ALIAS_TOOLS } from "../../../vex-agent/tools/registry/action-aliases.js";
import {
  getVisibleToolDefs,
  defaultVisibilityContext,
} from "../../../vex-agent/tools/registry/visibility.js";
import { buildToolCatalogPrompt } from "../../../vex-agent/engine/prompts/tool-catalog.js";
import { getOpenAITools } from "../../../vex-agent/tools/registry/openai-tools.js";
import {
  revealRelayRoute,
  resolveRelayRevealRoute,
} from "../../../vex-agent/tools/registry/relay-reveal.js";

const HIDDEN_PAIR = ["bridge_quote_relay", "bridge_execute_relay"];

describe("hidden Relay pair — pre-reveal serialization sweep (C30 pattern)", () => {
  it("both hidden aliases EXIST as ToolDefs (anchor — the sweep is not passing on absence)", () => {
    const names = ACTION_ALIAS_TOOLS.map((t) => t.name);
    for (const name of HIDDEN_PAIR) expect(names).toContain(name);
  });

  it("pre-reveal: absent from getVisibleToolDefs", () => {
    const names = getVisibleToolDefs(defaultVisibilityContext({ sessionId: "relay-serialize-hidden" })).map((t) => t.name);
    for (const name of HIDDEN_PAIR) expect(names).not.toContain(name);
  });

  it("pre-reveal: no VISIBLE tool description names the hidden pair", () => {
    const defs = getVisibleToolDefs(defaultVisibilityContext({ sessionId: "relay-serialize-desc" }));
    const serialized = defs.map((t) => `${t.name} ${t.description}`).join("\n").toLowerCase();
    for (const name of HIDDEN_PAIR) expect(serialized).not.toContain(name);
  });

  it("pre-reveal: the built tool-catalog prompt never names the hidden pair", () => {
    const prompt = buildToolCatalogPrompt(defaultVisibilityContext({ sessionId: "relay-serialize-prompt" })).toLowerCase();
    for (const name of HIDDEN_PAIR) expect(prompt).not.toContain(name);
  });

  it("pre-reveal: the OpenAI tools projection never names the hidden pair", () => {
    const serialized = JSON.stringify(
      getOpenAITools(defaultVisibilityContext({ sessionId: "relay-serialize-openai" })),
    ).toLowerCase();
    for (const name of HIDDEN_PAIR) expect(serialized).not.toContain(name);
  });

  it("post-reveal: the pair joins the real LLM-facing tool list", () => {
    const sessionId = "relay-serialize-revealed";
    const route = resolveRelayRevealRoute({
      fromChain: "8453",
      fromToken: "native",
      toChain: "10",
      toToken: "native",
    });
    if (!route) throw new Error("serialization test route did not resolve");
    revealRelayRoute(sessionId, route);

    const names = getVisibleToolDefs(defaultVisibilityContext({ sessionId })).map((t) => t.name);
    for (const name of HIDDEN_PAIR) expect(names).toContain(name);
  });
});
