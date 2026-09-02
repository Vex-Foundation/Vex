/**
 * THE RUN'S OWN ANSWER: what `renderProjectFiles` reports about the run itself.
 *
 * The per-artifact half has `installer-reconcile.test.ts`. This file is about
 * the three facts a caller reads BEFORE the rows, each of which was previously
 * wrong in a way a user could see:
 *
 *   1. A CREATE RENDERS. `create` is a real trigger, it reconciles the same
 *      artifacts every other trigger does, and it says `create` rather than
 *      borrowing `scope_update`.
 *   2. A MISSING BRIDGE IS A RUN FAILURE, not an artifact warning. It used to
 *      arrive as `launch_required` with a null agent, which put a sentence
 *      about choosing a coding agent above the only true one.
 *   3. `completed` IS THE MARKER'S ANSWER. `recordCompleteRender` is guarded on
 *      the scope version, so a scope edit that commits while the files are
 *      being written leaves the durable marker where it was - and the run must
 *      report that refusal instead of the reconciler's optimism.
 *
 * ## What is real here and what is injected
 *
 * The renderers, the plan, the confinement checks, the queue and the filesystem
 * are REAL, against a real temporary project directory. Injected: the two
 * database owners (a Postgres proves nothing extra about this logic and the
 * default lane has none), the projects root (pointed at the temp directory) and
 * the logger, and the bridge locator - which DELEGATES to the real
 * `locateStudioBridge` in every case but the unavailable one, so the happy path
 * writes this repository's own `bridge/dist/<goos>-<goarch>/vex-mcp` path into
 * the config verbatim, exactly as a user's machine would.
 */

import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ok } from "@shared/ipc/result.js";
import type { StudioAgentId } from "@shared/schemas/projects.js";

/** `<repo>/vex-app`, which is what `app.getAppPath()` answers in development. */
const APP_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  locateBridge: vi.fn(),
  provenance: new Map<string, { entryHash: string | null; contentHash: string }>(),
  recordCompleteRender: vi.fn(),
  appendChangeNote: vi.fn(),
  projectsRoot: { current: "" },
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => APP_PATH,
    getVersion: () => "9.9.9-test",
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../database/projects/render-scope.js", () => ({
  readProjectRenderScope: mocks.scope,
}));

vi.mock("../../database/projects/installer-provenance.js", () => ({
  readArtifactProvenance: async () => ok(mocks.provenance),
  readChangeNotes: async () => ok([]),
  commitArtifactProvenance: async (
    _projectId: string,
    record: { artifactKey: string; entryHash: string | null; contentHash: string },
  ) => {
    mocks.provenance.set(record.artifactKey, {
      entryHash: record.entryHash,
      contentHash: record.contentHash,
    });
    return ok(null);
  },
  clearArtifactProvenance: async (_projectId: string, key: string) => {
    mocks.provenance.delete(key);
    return ok(null);
  },
  recordCompleteRender: mocks.recordCompleteRender,
  appendChangeNote: mocks.appendChangeNote,
}));

/**
 * The bridge locator is the ONE injected boundary that still runs for real by
 * default: `beforeEach` points this mock at the actual `locateStudioBridge`, so
 * the happy path writes the true absolute path into the config. Only the
 * unavailable case overrides it, because "this checkout has no bridge" cannot
 * be produced from a real one without deleting the repository's own artifact.
 */
vi.mock("../installer/bridge-path.js", async () => {
  const actual = await vi.importActual<typeof import("../installer/bridge-path.js")>(
    "../installer/bridge-path.js",
  );
  return { ...actual, locateStudioBridge: mocks.locateBridge };
});

vi.mock("../projects-root.js", () => ({
  resolveProjectsRoot: async () => ok(mocks.projectsRoot.current),
  resolveProjectDirectory: (root: string, slug: string) => path.resolve(root, slug),
}));

const { renderProjectFiles, __resetStudioRenderQueuesForTests } = await import(
  "../installer.js"
);
const { locateStudioBridge } = await vi.importActual<
  typeof import("../installer/bridge-path.js")
>("../installer/bridge-path.js");

const PROJECT_ID = "3f9a1c22-1111-4111-8111-aaaaaaaaaaaa";
const CORRELATION_ID = "3f9a1c22-2222-4222-8222-bbbbbbbbbbbb";

/**
 * Whether this checkout has a bridge binary for the running platform.
 *
 * A config that names a binary which is not there is exactly what the installer
 * refuses to write, so the happy path cannot be proved without one. Named
 * loudly rather than silently passing: a machine with no `pnpm build:bridge`
 * skips the real-render case and every other case here still runs.
 */
const bridge = await locateStudioBridge();
const hasBridge = bridge.kind === "found";

function scopeFor(agents: readonly StudioAgentId[], slug: string, scopeVersion = 1) {
  return ok({
    projectId: PROJECT_ID,
    name: "Atlas",
    slug,
    permission: "restricted" as const,
    agents,
    scopeVersion,
    wallets: [],
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  });
}

let projectDirectory = "";

beforeEach(async () => {
  vi.clearAllMocks();
  __resetStudioRenderQueuesForTests();
  mocks.provenance.clear();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-render-")));
  mocks.projectsRoot.current = root;
  // The directory a create has already claimed by the time a render runs.
  projectDirectory = path.join(root, "atlas");
  await mkdir(projectDirectory, { recursive: true });
  mocks.scope.mockResolvedValue(scopeFor(["claude-code"], "atlas"));
  mocks.locateBridge.mockImplementation(async () => locateStudioBridge());
  mocks.recordCompleteRender.mockResolvedValue(ok(true));
  mocks.appendChangeNote.mockResolvedValue(ok(null));
});

afterEach(() => {
  __resetStudioRenderQueuesForTests();
});

describe("a create renders the project's files", () => {
  it.skipIf(!hasBridge)(
    "writes every artifact of the scope and reports the create trigger",
    async () => {
      const outcome = await renderProjectFiles(PROJECT_ID, "create", CORRELATION_ID);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.data.trigger).toBe("create");
      expect(outcome.data.runFailure).toBeNull();
      expect(outcome.data.completed).toBe(true);

      // Every artifact the plan asks for, WRITTEN, not merely reported.
      const byPath = new Map(
        outcome.data.artifacts.map((artifact) => [artifact.path, artifact.status]),
      );
      expect([...byPath.entries()].sort()).toEqual([
        [".mcp.json", "written"],
        [".vex/protocols.md", "written"],
        ["AGENTS.md", "written"],
        ["CLAUDE.md", "written"],
      ]);

      // And the bytes are on disk. The config names the REAL bridge path, which
      // is the whole reason an unavailable bridge stops the run. Compared as
      // the PARSED value: JSON escapes the backslashes of a Windows path, so a
      // substring match on the raw text could never hold there (this test ran
      // on win32 for the first time once the lane built the bridge).
      const config = JSON.parse(
        await readFile(path.join(projectDirectory, ".mcp.json"), "utf8"),
      ) as { mcpServers?: { vex?: { command?: string } } };
      expect(config.mcpServers?.vex?.command).toBe(bridge.kind === "found" ? bridge.command : "");
      const agents = await readFile(path.join(projectDirectory, "AGENTS.md"), "utf8");
      expect(agents).toContain("Atlas");
      const claude = await readFile(path.join(projectDirectory, "CLAUDE.md"), "utf8");
      expect(claude).toContain("@AGENTS.md");
      await readFile(path.join(projectDirectory, ".vex/protocols.md"), "utf8");

      // The marker advanced under the scope version the run reconciled.
      expect(mocks.recordCompleteRender).toHaveBeenCalledWith(
        PROJECT_ID,
        1,
        expect.stringContaining("9.9.9-test"),
      );
    },
  );
});

describe("a missing bridge is a run failure, not a warning", () => {
  it("reports bridge_unavailable, writes nothing, and warns about nothing", async () => {
    mocks.locateBridge.mockResolvedValue({
      kind: "unavailable",
      detail:
        "The Vex Studio bridge binary is missing from this installation, so no "
        + "coding-agent config was written.",
    });

    const outcome = await renderProjectFiles(PROJECT_ID, "create", CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.data.runFailure).toEqual({
      kind: "bridge_unavailable",
      detail: expect.stringContaining("bridge binary is missing"),
    });
    // The trigger is the caller's, not a borrowed one, and the artifact-level
    // vocabulary carries NOTHING about a run-level failure: no warning, no row,
    // and no advanced marker.
    expect(outcome.data.trigger).toBe("create");
    expect(outcome.data.warnings).toEqual([]);
    expect(outcome.data.artifacts).toEqual([]);
    expect(outcome.data.completed).toBe(false);
    expect(mocks.recordCompleteRender).not.toHaveBeenCalled();
  });
});

describe("completed is the durable marker's answer", () => {
  it.skipIf(!hasBridge)(
    "reports completed:false when the scope moved during the run",
    async () => {
      // The UPDATE matched no row: `scope_version` is no longer the one this
      // run reconciled, so the marker stayed where it was.
      mocks.recordCompleteRender.mockResolvedValue(ok(false));

      const outcome = await renderProjectFiles(PROJECT_ID, "create", CORRELATION_ID);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // Every artifact succeeded...
      expect(
        outcome.data.artifacts.every((artifact) => artifact.status === "written"),
      ).toBe(true);
      // ...and the run still does not claim the project is up to date, because
      // the durable record does not say so.
      expect(outcome.data.completed).toBe(false);
      expect(outcome.data.runFailure).toBeNull();
    },
  );
});

describe("supersession", () => {
  it("reports a superseded create honestly and renders nothing for it", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      mocks.scope.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        return scopeFor(["claude-code"], "atlas");
      });
    });

    // THREE jobs, one project. The first is inside its scope read and holds
    // the queue. A second create and then a scope update pile up behind it;
    // both are `update` jobs, so when the queue drains the second one finds a
    // newer sequence than its own and is superseded. That is the concurrent
    // create-versus-scope-edit case, and what it must not do is report the
    // supersession as a failure or as work the user still owes.
    const first = renderProjectFiles(PROJECT_ID, "create", CORRELATION_ID);
    await firstStarted;
    const overtaken = renderProjectFiles(PROJECT_ID, "create", CORRELATION_ID);
    const newer = renderProjectFiles(PROJECT_ID, "scope_update", CORRELATION_ID);
    releaseFirst();

    const [, overtakenOutcome] = await Promise.all([first, overtaken, newer]);
    expect(overtakenOutcome.ok).toBe(true);
    if (!overtakenOutcome.ok) return;

    // It did NOTHING, it says so through the trigger, and it does not dress
    // that up as a failure: the newer run owns the result.
    expect(overtakenOutcome.data.trigger).toBe("superseded");
    expect(overtakenOutcome.data.runFailure).toBeNull();
    expect(overtakenOutcome.data.completed).toBe(false);
    expect(overtakenOutcome.data.artifacts).toEqual([]);
  });
});
