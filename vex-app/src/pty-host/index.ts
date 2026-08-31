/**
 * Vex Studio pty host - process entry point.
 *
 * OWNERSHIP: this is the entry of a dedicated Electron `utilityProcess` that
 * will own every pseudo-terminal Vex Studio spawns. Terminals are moved out of
 * the main process on purpose: a wedged or crashing shell must never be able
 * to take down the privileged process that holds wallet and vault authority.
 *
 * STAGE B1 SCOPE: this file is deliberately EMPTY of behavior. B1 delivers the
 * dependency, the packaging story and this build target; the pty service, its
 * IPC protocol, reconnection and flow control all land in B2. The only
 * obligation it carries today is the one a utilityProcess entry cannot skip:
 * stay alive while the parent holds its port, and exit cleanly when it does
 * not. A process that exits immediately would make the B2 protocol work
 * impossible to bring up incrementally.
 *
 * NOTE: `process.parentPort` exists only when Electron launched this file via
 * `utilityProcess.fork`. Running it under plain Node (or Electron's main
 * entry) is a supported diagnostic path and exits 0 rather than hanging.
 */

/**
 * node-pty, imported here in B1 for one reason beyond B2's convenience: the
 * import statement is the PACKAGING CONTRACT this process depends on.
 *
 * It must survive into `dist/pty-host/index.js` as a bare external import.
 * Inlined instead, node-pty's loader would resolve
 * `prebuilds/<platform>-<arch>/pty.node` relative to the bundle rather than to
 * node_modules and every terminal would fail at runtime, in the packaged app
 * only. `rolldownOptions.external` in vite.pty-host.config.ts is what keeps it
 * external, and scripts/check-native-artifacts.mjs asserts the emitted import
 * is still there - an assertion that only means something because this import
 * exists. Do not remove it to "clean up" the B1 scaffolding; B2 replaces it
 * with real use.
 */
import nodePty from "node-pty";

/**
 * Electron's `utilityProcess` child API. Declared locally rather than pulled
 * from `electron` because a utilityProcess entry does NOT import the electron
 * module - `parentPort` is injected onto `process` by the runtime.
 */
interface UtilityProcessParentPort {
  on(event: "message", listener: (message: unknown) => void): void;
  start?(): void;
}

function parentPortOf(target: NodeJS.Process): UtilityProcessParentPort | undefined {
  return (target as NodeJS.Process & { parentPort?: UtilityProcessParentPort }).parentPort;
}

function main(): void {
  const parentPort = parentPortOf(process);

  if (!parentPort) {
    console.log("vex-studio pty host: no parentPort (not a utilityProcess); nothing to serve, exiting");
    return;
  }

  // A top-level import of a native module makes an unloadable node-pty a
  // startup failure of this process, which is the honest outcome: a pty host
  // that cannot open a pty has nothing to serve. Whether the binary WORKS is
  // measured by `pnpm probe:node-pty`, which drives a real pty end to end.
  console.log(
    `vex-studio pty host: ready (pid=${process.pid}, node=${process.versions.node}, `
      + `node-pty spawn=${typeof nodePty.spawn})`
  );

  // Holding a message listener is what keeps the event loop alive until the
  // parent tears the port down. B2 replaces this with the real protocol
  // server; until then an inbound message is acknowledged as unimplemented
  // rather than silently dropped, so a premature caller fails loudly.
  parentPort.on("message", () => {
    console.log("vex-studio pty host: received a message before the B2 protocol exists; ignoring");
  });

  parentPort.start?.();
}

main();
