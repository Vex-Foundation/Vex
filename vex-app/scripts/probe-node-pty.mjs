/**
 * Stage B1 load probe: prove `node-pty` loads and works INSIDE Electron, and
 * prove WHICH native artifact it loaded.
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
 * WHICH ARTIFACT, and why it is asserted rather than assumed. node-pty's
 * loader (`lib/utils.js`) searches `build/Release`, then `build/Debug`, then
 * `prebuilds/<platform>-<arch>` - the prebuilds LAST. So "node-pty loaded and
 * spawned a shell" is compatible with the reviewed, unpacked, code-signed
 * prebuild never being touched. The probe resolves the actual artifact from
 * `require.cache` (the `.node` key Node records for every dlopen'd addon;
 * measured to work in Electron 42, unlike `process.moduleLoadList`, which
 * names built-ins rather than addon paths) and fails unless it is the selected
 * prebuild.
 *
 * TWO LAYOUTS, because the dev tree and the package resolve differently:
 *
 *   `pnpm --dir vex-app probe:node-pty`
 *       node_modules as installed.
 *
 *   `pnpm --dir vex-app probe:node-pty:packaged`
 *       the same runtime, requiring node-pty out of a packaged app's
 *       `app.asar`, so the asar redirect to `app.asar.unpacked` and the
 *       packaged prebuild are what get exercised. It runs under the DEV
 *       electron binary on purpose: `build/afterPack.mjs` flips the RunAsNode
 *       fuse OFF in the packaged binary, so the shipped executable cannot be
 *       driven as a script host. Pass `--packaged [dir]` to pick a specific
 *       `dist-electron/<target>-unpacked` directory.
 *
 * Wrap either in `xvfb-run -a` on a headless Linux host - Electron initializes
 * its display layer at startup even when no window is created.
 *
 * Exits 0 on success, non-zero with a diagnostic on any failure. Never hangs:
 * a watchdog fails the probe rather than leaving a stray pty behind.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import { discoverPayloads, nodePtyPrebuildDir, resolvePayload } from "./native-payload-contract.mjs";

const require = createRequire(import.meta.url);

/** Marker echoed through the pty. Distinctive so a shell banner cannot fake it. */
const MARKER = "vex-pty-probe-ok-4f2a1c";

/** Total budget for load + spawn + echo round trip. */
const PROBE_DEADLINE_MS = 20_000;

/** The prebuild directory this host must load, as a POSIX path fragment. */
const EXPECTED_PREBUILD_FRAGMENT = `${nodePtyPrebuildDir(process.platform, process.arch)}/`;

/**
 * Where to require node-pty from, decided from argv.
 *
 * The packaged form points INTO `app.asar`. That is deliberate and is the
 * whole value of the packaged run: Electron's asar support serves node-pty's
 * JS from inside the archive and redirects its `prebuilds/...pty.node` lookup
 * to `app.asar.unpacked`, which is exactly the resolution a shipped Vex
 * performs. Requiring the unpacked copy directly would prove the file exists
 * and nothing about the archive contract.
 */
function resolveTarget(appRoot) {
  const flag = process.argv.indexOf("--packaged");
  if (flag === -1) {
    return { layout: "dev node_modules", specifier: "node-pty" };
  }
  const named = process.argv[flag + 1];
  const payload =
    named !== undefined && !named.startsWith("--")
      ? resolvePayload(path.resolve(appRoot, named))
      : discoverPayloads(appRoot)[0];
  if (payload === undefined) {
    return {
      error:
        "no packaged app found. Run `pnpm --dir vex-app package` first, or pass "
        + "`--packaged dist-electron/<target>-unpacked`.",
    };
  }
  return {
    layout: `packaged ${payload.label}`,
    specifier: path.join(payload.resources, "app.asar", "node_modules", "node-pty"),
  };
}

/**
 * The `.node` artifact node-pty actually dlopen'd, from `require.cache`.
 *
 * More than one `.node` can be cached in a long-lived process; this probe
 * loads exactly one module, and only node-pty's own artifacts are matched, so
 * an unrelated addon cannot answer for it.
 */
function loadedNativeArtifacts(cache) {
  return Object.keys(cache).filter(
    (key) => key.endsWith(".node") && key.split(path.sep).join("/").includes("node-pty/")
  );
}

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

  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const target = resolveTarget(appRoot);
  if (target.error !== undefined) {
    finish(1, `FAIL: ${target.error}`);
    return;
  }

  let pty;
  try {
    pty = require(target.specifier);
  } catch (error) {
    finish(1, `FAIL: node-pty did not load inside Electron (${target.layout}): ${error.stack ?? error}`);
    return;
  }

  console.log(`layout: ${target.layout}`);
  console.log(`node-pty JS resolved from ${require.resolve(target.specifier)}`);
  console.log(`electron=${process.versions.electron} node=${process.versions.node} modules=${process.versions.modules}`);

  // WHICH artifact, printed before it is judged, so a failing run still shows
  // the operator what loaded.
  const artifacts = loadedNativeArtifacts(require.cache);
  console.log(`node-pty native artifacts loaded: ${JSON.stringify(artifacts)}`);
  if (artifacts.length !== 1) {
    finish(
      1,
      `FAIL: expected exactly ONE node-pty native artifact, found ${artifacts.length}. `
        + "The single-candidate contract in scripts/native-payload-contract.mjs is broken."
    );
    return;
  }
  const loaded = artifacts[0].split(path.sep).join("/");
  if (!loaded.includes(EXPECTED_PREBUILD_FRAGMENT)) {
    finish(
      1,
      `FAIL: node-pty loaded ${loaded}, NOT the reviewed prebuild `
        + `(.../${EXPECTED_PREBUILD_FRAGMENT}).\n`
        + "  node-pty's loader searches build/Release BEFORE prebuilds/, so a build/\n"
        + "  directory left by an earlier @electron/rebuild wins over the artifact that\n"
        + "  ships and gets code-signed. Packaging now excludes build/** and sets\n"
        + "  `npmRebuild: false`; a dev tree that still has one is stale - remove\n"
        + "  node_modules/node-pty/build so dev, probe and package all exercise the\n"
        + "  same binary."
    );
    return;
  }
  console.log(`OK: the loaded artifact is the reviewed prebuild for ${process.platform}-${process.arch}`);

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
