/**
 * THE EXECUTION GATE: may this process start agent, tool or wallet work yet?
 *
 * ## Why it exists
 *
 * The main window used to wait for the Vex Studio readiness barrier before it
 * was created, because an approval IPC handler cannot be invoked before a
 * renderer exists to invoke it. That made "nothing executes during start-up
 * reconciliation" an ordering fact, but it cost a cold launch up to the whole
 * barrier deadline of blank screen: the barrier waits for the engine database,
 * and on a cold start the database only comes up once the RENDERER asks for
 * Docker, which it cannot do before the window exists.
 *
 * The window now opens at once, and this gate carries the property instead.
 * It is CLOSED BY CONSTRUCTION: the state below is initialised closed when the
 * module is evaluated, which happens while `index.ts` imports it, before
 * `app.whenReady()`, before any IPC handler is registered and before any
 * window exists. There is no moment in the life of the process in which an
 * execution request can reach a handler while the gate is still being set up.
 *
 * `registerHandler` consults it for every channel in
 * `EXECUTION_GATED_CHANNELS`, after sender validation and before the handler
 * body, so the refusal is uniform, typed, and writes nothing.
 *
 * ## When it opens
 *
 * Exactly once, from `starting`, when the local runtime is ready: the engine
 * database is reachable with this build's migrations applied, AND the Studio
 * readiness barrier has SETTLED (the abandoned-dispatch reconciler finished,
 * or the barrier gave up and left Studio closed through its own preflight).
 * `armExecutionGate` waits for both with the waits that already exist; it adds
 * no polling of its own.
 *
 * ## What it never gates
 *
 * Stop-direction and read requests: Stop, Pause, cancelling a wake, rejecting
 * an approval, cancelling a launch. A user must always be able to say no, and
 * refusing a refusal protects nothing.
 *
 * ## Shutting down is a one-way door
 *
 * `closeExecutionGateForShutdown` moves the gate to `shutting_down`, and no
 * later `openExecutionGate` (a readiness wait that resolves during teardown)
 * can reopen it.
 */

import { CH } from "@shared/ipc/channels.js";
import type { VexDomain, VexError } from "@shared/ipc/result.js";
import { log } from "../logger/index.js";

export type ExecutionGateState = "starting" | "open" | "shutting_down";

let state: ExecutionGateState = "starting";

export function executionGateState(): ExecutionGateState {
  return state;
}

export function isExecutionGateOpen(): boolean {
  return state === "open";
}

/**
 * Open the gate. Only `starting` can open: a gate that is already open stays
 * open, and a shutting-down one stays shut. Returns whether this call opened it.
 */
export function openExecutionGate(): boolean {
  if (state !== "starting") return false;
  state = "open";
  log.info("[execution-gate] runtime ready; agent, tool and wallet execution admitted");
  return true;
}

/** One-way: nothing after this can reopen the gate in this process. */
export function closeExecutionGateForShutdown(): void {
  if (state === "shutting_down") return;
  state = "shutting_down";
  log.info("[execution-gate] shutting down; execution requests are refused");
}

/**
 * The channels that START work: an agent turn, a mission run, a tool dispatch
 * or a signature. Each is refused while the gate is not open.
 *
 * Explicit, not pattern-derived, so a reviewer can read the whole policy in
 * one place. A static test (`execution-gate.test.ts`) walks every request
 * channel whose name reads like an execution verb and fails when one is
 * neither listed here nor in `EXECUTION_GATE_EXEMPT_CHANNELS`.
 */
export const EXECUTION_GATED_CHANNELS: ReadonlySet<string> = new Set<string>([
  // Agent turns.
  CH.chat.submit,
  CH.chat.steer,
  CH.runtime.requestResume,
  CH.sessions.planAccept,
  // Mission runs.
  CH.mission.start,
  CH.mission.continue,
  CH.mission.recover,
  CH.mission.renew,
  CH.mission.retry,
  CH.mission.restartWithInstruction,
  // Tool dispatch and signatures.
  CH.approvals.approve,
  CH.wallet.remove,
  CH.wallet.restoreRemoved,
  CH.poolsLaunch.deploy,
  CH.poolsLaunch.claim,
  CH.lighterTrading.prepareDeskAction,
  CH.lighterTrading.settleAgentSetup,
  CH.settings.confirmLighterLeverage,
]);

/**
 * Execution-shaped names that are deliberately NOT gated, and why. Every one
 * of them moves toward "less is running", so refusing it during start-up would
 * only take the user's brakes away.
 */
export const EXECUTION_GATE_EXEMPT_CHANNELS: ReadonlySet<string> = new Set<string>([
  CH.runtime.requestPause,
  CH.runtime.requestStop,
  CH.runtime.cancelWake,
  CH.mission.stop,
  CH.approvals.reject,
  CH.poolsLaunch.cancel,
  CH.poolsLaunch.cancelAwaitingForm,
  CH.settings.cancelLighterLeverage,
  CH.wallets.cancelPreparedIntent,
]);

export function isExecutionGatedChannel(channel: string): boolean {
  return EXECUTION_GATED_CHANNELS.has(channel);
}

/**
 * The typed refusal. Fixed copy, no runtime detail: the renderer shows it as
 * is, and it must say plainly that nothing ran.
 */
export function executionGateRefusal(
  domain: VexDomain,
  correlationId: string,
): VexError {
  const shuttingDown = state === "shutting_down";
  return {
    code: "services.runtime_starting",
    domain,
    message: shuttingDown
      ? "Vex is shutting down, so this was not started. Nothing was executed."
      : "Vex is still starting its local services, so this was not started. "
        + "Nothing was executed. Try again once Vex is ready.",
    retryable: !shuttingDown,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

export interface ExecutionGateArmDeps {
  /** Resolves when the engine database is usable; rejects only on abort. */
  readonly whenEngineDbReady: (options: { readonly signal: AbortSignal }) => Promise<void>;
  /**
   * Resolves when the Studio readiness barrier has SETTLED, ready or not.
   * Never rejects.
   */
  readonly whenStudioRuntimeSettled: () => Promise<void>;
  readonly recoverWalletRemovals?: () => Promise<void>;
}

/**
 * Wait for the runtime, then open. Never throws at its caller: an aborted or
 * failed wait leaves the gate CLOSED, which is the safe answer. Returns the
 * abort that cancels the wait (quit).
 */
export function armExecutionGate(deps: ExecutionGateArmDeps): {
  readonly settled: Promise<void>;
  readonly abort: () => void;
} {
  const controller = new AbortController();
  const settled = (async (): Promise<void> => {
    try {
      await deps.whenEngineDbReady({ signal: controller.signal });
      if (controller.signal.aborted) return;
      await deps.whenStudioRuntimeSettled();
      if (controller.signal.aborted) return;
      await deps.recoverWalletRemovals?.();
      if (controller.signal.aborted) return;
      openExecutionGate();
    } catch {
      if (controller.signal.aborted) return;
      log.warn("[execution-gate] runtime readiness wait failed; the gate stays closed");
    }
  })();
  return {
    settled,
    abort: () => {
      controller.abort();
    },
  };
}

/** Test seam: back to the construction state. */
export function __resetExecutionGateForTests(): void {
  state = "starting";
}
