/**
 * The typed `EngineContext` builder every engine suite should use.
 *
 * Same reason as `tools/_test-context.ts`: `EngineContext` is a LIVE contract
 * that gains required fields when the runtime does (`selectedEvmWallet`,
 * `walletPolicy`, `planMode` were recent additions). A suite that hand-rolls
 * the literal — or casts one through `as any` — does not fail when that
 * happens, because vitest never typechecks. Building through this makes the
 * compiler the thing that notices, once, here.
 *
 * The defaults are least privilege: a restricted agent session with no mission,
 * no selected wallet and no wallet policy, so any authority a test needs is
 * authority it had to ask for out loud.
 */

import type { EngineContext } from "@vex-agent/engine/types.js";

export function makeEngineContext(overrides?: Partial<EngineContext>): EngineContext {
  return {
    sessionId: "test-session",
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map<string, string>(),
    ...overrides,
  };
}
