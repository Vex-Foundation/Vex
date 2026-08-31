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
    const adapter: PtyAdapter = {
      get pid() {
        return pty.pid;
      },
      get process() {
        return pty.process;
      },
      onData: (listener) => pty.onData(listener),
      onExit: (listener) => pty.onExit(listener),
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      kill: (signal) => (signal === undefined ? pty.kill() : pty.kill(signal)),
      pause: () => pty.pause(),
      resume: () => pty.resume(),
    };
    return adapter;
  };
}
