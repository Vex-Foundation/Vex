import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineContext } from "@vex-agent/engine/types.js";
import { buildPromptStack, resetProtocolsPromptCache } from "@vex-agent/engine/prompts/index.js";

const ENV_KEYS = ["JUPITER_API_KEY", "TAVILY_API_KEY", "RETTIWT_API_KEY"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function context(overrides: Partial<EngineContext>): EngineContext {
  return {
    sessionId: "prompt-budget-report",
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map(),
    ...overrides,
  };
}

const MODES = [
  { name: "agent / restricted", context: context({}), ceiling: 54_135 },
  { name: "agent / full", context: context({ sessionPermission: "full" }), ceiling: 54_836 },
  { name: "mission setup / restricted", context: context({ sessionKind: "mission" }), ceiling: 60_558 },
  { name: "mission setup / full", context: context({ sessionKind: "mission", sessionPermission: "full" }), ceiling: 60_577 },
  { name: "mission run / restricted", context: context({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }), ceiling: 59_174 },
  { name: "mission run / full", context: context({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1", sessionPermission: "full" }), ceiling: 58_989 },
] as const;

beforeAll(() => {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  resetProtocolsPromptCache();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetProtocolsPromptCache();
});

describe("static prompt byte ceilings", () => {
  for (const mode of MODES) {
    it(`${mode.name} stays at or below its measured ceiling`, () => {
      const bytes = buildPromptStack(mode.context).staticLayers.reduce(
        (sum, layer) => sum + Buffer.byteLength(layer, "utf8"),
        0,
      );
      // Lower this ceiling whenever an intentional prompt change makes the
      // measured prefix smaller. Never raise it without a reviewed budget diff.
      expect(bytes).toBeLessThanOrEqual(mode.ceiling);
    });
  }
});
