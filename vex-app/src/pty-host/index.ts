/**
 * Vex Studio pty host - process entry point.
 *
 * OWNERSHIP: this is the entry of a dedicated Electron `utilityProcess` that
 * owns every pseudo-terminal Vex Studio spawns. Terminals live out here on
 * purpose: a wedged or crashing shell must never be able to take down the
 * privileged process that holds wallet and vault authority.
 *
 * This file is WIRING ONLY. Every decision it composes belongs to a module with
 * its own name and its own tests:
 *
 *   config.ts              boot configuration, and its deletion from the env
 *   process-env.ts         the scrubbed base environment terminals inherit
 *   launch-probe.ts        cwd/executable/cwd-tracking against the real OS
 *   terminal-process.ts    one pty: flow control, exit ordering, resize, title
 *   mirror.ts              the authoritative headless xterm behind every replay
 *   persistent-terminal.ts detach, reattach, resync, grace
 *   snapshot-store.ts      revive snapshots on disk
 *   host-service.ts        ownership, routing and the ordered shutdown
 *
 * ## Boot order matters
 *
 * The configuration is read and DELETED before the base environment is
 * captured. Reversing those two would capture `VEX_PTY_*` into the base and
 * export Vex's private configuration into every shell the user opens. The
 * deny-list in `process-env.ts` would also catch it; both locks are deliberate.
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

import {
  TERMINAL_HOST_BEAT_INTERVAL_MS,
  type TerminalHostMessage,
} from "@shared/schemas/terminal.js";
import { readAndClearPtyHostConfig } from "./config.js";
import { PtyHostService, type HostPort } from "./host-service.js";
import { filesystemLaunchProbe } from "./launch-probe.js";
import { scrubEnvironment } from "./process-env.js";
import { TerminalSnapshotStore } from "./snapshot-store.js";
import type { PtyAdapter, PtySpawner } from "./types.js";

/**
 * Electron's `utilityProcess` child API. Declared locally rather than pulled
 * from `electron` because a utilityProcess entry does NOT import the electron
 * module - `parentPort` is injected onto `process` by the runtime.
 */
interface ElectronMessagePort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

interface UtilityProcessMessageEvent {
  readonly data: unknown;
  readonly ports: readonly ElectronMessagePort[];
}

interface UtilityProcessParentPort {
  on(event: "message", listener: (event: UtilityProcessMessageEvent) => void): void;
  postMessage(value: unknown): void;
  start?(): void;
}

function parentPortOf(target: NodeJS.Process): UtilityProcessParentPort | undefined {
  return (target as NodeJS.Process & { parentPort?: UtilityProcessParentPort })
    .parentPort;
}

/** Adapt an Electron `MessagePortMain` to the host's narrow port seam. */
function adaptPort(port: ElectronMessagePort): HostPort {
  return {
    postMessage: (value) => port.postMessage(value),
    onMessage: (listener) => {
      port.on("message", (event) => listener(event.data));
      port.start();
    },
    close: () => port.close(),
  };
}

/**
 * node-pty behind the host's `PtySpawner` seam.
 *
 * The seam exists so the flow-control, exit-sequencing and resize tests can
 * drive a scripted pty deterministically. Production is this one function.
 */
const nodePtySpawner: PtySpawner = (executable, args, options) => {
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

function main(): void {
  const parentPort = parentPortOf(process);
  if (!parentPort) {
    console.log(
      "vex-studio pty host: no parentPort (not a utilityProcess); nothing to serve, exiting",
    );
    return;
  }

  // Read and DELETE the configuration BEFORE capturing the base environment.
  const config = readAndClearPtyHostConfig();
  if (config === null) {
    console.error(
      "vex-studio pty host: no absolute VEX_PTY_SNAPSHOT_DIR; refusing to guess a "
        + "directory to write user data into",
    );
    process.exit(1);
    return;
  }

  const baseEnv = scrubEnvironment(process.env);

  const sendToMain = (message: TerminalHostMessage): void => {
    parentPort.postMessage(message);
  };

  const service = new PtyHostService({
    spawn: nodePtySpawner,
    probe: filesystemLaunchProbe,
    baseEnv,
    snapshotStore: new TerminalSnapshotStore(config.snapshotDir),
    scrollbackRows: config.scrollbackRows,
    graceMs: config.graceMs,
    shortGraceMs: config.shortGraceMs,
    sendToMain,
    log: (line) => console.log(line),
  });

  parentPort.on("message", (event) => {
    const ports = event.ports.map(adaptPort);
    void service.handleMainMessage(event.data, ports);
  });

  /**
   * The heartbeat. Main's two-stage ladder measures the gap between beats, so
   * an interval is the whole implementation: a host wedged in a synchronous
   * native call stops beating, which is exactly the condition the ladder looks
   * for. `unref` is deliberately NOT called - the beat is this process's reason
   * to stay alive when it holds no other handle.
   */
  setInterval(() => sendToMain({ kind: "heartbeat" }), TERMINAL_HOST_BEAT_INTERVAL_MS);

  parentPort.start?.();

  console.log(
    `vex-studio pty host: ready (pid=${String(process.pid)}, `
      + `node=${process.versions.node}, node-pty spawn=${typeof nodePty.spawn}, `
      + `scrollback=${String(config.scrollbackRows)})`,
  );
}

main();
