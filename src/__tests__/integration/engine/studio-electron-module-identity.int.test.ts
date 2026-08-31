/**
 * Regression guard for the `electron` module identity in the studio-postgres
 * lane (Stage B1).
 *
 * THE DEFECT THIS PINS: `electron` is a devDependency of `vex-app` only. This
 * lane's vite root is the REPOSITORY root, so the bare specifier `electron`
 * resolved differently depending on the importer -
 *
 *   from this file's tree (./src/...)   -> UNRESOLVED (MODULE_NOT_FOUND)
 *   from ./vex-app/src/main/...         -> vex-app/node_modules/electron
 *
 * A `vi.mock("electron")` here therefore registered under a different module id
 * than the one `vex-app` modules import, so the mock silently did not apply.
 * `vitest/studio-postgres.config.ts` fixes it with a single alias; this test is
 * what proves the fix is live and catches its removal.
 *
 * WHY THIS TEST IS THE PROOF: `locateStudioBridge()` reads `app.isPackaged` and
 * `app.getAppPath()` from `electron` when its options are omitted. If the mock
 * does not reach the module under test, there is no real Electron runtime here
 * and the call throws instead of returning a value. It cannot pass by accident.
 *
 * It carries the `.int.` suffix because this lane owns the only cross-tree
 * include list; it needs no database of its own.
 */

import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";

/**
 * The repository root that the mocked `app.getAppPath()` reports. Populated in
 * `beforeAll` so the factory below closes over a stable value; `vi.mock` is
 * hoisted above the imports it shares scope with.
 */
const mocked = { appPath: "", isPackaged: false };

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocked.isPackaged;
    },
    getAppPath: () => mocked.appPath,
  },
}));

/**
 * The slice of `vex-app/src/main/studio/installer/bridge-path.ts` this test
 * drives, named locally rather than imported as a type.
 *
 * The import below is deliberately built from a VARIABLE, not a literal. A
 * literal would pull a `vex-app` source file into the repository-root type
 * project, whose `rootDir` is `src` - and widening that shared config to
 * accommodate one test would be the wrong fix. `vex-app` compiles under its own
 * tsconfigs with its own strictness; this test crosses the boundary at RUNTIME
 * only, which is precisely the thing under test.
 */
type StudioBridgeLocation =
  | { readonly kind: "found"; readonly command: string }
  | { readonly kind: "unavailable"; readonly detail: string };

interface BridgePathModule {
  readonly locateStudioBridge: (options?: {
    readonly packaged?: boolean;
    readonly resourcesPath?: string;
    readonly repoRoot?: string;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  }) => Promise<StudioBridgeLocation>;
}

// Imported AFTER the mock declaration on purpose: this is the vex-app module
// whose `electron` import must resolve to the same id the mock registered.
const bridgePathModule: string = "../../../../vex-app/src/main/studio/installer/bridge-path.js";
const { locateStudioBridge } = (await import(bridgePathModule)) as BridgePathModule;

describe("electron module identity across the src/ <-> vex-app/ boundary", () => {
  let repoRoot = "";
  let bridgeDir = "";

  beforeAll(async () => {
    // A throwaway tree shaped like the development bridge layout, so the
    // assertion is about module identity rather than about this machine
    // happening to have built the Go bridge.
    repoRoot = await mkdtemp(path.join(tmpdir(), "vex-electron-identity-"));
    bridgeDir = path.join(repoRoot, "bridge", "dist", "linux-amd64");
    await mkdir(bridgeDir, { recursive: true });
    const binary = path.join(bridgeDir, "vex-mcp");
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o755);

    // `getAppPath()` is resolved one level up by the module under test.
    mocked.appPath = path.join(repoRoot, "app");
    mocked.isPackaged = false;
  });

  afterAll(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  });

  it("applies a root-side vi.mock('electron') to a vex-app module under test", async () => {
    // No `packaged` and no `repoRoot` option: both come from the MOCKED
    // electron `app`. Reaching a result at all is the proof the mock applied.
    const located = await locateStudioBridge({ platform: "linux", arch: "x64" });

    expect(located).toEqual({
      kind: "found",
      command: path.join(bridgeDir, "vex-mcp"),
    });
  });

  it("routes the mocked isPackaged through to the packaged layout", async () => {
    // The second branch of the same read, so a mock that only satisfied the
    // first call cannot pass this file.
    mocked.isPackaged = true;

    const located = await locateStudioBridge({
      platform: "linux",
      arch: "x64",
      resourcesPath: path.join(repoRoot, "does-not-exist"),
    });

    expect(located.kind).toBe("unavailable");
    mocked.isPackaged = false;
  });
});
