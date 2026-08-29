/**
 * Stage B1 load probe: prove `node-pty` loads and works INSIDE Electron.
 *
 * Why this exists as a real probe rather than a unit test: node-pty is the
 * repository's first native runtime dependency. A `vitest` run loads it under
 * the system Node ABI, which proves nothing about Electron. The risk this
 * probe owns is exactly the one a fixture cannot reach - that the shipped
 * `prebuilds/<platform>-<arch>/pty.node` is loadable by Electron's V8/Node
 * build and can drive a real pseudo-terminal.
 *
 * node-pty 1.2.0-beta.15 builds against `node-addon-api` (Node-API), which is
 * ABI-stable across Node and Electron. That is the CLAIM; this probe is the
 * measurement. If node-pty ever moves off Node-API, this probe goes red and
 * the packaging story needs an explicit electron-rebuild step.
 *
 * Run: `pnpm --dir vex-app probe:node-pty` (wrap in `xvfb-run -a` on a
 * headless Linux host - Electron initializes its display layer at startup even
 * when no window is created).
 *
 * Exits 0 on success, non-zero with a diagnostic on any failure. Never hangs:
 * a watchdog fails the probe rather than leaving a stray pty behind.
 */

import { createRequire } from "node:module";
import { app } from "electron";

const require = createRequire(import.meta.url);

/** Marker echoed through the pty. Distinctive so a shell banner cannot fake it. */
const MARKER = "vex-pty-probe-ok-4f2a1c";

/** Total budget for load + spawn + echo round trip. */
const PROBE_DEADLINE_MS = 20_000;

/**
 * Everything the probe must tear down, in reverse acquisition order. The
 * watchdog and the success path share one exit route so a killed pty is never
 * left running and the exit code is decided in exactly one place.
 */
function run() {
  let ptyProcess = null;
  let watchdog = null;
  let settled = false;

  const finish = (code, message) => {
    if (settled) return;
    settled = true;
    if (watchdog) clearTimeout(watchdog);
    try {
      ptyProcess?.kill();
    } catch {
      // The child may already be gone; that is the outcome we wanted anyway.
    }
    console.log(message);
    app.exit(code);
  };

  let pty;
  try {
    pty = require("node-pty");
  } catch (error) {
    finish(1, `FAIL: node-pty did not load inside Electron: ${error.stack ?? error}`);
    return;
  }

  const binaryPath = require.resolve("node-pty/package.json");
  console.log(`node-pty loaded inside Electron from ${binaryPath}`);
  console.log(`electron=${process.versions.electron} node=${process.versions.node} modules=${process.versions.modules}`);

  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";

  try {
    ptyProcess = pty.spawn(shell, [], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, PS1: "" },
    });
  } catch (error) {
    finish(1, `FAIL: pty.spawn(${shell}) threw: ${error.stack ?? error}`);
    return;
  }

  console.log(`spawned ${shell} pid=${ptyProcess.pid}`);

  watchdog = setTimeout(() => {
    finish(1, `FAIL: no marker on the pty within ${PROBE_DEADLINE_MS}ms (saw: ${JSON.stringify(seen)})`);
  }, PROBE_DEADLINE_MS);

  // The shell echoes both the typed command and its output, so the marker is
  // matched against accumulated data rather than a single chunk.
  let seen = "";
  ptyProcess.onData((chunk) => {
    seen += chunk;
    if (seen.includes(MARKER)) {
      finish(0, `PASS: read ${JSON.stringify(MARKER)} back from the pty; exiting`);
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    finish(1, `FAIL: shell exited early (code=${exitCode} signal=${signal ?? "none"}) before the marker appeared`);
  });

  ptyProcess.write(`echo ${MARKER}\r`);
}

app.whenReady().then(run, (error) => {
  console.log(`FAIL: Electron did not become ready: ${error.stack ?? error}`);
  app.exit(1);
});
