/**
 * THE PROOF, THROUGH A REAL PROCESS: a Studio terminal's bridge dials THIS Vex.
 *
 * Every other test in this file set proves one side of the seam - main puts a
 * key in the overlay, the pty host's deny-list does not take it back out. None
 * of them can prove the thing the user experiences, because that depends on a
 * SECOND implementation, in another language, re-deriving the same socket path
 * from the environment it was handed.
 *
 * It was measured failing. With the app running for an overridden config
 * directory the shell carried no `VEX_CONFIG_DIR` at all, so `vex-mcp` derived
 * the DEFAULT directory's socket, exited 3 ("Vex is not running, or it is
 * running for a different configuration directory"), and the app went on
 * listening on a socket nobody dialled.
 *
 * WHAT THIS DRIVES is the production composition, not a restatement of it: the
 * environment is built by `scrubEnvironment` (the host's base) and
 * `buildTerminalEnvironment` (main's overlay over it), which is exactly the
 * pair `pty-host/terminal-process.ts` applies before node-pty spawns a shell,
 * and the overlay comes from `studioTerminalEnvironmentOverlay` rather than a
 * literal.
 *
 * NO HOST IS STARTED, deliberately. The claim under test is WHICH PATH the
 * bridge derives, and a bridge that names the right path and cannot connect
 * proves it exactly as well as one that connects - while staying free of a
 * listener, a readiness epoch and an MCP handshake that belong to the
 * conformance suite. The path arrives in the bridge's own exit-3 sentence.
 *
 * BOTH LAUNCH PATHS ARE PROVEN HERE, because a user meets the second one more
 * often than the first: a terminal that survived a restart is a NEW process
 * whose environment nothing carried over, and the revived case drives the real
 * `PtyHostService` over a real snapshot so the bytes the bridge is run with are
 * the bytes node-pty would have been handed.
 *
 * SKIPPED BY NAME, with the reason in the suite title, when the Go artifact is
 * absent: a silent skip and a pass are indistinguishable in a reporter.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TERMINAL_SNAPSHOT_VERSION,
  ptyHostEnvironment,
} from "@shared/schemas/terminal.js";
import { PtyHostService } from "../../../pty-host/host-service.js";
import {
  buildTerminalEnvironment,
  scrubEnvironment,
} from "../../../pty-host/process-env.js";
import { TerminalSnapshotStore } from "../../../pty-host/snapshot-store.js";
import { fakeProbe, scriptedSpawnerPool } from "../../../pty-host/__tests__/scripted-pty.js";
import {
  planStudioEndpoint,
  type EndpointDirectoryFacts,
} from "../mcp-host/endpoint.js";
import { studioTerminalEnvironmentOverlay } from "../terminals.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const BRIDGE_BINARY = path.join(REPO_ROOT, "bridge", "dist", "linux-amd64", "vex-mcp");

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** The bridge's exit code for "the endpoint is not there". */
const EXIT_DIAL_FAILED = 3;

function unavailableBecause(): string | null {
  if (process.platform !== "linux") {
    return `the bridge artifact is linux-amd64 and this runner is ${process.platform}`;
  }
  if (process.arch !== "x64") {
    return `the bridge artifact is linux-amd64 and this runner is ${process.arch}`;
  }
  if (!existsSync(BRIDGE_BINARY)) {
    return `the built bridge is missing at ${BRIDGE_BINARY}; run \`bridge/build.sh linux amd64\``;
  }
  return null;
}

const unavailableReason = unavailableBecause();
const suiteName =
  unavailableReason === null
    ? "the built bridge derives the endpoint of the app that opened the terminal"
    : `the built bridge derives the endpoint of the app that opened the terminal `
      + `(SKIPPED: ${unavailableReason})`;

/** The real filesystem, as the endpoint planner probes it. */
function probeDirectory(dir: string): EndpointDirectoryFacts | null {
  try {
    const facts = statSync(dir);
    return {
      isDirectory: facts.isDirectory(),
      uid: facts.uid,
      mode: facts.mode & 0o777,
    };
  } catch {
    return null;
  }
}

interface BridgeRun {
  readonly code: number | null;
  readonly stderr: string;
}

async function runBridge(env: NodeJS.ProcessEnv): Promise<BridgeRun> {
  return await new Promise<BridgeRun>((resolve, reject) => {
    // `env` REPLACES the runner's environment rather than extending it: the
    // point of the test is that a shell carries what Vex gave it and nothing
    // else, and inheriting the runner's own `VEX_*` would answer the question
    // for us.
    const child = spawn(BRIDGE_BINARY, ["--project", PROJECT_ID], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stderr });
    });
    // A bridge that cannot dial exits without reading stdin; closing it keeps
    // the child from waiting on a writer if it ever got as far as the relay.
    child.stdin.end();
  });
}

describe.skipIf(unavailableReason !== null)(suiteName, () => {
  /** The config directory THIS fake app instance resolved. */
  let appConfigDir = "";
  /** A home the default derivation lands in, so both sides can be computed. */
  let fakeHome = "";
  /** `TMPDIR` for both sides, so neither reads the runner's. */
  let fakeTmp = "";

  beforeAll(() => {
    // REALPATH on both: the app hashes the realpath of the config directory
    // and the Go side runs `filepath.EvalSymlinks` over the same value, so a
    // `/tmp` that is itself a symlink must not become the one difference
    // between the two derivations.
    appConfigDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vex-cfg-proof-")));
    fakeHome = realpathSync(mkdtempSync(path.join(tmpdir(), "vex-home-proof-")));
    fakeTmp = realpathSync(mkdtempSync(path.join(tmpdir(), "vex-tmp-proof-")));
    // The endpoint's PARENT, which a running host creates 0700 and the bridge
    // refuses to walk when it is absent (`endpoint_ancestor_changed`, exit 2).
    // Creating it is what lets the run reach the DIAL, and the dial is where
    // the bridge names the socket it derived. The socket itself is never
    // created: nothing is listening, on purpose.
    mkdirSync(path.join(fakeTmp, `vex-studio-${String(process.getuid?.() ?? 0)}`), {
      mode: 0o700,
    });
  });

  afterAll(() => {
    for (const dir of [appConfigDir, fakeHome, fakeTmp]) {
      if (dir !== "") rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The environment a shell in a Studio terminal actually gets, composed the
   * way the pty host composes it.
   *
   * The launcher's own `VEX_CONFIG_DIR` is a DECOY: it is what the process
   * that started Vex exported, it is not what this app resolved, and the
   * deny-list is supposed to remove it before the overlay puts the resolved
   * value in its place.
   */
  function terminalEnvironment(): NodeJS.ProcessEnv {
    const base = scrubEnvironment({
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: fakeHome,
      TMPDIR: fakeTmp,
      VEX_CONFIG_DIR: path.join(fakeHome, "the-launchers-idea-of-config"),
      ELECTRON_RUN_AS_NODE: "1",
      ...ptyHostEnvironment(path.join(appConfigDir, "studio", "terminal-snapshots")),
    });
    return buildTerminalEnvironment(base, studioTerminalEnvironmentOverlay(appConfigDir));
  }

  function expectedSocketFor(configDirRealPath: string): string {
    const plan = planStudioEndpoint({
      platform: "linux",
      configDirRealPath,
      // No `XDG_RUNTIME_DIR`, on purpose: with it unset both sides take the
      // temporary-directory branch, and this suite is about the config
      // directory rather than about the runtime-directory chain.
      env: {},
      tmpdir: fakeTmp,
      uid: process.getuid?.() ?? 0,
      probeDirectory,
    });
    if (plan.kind !== "unix") {
      throw new Error(`expected a unix endpoint, planned ${plan.kind}`);
    }
    return plan.path;
  }

  it("dials the socket THIS app would bind, not the default one", async () => {
    const env = terminalEnvironment();
    // The precondition, asserted rather than assumed: the composed environment
    // is what a shell would really see.
    expect(env["VEX_CONFIG_DIR"]).toBe(appConfigDir);

    const run = await runBridge(env);

    // Nothing is listening, which is the point: the sentence for a missing
    // endpoint names the path the bridge derived, and that path is the claim.
    expect(run.code).toBe(EXIT_DIAL_FAILED);
    expect(run.stderr).toContain(expectedSocketFor(appConfigDir));
    // And it is NOT the path it derived while the defect was live. This is the
    // assertion that goes red if the overlay is removed: with no
    // `VEX_CONFIG_DIR` the bridge falls back to `$HOME/.config/vex`.
    expect(run.stderr).not.toContain(
      expectedSocketFor(path.join(fakeHome, ".config", "vex")),
    );
  }, 30_000);

  it("falls back to the DEFAULT socket when the overlay is absent", async () => {
    // The negative control. Without it, a test that passed because both paths
    // happened to be equal would look identical to one that proved something.
    const base = scrubEnvironment({
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: fakeHome,
      TMPDIR: fakeTmp,
      VEX_CONFIG_DIR: appConfigDir,
    });
    expect(base).not.toHaveProperty("VEX_CONFIG_DIR");

    const run = await runBridge(buildTerminalEnvironment(base, {}));

    expect(run.code).toBe(EXIT_DIAL_FAILED);
    expect(run.stderr).toContain(
      expectedSocketFor(path.join(fakeHome, ".config", "vex")),
    );
    expect(run.stderr).not.toContain(expectedSocketFor(appConfigDir));
  }, 30_000);

  /**
   * THE SAME PROOF FOR A TERMINAL THAT SURVIVED A RESTART, and it is the case a
   * user meets far more often than a fresh create: they quit Vex, reopen it,
   * every pane comes back with its scrollback, and every one of those panes is
   * a NEW process. Nothing about the old shell's environment survived, because
   * the snapshot deliberately holds none.
   *
   * WHAT THIS DRIVES is the whole revive chain rather than a restatement of it:
   * a real `PtyHostService` reads a real snapshot from a real store, composes
   * the environment from ITS OWN base plus the overlay the revive request
   * carried, and the bytes node-pty would have been handed are what the bridge
   * is then run with. The overlay is `studioTerminalEnvironmentOverlay`, the
   * same function `reviveWorkspace` calls.
   *
   * No pty is spawned: the spawner is scripted, because the claim is about the
   * ENVIRONMENT a shell inherits and a real shell would only be a slower way
   * to carry it.
   */
  it("a REVIVED terminal's shell dials this app's socket too", async () => {
    const pool = scriptedSpawnerPool();
    const snapshotDirectory = mkdtempSync(path.join(tmpdir(), "vex-revive-proof-"));
    try {
      const store = new TerminalSnapshotStore(snapshotDirectory);
      const written = await store.write({
        version: TERMINAL_SNAPSHOT_VERSION,
        projectId: PROJECT_ID,
        savedAt: Date.now(),
        layout: {
          projectId: PROJECT_ID,
          groups: [
            {
              groupId: "g1",
              orientation: "horizontal",
              panes: [{ terminalId: "old0", relativeSize: 1 }],
              activePaneIndex: 0,
            },
          ],
          activeGroupIndex: 0,
        },
        terminals: [
          {
            terminalId: "old0",
            title: "bash",
            shellName: "bash",
            executable: "bash",
            args: [],
            cwdAtSpawn: "/projects/demo",
            cols: 80,
            rows: 24,
            serialized: "the previous session's screen",
            droppedRows: 0,
            reducedRows: 0,
          },
        ],
      });
      if (written.kind !== "ok") throw new Error(`seed failed: ${written.kind}`);

      const service = new PtyHostService({
        spawn: pool.spawn,
        probe: fakeProbe({
          directories: ["/projects/demo"],
          files: ["/bin/bash"],
          executables: { bash: "/bin/bash", "/bin/bash": "/bin/bash" },
        }),
        // THE HOST'S OWN BASE, scrubbed exactly as the real host scrubs the
        // environment it booted in - launcher decoy included, so the value the
        // bridge derives can only have come from the overlay.
        baseEnv: scrubEnvironment({
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: fakeHome,
          TMPDIR: fakeTmp,
          VEX_CONFIG_DIR: path.join(fakeHome, "the-launchers-idea-of-config"),
          ELECTRON_RUN_AS_NODE: "1",
        }),
        snapshotStore: store,
        scrollbackRows: 1000,
        graceMs: 60_000,
        shortGraceMs: 6_000,
        sendToMain: () => undefined,
        platform: "linux",
      });

      await service.handleMainMessage(
        {
          requestId: "r1",
          request: {
            kind: "revive",
            projectId: PROJECT_ID,
            windowId: "w1",
            projectLabel: "demo",
            // WHAT MAIN SENDS, from the function main sends it from.
            env: studioTerminalEnvironmentOverlay(appConfigDir),
            assignments: [{ from: "old0", to: "new0" }],
          },
        },
        [],
      );
      await service.shutdownAll();

      const launch = pool.calls[0];
      if (launch === undefined) throw new Error("the revive spawned nothing");
      expect(launch.env["VEX_CONFIG_DIR"]).toBe(appConfigDir);

      const run = await runBridge(launch.env);

      expect(run.code).toBe(EXIT_DIAL_FAILED);
      expect(run.stderr).toContain(expectedSocketFor(appConfigDir));
      // The path it derived while the revive gap was live: with `env: {}` the
      // restored shell carried no `VEX_CONFIG_DIR` and fell back to `$HOME`.
      expect(run.stderr).not.toContain(
        expectedSocketFor(path.join(fakeHome, ".config", "vex")),
      );
    } finally {
      rmSync(snapshotDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
