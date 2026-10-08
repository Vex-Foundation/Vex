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
 * A resident (`--serve`) signer child whose every transition the test decides.
 * Request lines written to stdin are recorded; the test answers them by
 * emitting stdout data and decides when (or whether) the child closes.
 */
class ScriptedResidentStdin extends EventEmitter {
  destroyed = false;
  endedCount = 0;
  unreferenced = false;
  readonly lines: string[] = [];
  throwOnWrite = false;

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("EPIPE");
    this.lines.push(chunk);
    return true;
  }

  end(): void {
    this.endedCount += 1;
  }

  destroy(): void {
    this.destroyed = true;
  }

  unref(): void {
    this.unreferenced = true;
  }
}

class ScriptedResidentPipe extends ScriptedSignerPipe {
  unreferenced = false;

  unref(): void {
    this.unreferenced = true;
  }
}

export class ScriptedResidentSignerChild extends EventEmitter {
  readonly stdout = new ScriptedResidentPipe();
  readonly stderr = new ScriptedResidentPipe();
  readonly stdin = new ScriptedResidentStdin();
  pid: number | undefined = 4343;
  readonly signals: string[] = [];
  unreferenced = false;

  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): void {
    this.unreferenced = true;
  }

  /** The request envelopes written so far, parsed. */
  requests(): Array<{ id: string; request: Record<string, unknown> }> {
    return this.stdin.lines.map((line) => JSON.parse(line) as { id: string; request: Record<string, unknown> });
  }

  /** Answer the most recent request with `document` plus its id. */
  answerLast(document: Record<string, unknown>): void {
    const requests = this.requests();
    const last = requests[requests.length - 1];
    if (last === undefined) throw new Error("no request to answer");
    this.stdout.emit("data", `${JSON.stringify({ id: last.id, ...document })}\n`);
  }

  listenerTotal(): number {
    return [this, this.stdout, this.stderr, this.stdin].reduce(
      (total, emitter) => total + emitter.eventNames().reduce(
        (sum, name) => sum + emitter.listenerCount(name),
        0,
      ),
      0,
    );
  }

  abandoned(): boolean {
    return this.unreferenced
      && this.stdout.destroyed && this.stderr.destroyed && this.stdin.destroyed;
  }
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
