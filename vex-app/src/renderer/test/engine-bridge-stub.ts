/**
 * Shared `window.vex.engine` stub for renderer tests.
 *
 * WHY THIS EXISTS. `SessionPanel` (and the hooks it mounts) subscribes to the
 * engine event bridge on mount. Every renderer test that renders the panel —
 * or any of the `lib/api` live-sync hooks — must therefore provide the FULL
 * `EngineEventsBridge` surface, or the component throws
 * "onX is not a function". Before this helper, ~19 test files hand-rolled that
 * stub inline, so adding one subscriber to the bridge broke all of them at
 * once. Adding a member to `EngineEventsBridge` now fails to typecheck HERE and
 * nowhere else.
 *
 * The return type is the real bridge interface on purpose: a new bridge method
 * is a compile error in this file until a default no-op is added, which is the
 * whole point.
 *
 * Every default returns an idempotent no-op unsubscribe. Tests that need to
 * capture a callback pass an override for just that method.
 */

import type { EngineEventsBridge } from "@shared/types/bridge/agent/engine.js";

const noopUnsubscribe = (): void => {};

/**
 * Build a complete engine-bridge stub. `overrides` replaces individual
 * subscribe functions (e.g. one that captures the callback and returns a spy
 * unsubscribe); everything else stays a no-op subscription.
 */
export function makeEngineBridgeStub(
  overrides: Partial<EngineEventsBridge> = {},
): EngineEventsBridge {
  return {
    onTranscriptAppend: () => noopUnsubscribe,
    onStreamDelta: () => noopUnsubscribe,
    onControlState: () => noopUnsubscribe,
    onEngineError: () => noopUnsubscribe,
    onMissionUpdate: () => noopUnsubscribe,
    onCompactionPreparation: () => noopUnsubscribe,
    ...overrides,
  };
}
