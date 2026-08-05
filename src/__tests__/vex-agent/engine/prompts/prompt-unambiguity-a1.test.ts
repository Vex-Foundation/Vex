/**
 * Prompt unambiguity package (W1 / A1) — the pins for the structural changes
 * that make the built prompt readable in one pass:
 *
 *  - the precedence preamble (turn state > safety > policy > mode),
 *  - ONE call notation everywhere (`tool_name(param="value")`),
 *  - the alias table ("shortcuts are the same engines"),
 *  - the honest discover-first framing (toolIds real, schemas not),
 *  - one H1 per turn layer,
 *  - the retired fossils (`hl_positions`, the hard-coded namespace list).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  buildPromptStack,
  buildToolModelPrompt,
  buildIdentityPrompt,
  buildResponseFormatPrompt,
  buildMissionTurnState,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/index.js";
import { buildContextPressureBanner } from "@vex-agent/engine/prompts/context-pressure.js";
import { buildWalletStateBanner } from "@vex-agent/engine/prompts/wallet-state.js";
import { getToolDef } from "@vex-agent/tools/registry.js";
import { makeContext } from "./_prompt-stack-helpers.js";

/** The whole prompt as the model receives it, with every optional layer present. */
function fullPrompt(): string {
  const stack = buildPromptStack(
    makeContext({ sessionKind: "mission", missionId: "m-1", missionRunId: "run-1" }),
    {
      missionRunContext: { missionPromptContext: "# Mission: X", iterationCount: 3 },
      contextPressureBanner: buildContextPressureBanner("barrier", 0.9),
      memorySection: "# Memory\n\n[Session memories: 0 chunks, 0 compact(s) done.]",
      toolCatalogPrompt: "# Available Tool Map\n\n- wallet_balances",
    },
  );
  return [...stack.staticLayers, ...stack.turnLayers].join("\n\n");
}

describe("prompt unambiguity (A1)", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
  });

  describe("precedence", () => {
    it("states the conflict order in the first lines of the prompt", () => {
      const identity = buildIdentityPrompt(makeContext());
      const head = identity.slice(0, 700);

      expect(head).toContain("Precedence, when two parts of this prompt disagree:");
      // The turn state describes NOW and overrides static availability claims.
      expect(head).toContain("describes NOW");
      expect(head).toContain("overrides any static claim");
      // Then safety > policy > mode, and specific beats general.
      const safetyIdx = head.indexOf("`# Safety Contract`");
      const policyIdx = head.indexOf("`# Execution Policy`");
      expect(safetyIdx).toBeGreaterThan(-1);
      expect(policyIdx).toBeGreaterThan(safetyIdx);
      expect(head).toContain("A narrower, more specific rule beats a broader one.");
    });

    it("is the first thing in the static prefix", () => {
      const { staticLayers } = buildPromptStack(makeContext());
      expect(staticLayers[0]).toContain("Precedence, when two parts of this prompt disagree:");
    });
  });

  describe("one call notation", () => {
    it("no layer teaches the JS-object call form", () => {
      // `web_research({ query: "..." })` taught a wire format the tools API does
      // not use; weaker models mirror whatever notation they were shown.
      expect(fullPrompt()).not.toMatch(/[a-z_]+\(\{/);
    });

    it("no layer teaches the shell/CLI call form or a pseudo-signature", () => {
      const prompt = fullPrompt();
      expect(prompt).not.toMatch(/`[a-z_]+ <[a-z_]+>`/);
      // `k≤5` is not valid syntax in any notation, and `k` is a real parameter.
      expect(prompt).not.toContain("≤");
    });

    it("says explicitly that examples are intent, not wire format", () => {
      expect(buildToolModelPrompt()).toContain(
        "That notation shows INTENT, not wire format",
      );
    });
  });

  describe("alias table", () => {
    it("names the curated shortcuts and the engines they run", () => {
      const toolModel = buildToolModelPrompt();
      expect(toolModel).toContain("Shortcuts are the same engines");
      expect(toolModel).toContain("PREFER the shortcut");
      for (const [alias, target] of [
        ["token_find", "khalani.tokens.search"],
        ["token_check", "kyberswap.tokens.check"],
        ["bridge_status", "khalani.orders.get"],
      ] as const) {
        expect(toolModel).toContain(alias);
        expect(toolModel).toContain(target);
      }
    });

    it("every shortcut named in the table is a registered tool", () => {
      const toolModel = buildToolModelPrompt();
      for (const alias of [
        "token_find", "token_check", "swap_quote", "swap_execute", "bridge_quote",
        "bridge", "bridge_status",
      ]) {
        expect(toolModel, `alias missing from the table: ${alias}`).toContain(`\`${alias}\``);
        expect(getToolDef(alias), `alias not registered: ${alias}`).toBeDefined();
      }
    });

    it("the Safety Contract routes through the shortcuts, not past them", () => {
      const prompt = fullPrompt();
      expect(prompt).toContain('token_find(query="SYMBOL"');
      expect(prompt).toContain('token_check(chain="...", tokenAddress="...")');
      expect(prompt).not.toContain("khalani.tokens.search(query, chainIds)");
    });
  });

  describe("honest discovery framing", () => {
    it("says the toolIds are real but their schemas are not in the prompt", () => {
      const toolModel = buildToolModelPrompt();
      expect(toolModel).toContain("their parameter schemas are NOT shown anywhere in it");
      expect(toolModel).toContain("Never call a protocol tool without a `discover_tools` result from THIS session");
    });

    it("discover_tools no longer hard-codes a stale 4-namespace list", () => {
      const def = getToolDef("discover_tools");
      expect(def).toBeDefined();
      expect(def?.description).not.toContain("khalani, kyberswap, solana, dexscreener");
      // The generated `namespace` param description stays the single source.
      const namespaceDescription = def?.parameters.properties?.namespace;
      expect(JSON.stringify(namespaceDescription)).toContain("Supported namespaces:");
    });
  });

  describe("turn-layer hygiene", () => {
    it("gives the pressure banner and the mission iteration their own H1", () => {
      expect(buildContextPressureBanner("warning", 0.72)).toContain("# Context Pressure");
      const iteration = buildMissionTurnState(7);
      expect(iteration).toContain("# Mission Iteration");
      expect(iteration).toContain("Iteration: 7");
      // The number needs a meaning, or it reads as a budget.
      expect(iteration).toContain("not a budget and not a stop condition");
    });

    it("normal pressure still renders nothing at all", () => {
      expect(buildContextPressureBanner("normal", 0.1)).toBe("");
    });
  });

  describe("retired fossils", () => {
    it("no longer names a tool that does not exist", () => {
      expect(buildResponseFormatPrompt()).not.toContain("hl_positions");
      expect(buildResponseFormatPrompt()).toContain("wallet_balances");
      expect(getToolDef("wallet_balances")).toBeDefined();
    });

    it("the wallet fail-soft banner names a recovery the session actually has", () => {
      // Agent sessions have no mission contract to re-accept.
      const agent = buildWalletStateBanner(makeContext({
        sessionKind: "agent",
        walletPolicy: { kind: "mission_allowed", allowedWallets: ["wallet-not-in-session"] },
        selectedEvmWallet: null,
        selectedSolanaWallet: null,
      }));
      if (agent.includes("fail closed")) {
        expect(agent).not.toContain("mission contract");
      }
    });
  });
});
