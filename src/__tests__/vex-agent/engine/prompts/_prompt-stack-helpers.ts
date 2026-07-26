import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import { buildPromptStack } from "../../../../vex-agent/engine/prompts/index.js";
import type { PromptStackOptions } from "../../../../vex-agent/engine/prompts/index.js";

export function makeContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    sessionId: "session-1",
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

/** Convenience: full prompt text (static + turn) for content assertions. */
export function joinedStack(
  context: EngineContext = makeContext(),
  options: PromptStackOptions = {},
): string {
  const stack = buildPromptStack(context, options);
  return [...stack.staticLayers, ...stack.turnLayers].join("\n");
}
