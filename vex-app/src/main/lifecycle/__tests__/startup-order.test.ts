/**
 * STARTUP ORDER, as a static gate on `index.ts`.
 *
 * The entrypoint runs its whole sequence at import time against a real
 * Electron app, so no unit harness can execute it. The order IS the contract,
 * and it is checked where it lives, in the source, the same way the quit
 * ownership gate checks the quit sequence (`studio/__tests__/quit-ownership`):
 *
 *   execution gate (first import, closed) -> IPC handlers -> gate armed ->
 *   main window, at once -> Studio barrier (background) -> MCP host.
 *
 * The regression this pins: the window waited up to 15 s for the Studio
 * barrier on every cold start, because the barrier waits for a database the
 * renderer has not asked for yet.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, "..", "..", "index.ts"), "utf8");

function bodyOf(functionName: string): string {
  const start = source.indexOf(`async function ${functionName}(`);
  expect(start, functionName).toBeGreaterThan(-1);
  const next = source.indexOf("\nasync function ", start + 1);
  const nextLet = source.indexOf("\nlet ", start + 1);
  const ends = [next, nextLet].filter((position) => position > -1);
  return source.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
}

describe("main startup order", () => {
  it("imports the execution gate FIRST, before every other module", () => {
    const firstImport = source.search(/^import /m);
    const gateImport = source.indexOf('from "./lifecycle/execution-gate.js"');
    expect(firstImport).toBeGreaterThan(-1);
    expect(gateImport).toBeGreaterThan(-1);
    // No other import statement ends before the gate's.
    const beforeGate = source.slice(0, gateImport);
    expect(beforeGate.match(/^import /gm)).toHaveLength(1);
  });

  it("registers the IPC surface, arms the gate, then opens the window without waiting for Studio", () => {
    const init = bodyOf("initializeMainRuntime");
    const register = init.indexOf("registerAllIpcHandlers()");
    const arm = init.indexOf("armExecutionGate(");
    const closeOnQuit = init.indexOf("closeExecutionGateForShutdown()");
    const window = init.indexOf("await createMainWindow()");
    const studio = init.indexOf("void startStudioHostAfterBarrier()");

    for (const position of [register, arm, closeOnQuit, window, studio]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(register).toBeLessThan(arm);
    expect(arm).toBeLessThan(window);
    expect(window).toBeLessThan(studio);

    // The window is never behind the barrier, bounded or not.
    expect(init).not.toContain("await awaitStudioRuntimeReady()");
    expect(init).not.toContain("await whenStudioRuntimeSettled()");
    expect(init).not.toContain("await whenEngineDbReady(");
  });

  it("keeps the Studio barrier before the MCP host bind, off the window's path", () => {
    const host = bodyOf("startStudioHostAfterBarrier");
    const barrier = host.indexOf("await awaitStudioRuntimeReady()");
    const bind = host.indexOf("startStudioMcpHost()");
    const reopen = host.indexOf("reopenStudioHostIfSafe()");
    expect(barrier).toBeGreaterThan(-1);
    expect(barrier).toBeLessThan(bind);
    expect(bind).toBeLessThan(reopen);
  });

  it("arms the gate with the waits that already exist, and nothing that opens it early", () => {
    const init = bodyOf("initializeMainRuntime");
    expect(init).toMatch(/armExecutionGate\(\{\s*whenEngineDbReady:/);
    expect(init).toContain("whenStudioRuntimeSettled,");
    expect(init).toContain("recoverWalletRemovals,");
    // Only the gate's own arming may open it.
    expect(source).not.toContain("openExecutionGate(");
  });
});
