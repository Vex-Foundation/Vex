/**
 * node-pty behind the host's `PtySpawner` seam - THE ONLY PLACE A REAL SHELL IS
 * SPAWNED.
 *
 * The seam exists so the flow-control, exit-sequencing and resize suites can
 * drive a scripted pty deterministically. Production is this one function, and
 * it lives in its own file for two reasons:
 *
 *  - `index.ts` is wiring only, and a real-pty integration suite needs the
 *    production spawner without the process entry point that reads a parent
 *    port and exits when there is none;
 *  - this is the one module in the host that may import node-pty, which keeps
 *    the packaging contract below in exactly one place.
 *
 * It mirrors `launch-probe.ts`: a production implementation of a `types.ts`
 * seam, in its own file. It is exported as a FACTORY rather than a bare
 * constant because the spawn trace needs a log sink, and a module the host
 * injects must not reach for `console` and become a second logging owner.
 */

/**
 * node-pty, imported here as a BARE EXTERNAL import - that is the packaging
 * contract this process depends on.
 *
 * It must survive into `dist/pty-host/index.js` unbundled. Inlined instead,
 * node-pty's loader would resolve `prebuilds/<platform>-<arch>/pty.node`
 * relative to the bundle rather than to node_modules, and on macOS it would
 * lose its sibling `spawn-helper` binary too - so every terminal would fail at
 * runtime, in the packaged app only. `rolldownOptions.external` in
 * vite.pty-host.config.ts keeps it external and
 * `scripts/check-native-artifacts.mjs` asserts the emitted import is still
 * there.
 */
import nodePty from "node-pty";

import { sanitizeEnvForLogging } from "./process-env.js";
import type { PtyAdapter, PtySpawner } from "./types.js";

/** Whether node-pty's native binding actually loaded. Used by the ready log. */
export function nodePtyLoaded(): boolean {
  return typeof nodePty.spawn === "function";
}

/**
 * Build the one structured line a spawn emits.
 *
 * THE ENVIRONMENT PASSES THROUGH `sanitizeEnvForLogging`, NEVER AROUND IT. A
 * terminal's environment routinely carries `GITHUB_TOKEN`, `AWS_*` and whatever
 * else the user exported before launching Vex; this trace is the diagnostic
 * users attach to bug reports, so values are replaced by their length and the
 * secret never reaches the sink. Keys are kept because "the variable was not
 * set at all" and "the variable was empty" are different bugs.
 *
 * Exported so the redaction can be asserted directly rather than through a
 * spawn, which would require a real shell to test a string.
 */
export function formatSpawnTrace(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): string {
  return `[pty-host] spawn ${JSON.stringify({
    executable,
    args,
    cwd,
    env: sanitizeEnvForLogging(env),
  })}`;
}

/**
 * node-pty's `IPty` declares no `error` event, but the object behind it is an
 * EventEmitter facade over the pty's data socket: `Terminal.prototype.on`
 * forwards to `this._socket.on` and `Terminal.prototype.listeners` to
 * `this._socket.listeners` (`terminal.js:139-166`). That socket is where the
 * rethrow lives, so this is the surface that has to be reached to prevent it.
 *
 * Declared as a narrow structural type rather than cast inline, so the ONE place
 * node-pty's typing is widened is named and explained.
 */
interface PtyErrorEvents {
  on(event: "error", listener: (error: Error) => void): void;
}

/**
 * Whether node-pty would have RETHROWN this socket error.
 *
 * Exactly node-pty's own classification, taken from the handlers that do the
 * rethrowing (`unixTerminal.js:102-124`, `windowsTerminal.js:92-101`):
 *
 *  - `EAGAIN` is the startup noise a `tty.ReadStream` produces twice on Unix;
 *  - `EIO` / `errno 5` is what a pty reports when the last process in the
 *    terminal closes it, which is an ORDINARY exit and already reaches the host
 *    through the exit event.
 *
 * Everything else node-pty throws, and everything else is what this seam is for.
 * Forwarding the benign two as well would report a clean shell exit as a
 * terminal failure - a worse lie than the crash being removed.
 *
 * Exported so the classification can be asserted as a table, rather than through
 * a genuinely broken socket that no test can produce on demand.
 */
export function isFatalPtyError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return true;
  return !(code.includes("EAGAIN") || code.includes("EIO") || code.includes("errno 5"));
}

/**
 * The production spawner, optionally tracing every spawn.
 *
 * The trace sink is a PARAMETER rather than a reach for `console`, because a
 * module the host injects must not become a second, untestable logging owner.
 * `index.ts` passes the same sink the rest of the host logs through.
 */
export function createNodePtySpawner(
  log?: (line: string) => void,
): PtySpawner {
  return (executable, args, options) => {
    log?.(formatSpawnTrace(executable, args, options.cwd, options.env));
    const pty = nodePty.spawn(executable, [...args], {
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: { ...options.env },
    });

    /*
     * THE GUARD LISTENER, registered NOW rather than when a consumer subscribes.
     *
     * node-pty rethrows a socket error while the socket carries fewer than two
     * `error` listeners, its own handler being the first
     * (`windowsTerminal.js:102`, `unixTerminal.js:125`). This registration is
     * the second one, and it is what turns an uncaught exception in the pty host
     * - which would take down every terminal in every project - into an event
     * this terminal's owner can act on. On Windows node-pty attaches its own
     * handler only inside `ready_datapipe` (`windowsTerminal.js:90`), so
     * registering here also puts ours in place from the first moment the socket
     * exists.
     *
     * It is NEVER removed. Removing it when the last consumer unsubscribes would
     * restore the rethrow for a pty that is still alive, so the disposable below
     * detaches the CONSUMER, not this.
     */
    const errorListeners = new Set<(error: Error) => void>();
    (pty as unknown as PtyErrorEvents).on("error", (error: Error) => {
      if (!isFatalPtyError(error)) return;
      // The CAUSE, in the operator log, because the terminal's exit event
      // carries a code and not a reason. `name`, `code` and `message` only: a
      // socket error's message is a syscall description, and nothing else on the
      // object is safe to assume is free of payload.
      log?.(
        `[pty-host] pty error ${JSON.stringify({
          name: error.name,
          code: (error as { code?: unknown }).code ?? null,
          message: error.message,
        })}`,
      );
      for (const listener of [...errorListeners]) listener(error);
    });

    const adapter: PtyAdapter = {
      get pid() {
        return pty.pid;
      },
      get process() {
        return pty.process;
      },
      onData: (listener) => pty.onData(listener),
      onExit: (listener) => pty.onExit(listener),
      onError: (listener) => {
        errorListeners.add(listener);
        return {
          dispose: () => {
            errorListeners.delete(listener);
          },
        };
      },
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      kill: (signal) => (signal === undefined ? pty.kill() : pty.kill(signal)),
      pause: () => pty.pause(),
      resume: () => pty.resume(),
    };
    return adapter;
  };
}
