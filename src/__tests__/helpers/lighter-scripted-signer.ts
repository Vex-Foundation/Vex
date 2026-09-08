import { EventEmitter } from "node:events";

import {
  runLighterSignerBinary,
  type LighterSignerBinaryRunRequest,
  type LighterSignerBinaryRunner,
  type LighterSignerSpawnDependencies,
} from "@tools/lighter/signer-binary-adapter.js";

/**
 * A signer child whose every transition the test decides, and the runners that
 * drive the REAL adapter over it.
 *
 * Composition, not fabrication: an executor test that hands its executor a fake
 * signer result invents the settlement evidence the executor then acts on, so
 * it can prove nothing about the contract between the two. These runners put
 * `runLighterSignerBinary` and the real adapter projection between the test and
 * the executor, and only script what a real child does - bytes on stdout, a
 * close code, or no close at all.
 *
 * Pattern source: VS Code's `killTree` and its process tests
 * (`src/vs/base/node/processes.ts`, `src/vs/base/test/node/processes/
 * processes.integrationTest.ts`), where the child's own `exit`/`error` events
 * are the only exit evidence and every pipe carries an explicit listener.
 */
class ScriptedSignerPipe extends EventEmitter {
  destroyed = false;
  encoding: string | null = null;
  ended: string | null = null;

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  end(chunk: string): void {
    this.ended = chunk;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export class ScriptedSignerChild extends EventEmitter {
  readonly stdout = new ScriptedSignerPipe();
  readonly stderr = new ScriptedSignerPipe();
  readonly stdin = new ScriptedSignerPipe();
  pid: number | undefined = 4242;
  readonly signals: string[] = [];
  unreferenced = false;

  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): void {
    this.unreferenced = true;
  }

  /** Every listener currently registered across the child and its pipes. */
  listenerTotal(): number {
    return [this, this.stdout, this.stderr, this.stdin].reduce(
      (total, emitter) => total + emitter.eventNames().reduce(
        (sum, name) => sum + emitter.listenerCount(name),
        0,
      ),
      0,
    );
  }

  /** The pipes are destroyed and the child is unreferenced. */
  abandoned(): boolean {
    return this.unreferenced
      && this.stdout.destroyed && this.stderr.destroyed && this.stdin.destroyed;
  }
}

export function scriptedSignerDependencies(
  child: ScriptedSignerChild,
  killDrainGraceMs = 20,
): LighterSignerSpawnDependencies {
  return { spawn: () => child, killDrainGraceMs };
}

type ScriptedSignerPayload = LighterSignerBinaryRunRequest["payload"];

export type ScriptedHelperDocument =
  | unknown
  | ((payload: ScriptedSignerPayload) => unknown);

/** The child writes one helper document and closes cleanly: a resolved run. */
export function signerRunnerEmitting(document: ScriptedHelperDocument): LighterSignerBinaryRunner {
  return (request) => {
    const child = new ScriptedSignerChild();
    const pending = runLighterSignerBinary(request, scriptedSignerDependencies(child));
    const emitted = typeof document === "function"
      ? (document as (payload: ScriptedSignerPayload) => unknown)(request.payload)
      : document;
    child.stdout.emit("data", JSON.stringify(emitted));
    child.emit("close", 0);
    return pending;
  };
}

/** The child writes nothing and closes: a rejection carrying proven exit. */
export function signerRunnerExitingWithoutOutput(): LighterSignerBinaryRunner {
  return (request) => {
    const child = new ScriptedSignerChild();
    const pending = runLighterSignerBinary(request, scriptedSignerDependencies(child));
    child.emit("close", 1);
    return pending;
  };
}

/**
 * The child never closes, not even after SIGKILL: a rejection whose child state
 * is `unknown`. The request's own `timeoutMs` starts the kill.
 */
export function signerRunnerNeverClosing(): LighterSignerBinaryRunner {
  return (request) => runLighterSignerBinary(
    request,
    scriptedSignerDependencies(new ScriptedSignerChild(), 5),
  );
}

/**
 * A failure that never reached the child, so it carries no settlement evidence
 * at all - the case every caller must treat as unknown.
 */
export function signerRunnerRejectingWithoutEvidence(): LighterSignerBinaryRunner {
  return async () => {
    throw new Error("the signer helper could not be started");
  };
}
