/**
 * THE FILE VEX JUST WROTE IS NEVER REPORTED AS PREDATING THE SCOPE THAT WROTE IT.
 *
 * `AGENTS.md` carries its change log INSIDE the hashed managed block, and the
 * drift check (`enrichProjectFiles`) re-renders that block from the DURABLE
 * change notes to decide `current` versus `stale`. So the note the render bakes
 * into the file and the note the render stores have to be the SAME LINE, byte
 * for byte. When they are not, every project reports its own freshly written
 * `AGENTS.md` as "the Vex section predates this project's current settings" from
 * the first second, and the sidebar's drift badge - the product's trust signal -
 * opens on a false alarm.
 *
 * The two ways they used to disagree, both proved here:
 *
 *   1. A CREATE. The note baked into the file listed the run's files in
 *      first-pass order with `AGENTS.md` appended LAST, while the note stored
 *      afterwards listed them in PLAN order (`AGENTS.md` before `CLAUDE.md` and
 *      `.vex/protocols.md`). Two different sentences about one run.
 *   2. A SCOPE UPDATE THAT ONLY MOVES THE BLOCK. Renaming a project changes
 *      nothing but `AGENTS.md`, so the run composed NO note for the file and
 *      then stored one anyway.
 *
 * ## What is real here and what is injected
 *
 * The renderers, the plan, the two-pass ordering, the confinement checks, the
 * queue, the drift inspection and the filesystem are REAL, against a real
 * temporary project directory. Injected: the database owners - and the change
 * notes among them are a REAL IN-MEMORY LOG rather than the empty list the
 * sibling suites hand back, because an always-empty log is exactly what hid
 * this defect: the store's half of the comparison was never fed back in.
 * `installer-render-outcome.test.ts` owns the run's own answer; this file owns
 * the agreement between the file and the store.
 */

import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ok } from "@shared/ipc/result.js";
import type { ProjectDto, StudioAgentId } from "@shared/schemas/projects.js";
import type { StudioChangeNote } from "@vex-agent/studio/instructions/project-brief.js";

/** `<repo>/vex-app`, which is what `app.getAppPath()` answers in development. */
const APP_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  locateBridge: vi.fn(),
  provenance: new Map<string, { entryHash: string | null; contentHash: string }>(),
  /** Oldest first, exactly as the table is written; the reader flips it. */
  changeNotes: [] as StudioChangeNote[],
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
  // Newest first and bounded, like `readChangeNotes`'s `ORDER BY id DESC LIMIT`.
  readChangeNotes: async () => ok([...mocks.changeNotes].reverse()),
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
  recordCompleteRender: async () => ok(true),
  appendChangeNote: async (_projectId: string, note: StudioChangeNote) => {
    mocks.changeNotes.push(note);
    return ok(null);
  },
}));

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

const { renderProjectFiles, enrichProjectFiles, __resetStudioRenderQueuesForTests } =
  await import("../installer.js");
const { locateStudioBridge } = await vi.importActual<
  typeof import("../installer/bridge-path.js")
>("../installer/bridge-path.js");

const PROJECT_ID = "3f9a1c22-1111-4111-8111-aaaaaaaaaaaa";
const CORRELATION_ID = "3f9a1c22-2222-4222-8222-bbbbbbbbbbbb";
const SESSION_ID = "3f9a1c22-3333-4333-8333-cccccccccccc";

/** A render needs the real bridge binary; without one the whole run refuses. */
const bridge = await locateStudioBridge();
const hasBridge = bridge.kind === "found";

function scopeFor(options: {
  readonly agents: readonly StudioAgentId[];
  readonly name: string;
  readonly scopeVersion: number;
}) {
  return ok({
    projectId: PROJECT_ID,
    name: options.name,
    slug: "atlas",
    permission: "restricted" as const,
    agents: options.agents,
    scopeVersion: options.scopeVersion,
    wallets: [],
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  });
}

/** The DTO shape `enrichProjectFiles` is handed at the IPC boundary. */
function projectDto(name: string, scopeVersion: number): ProjectDto {
  return {
    id: PROJECT_ID,
    name,
    slug: "atlas",
    rootPath: "atlas",
    displayPath: "~/Vex/projects/atlas",
    permission: "restricted",
    agents: ["claude-code"],
    wallets: { evm: null, solana: null },
    scopeVersion,
    backingSessionId: SESSION_ID,
    files: {
      lastRenderedScopeVersion: scopeVersion,
      generatorFingerprint: null,
      artifacts: [],
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

/** The drift state the badge, the Repair dialog and the report all read. */
async function agentsMdState(name: string, scopeVersion: number): Promise<string> {
  const files = await enrichProjectFiles(projectDto(name, scopeVersion), CORRELATION_ID);
  const agentsMd = files.artifacts.find((artifact) => artifact.kind === "agents-md");
  return agentsMd?.state ?? "absent-from-the-report";
}

let projectDirectory = "";

beforeEach(async () => {
  vi.clearAllMocks();
  __resetStudioRenderQueuesForTests();
  mocks.provenance.clear();
  mocks.changeNotes.length = 0;
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-change-log-")));
  mocks.projectsRoot.current = root;
  projectDirectory = path.join(root, "atlas");
  await mkdir(projectDirectory, { recursive: true });
  mocks.scope.mockResolvedValue(
    scopeFor({ agents: ["claude-code"], name: "Atlas", scopeVersion: 1 }),
  );
  mocks.locateBridge.mockImplementation(async () => locateStudioBridge());
});

afterEach(() => {
  __resetStudioRenderQueuesForTests();
});

describe("the change log in the file and the change log in the store agree", () => {
  it.skipIf(!hasBridge)(
    "reports a freshly created project's own AGENTS.md as current, not stale",
    async () => {
      const outcome = await renderProjectFiles(PROJECT_ID, "create", CORRELATION_ID);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.data.completed).toBe(true);

      // One note for one run, and it is the line the file carries.
      expect(mocks.changeNotes).toHaveLength(1);
      expect(await agentsMdState("Atlas", 1)).toBe("current");
    },
  );

  it.skipIf(!hasBridge)(
    "reports AGENTS.md as current after a scope update that moves only that block",
    async () => {
      const created = await renderProjectFiles(PROJECT_ID, "create", CORRELATION_ID);
      expect(created.ok).toBe(true);

      // A rename changes the brief and therefore the block, and NOTHING else:
      // the agent config, `CLAUDE.md` and `.vex/protocols.md` are unaffected by
      // the project's name.
      mocks.scope.mockResolvedValue(
        scopeFor({ agents: ["claude-code"], name: "Atlas Renamed", scopeVersion: 2 }),
      );
      const updated = await renderProjectFiles(PROJECT_ID, "scope_update", CORRELATION_ID);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      const agentsMd = updated.data.artifacts.find(
        (artifact) => artifact.path === "AGENTS.md",
      );
      expect(agentsMd?.status).toBe("written");

      expect(await agentsMdState("Atlas Renamed", 2)).toBe("current");
    },
  );
});
