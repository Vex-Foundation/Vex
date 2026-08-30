/**
 * END TO END: `deleteProject`, on a REAL Postgres and a REAL filesystem.
 *
 * The unit suites already prove the parts. What no unit suite can prove is the
 * COMPOSITION - the lifecycle gate, the tombstone transaction, the installer
 * queue, the teardown planner, the confined filesystem and the trash step
 * running in one order against durable state - and every property below is a
 * property of that composition:
 *
 *   - a repeated delete on an unfinished tombstone RESUMES, and honours the
 *     tombstone's recorded trash intent rather than the retry's checkbox;
 *   - a trash failure AFTER the commit does not roll the commit back;
 *   - an in-flight call blocks the delete, reopens admission and writes NOTHING;
 *   - the teardown removes exactly Vex's own bytes and leaves every user byte,
 *     which is asserted on the file CONTENTS, not on their existence;
 *   - a hand-edited managed block survives the delete untouched.
 *
 * ## What is mocked, and why only these
 *
 * Three boundaries, all of them outside the behaviour under test: the
 * main-process logger (which imports the desktop runtime), and the two places
 * that answer "where does this app keep things" - the compose connection state,
 * pointed at the lane's own container, and the configured projects root,
 * pointed at a temp directory. Everything else is the production module.
 *
 * The OS TRASH is not mocked, it is INJECTED. `deleteProject` takes its trash
 * capability as a dependency (`ProjectDeleteDeps`), and this file passes a fake
 * through the same parameter production wires `studio/os-trash.ts` into. That
 * is what keeps `electron` out of this module graph entirely, which is what
 * lets the `test:studio-postgres` lane - where Electron is not installed - run
 * the real composition at all.
 *
 * ## Why it is an `.int.test.ts` and not part of `pnpm --dir vex-app test`
 *
 * It needs a real PostgreSQL with every migration applied, which only the
 * `test:studio-postgres` lane provides (it starts the container in its global
 * setup). vex-app's own vitest projects therefore EXCLUDE `*.int.test.ts`, and
 * that lane includes this directory's. The file lives here rather than in the
 * engine's test tree because vex-app owns the composition under test.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  /** The configured projects root, rewritten per test. */
  projectsRoot: "",
  /**
   * The injected OS trash. Not a module mock: this is handed to the production
   * entry points as `deps.trashItem`, exactly where `trashItemToOsTrash` goes.
   */
  trashItem: vi.fn<(target: string) => Promise<void>>(),
}));

/** The dependency bundle every call below passes. One fake, one seam. */
const deps = { trashItem: runtime.trashItem };

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
  configureLogger: (): void => undefined,
  redact: (value: unknown): unknown => value,
  redactArgs: (value: unknown): unknown => value,
}));

vi.mock("../../database/db-config.js", () => ({
  buildPoolConfig: (): Promise<{
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  } | null> => {
    const url = process.env.VEX_DB_URL;
    if (url === undefined || url === "") return Promise.resolve(null);
    const parsed = new URL(url);
    return Promise.resolve({
      host: parsed.hostname,
      port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  },
}));

/**
 * The SECRET SESSION, mocked to "unlocked".
 *
 * `runStudioCall` refuses outright on a locked Vex, and the enqueue gate refuses
 * a second time inside its transaction. Neither is the subject here, and both
 * are proven by their own suites; unlocking is what lets a REAL call reach the
 * park this file is about. It is a main-process authority reader with no
 * database or filesystem behind it, so the mock replaces a boolean, not
 * behaviour under test.
 */
vi.mock("../../secrets/session.js", () => ({
  isSecretSessionUnlocked: (): boolean => true,
  isStudioDispatchPoisoned: (): boolean => false,
  isStudioSessionTransitionInProgress: (): boolean => false,
}));

vi.mock("@config/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@config/store.js")>();
  return {
    ...actual,
    loadConfig: () => ({ ...actual.getDefaultConfig(), projectsRoot: runtime.projectsRoot }),
  };
});

import {
  STUDIO_AGENTS,
  isWritableStudioAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import {
  mergeClaudeMdImport,
  mergeStudioAgentConfig,
  mergeStudioManagedBlock,
  readStudioOwnedRegion,
  studioManagedBlockOwnership,
  studioTomlHeader,
  type StudioProjectBrief,
} from "@vex-agent/studio/installer/render/index.js";
import {
  STUDIO_SETTLEMENT_EVENT_TYPE,
  studioSettlementBus,
} from "@vex-agent/engine/runtime/studio-settlement-bus.js";
import { encodeStudioSettlement } from "@vex-agent/engine/core/approval-runtime/studio/settlement-codec.js";
import { getStudioSettlementByApprovalId } from "@vex-agent/db/repos/approval-intents.js";
// Types only: the executor chunk itself stays behind its loader seam, and an
// `import type` is erased, so the stub below is checked against the real
// contract without pulling the chunk into this file's module graph.
import type { StudioExecution } from "@vex-agent/mcp/executor.js";
import type { StudioToolCall } from "@vex-agent/mcp/admission.js";
import type { ProjectScope } from "@vex-agent/mcp/project-scope.js";
import { renderStudioProtocolsDoc } from "@vex-agent/studio/instructions/protocols-doc.js";

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  ProjectDeleteResult,
  StudioArtifactOutcome,
} from "@shared/schemas/projects.js";
import { withClient } from "../../database/sessions/connection.js";
import { commitArtifactProvenance } from "../../database/projects/installer-provenance.js";
import { hashText } from "../installer/confined-fs.js";
import { __resetStudioRenderQueuesForTests } from "../installer/queue.js";
import {
  acquireProjectLease,
  heldProjectLeases,
  isProjectAdmitting,
  registerProjectCloseHook,
  resetProjectLifecycleGateForTests,
} from "../project-lifecycle-gate.js";
import { runStudioCall } from "../approval-service.js";
import { settleStudioWaiter, studioWaiterCount } from "../approval-broker.js";
import { setStudioExecutorLoaderForTests } from "../executor-loader.js";
import {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  resetStudioReadinessForTests,
} from "../readiness.js";
import {
  PROJECT_CLEANUP_STICKY_ATTEMPTS,
  deleteProject,
  repairUnfinishedProjectCleanups,
} from "../project-delete.js";

/**
 * One statement on the lane's database, through vex-app's OWN connection.
 *
 * Deliberately not the engine's pool helper: this test belongs to vex-app, and
 * seeding through the same connection wrapper the code under test uses proves
 * the two agree about which database they are talking to.
 */
async function sql<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await withClient(async (client) => {
    const rows = await client.query<T>(text, [...values]);
    return ok(rows.rows);
  });
  if (!result.ok) throw new Error(`seed statement failed: ${text}`);
  return result.data;
}

/** Wipe every table the migrations own, keeping `schema_version`. */
async function resetDatabase(): Promise<void> {
  const tables = await sql<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_version'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((row) => `"${row.tablename}"`).join(", ");
  await sql(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

const PROJECT_NAME = "Test";
/**
 * The registry entry, narrowed through the production guard.
 *
 * `STUDIO_AGENTS` is typed as the union, and only the writable variant has a
 * `configPath` or a renderer. Narrowing through `isWritableStudioAgent` rather
 * than asserting means a future registry change that makes Claude Code
 * unwritable fails this test loudly instead of silently skipping the artifact.
 */
const CLAUDE_CODE: StudioWritableAgent = (() => {
  const agent = STUDIO_AGENTS["claude-code"];
  if (!isWritableStudioAgent(agent)) {
    throw new Error("claude-code is no longer a writable agent");
  }
  return agent;
})();

/** The TOML dialect's registry entry, narrowed through the same production guard. */
const CODEX: StudioWritableAgent = (() => {
  const agent = STUDIO_AGENTS["codex"];
  if (!isWritableStudioAgent(agent)) {
    throw new Error("codex is no longer a writable agent");
  }
  return agent;
})();

/** The user's own bytes in each file. Every assertion below is about these. */
const USER_AGENTS_MD = "# My repo\n\nUser notes that Vex must never touch.\n";
const USER_CLAUDE_MD = "# House rules\n\nAlways run the tests.\n";
/**
 * A comment-rich TOML file with a FOREIGN server section, which is the shape a
 * section-level text rewrite has to survive: a serializing round trip would move
 * or lose the comments and re-spell the foreign section.
 */
const USER_CODEX_TOML = `# My Codex settings. Do not let anything reformat this.
model = "gpt-5"

# Another team's MCP server. Nothing to do with Vex.
[mcp_servers.house-tools]
command = "house-cli"
args = ["--serve"]
`;

const FOREIGN_MCP_CONFIG = JSON.stringify(
  { mcpServers: { "not-vex": { command: "other-cli", args: ["--serve"] } } },
  null,
  2,
) + "\n";

let projectsRoot = "";

interface SeededProject {
  readonly projectId: string;
  readonly sessionId: string;
  readonly slug: string;
  readonly directory: string;
}

function briefFor(projectId: string): StudioProjectBrief {
  return {
    projectName: PROJECT_NAME,
    projectId,
    vexVersion: "0.0.0-test",
    permission: "restricted",
    wallets: [{ family: "evm", address: "0x00000000000000000000000000000000000000ff" }],
    createdOn: "2026-08-01",
    scopeUpdatedOn: "2026-08-02",
    agentNames: [CLAUDE_CODE.displayName],
    inventory: {
      alwaysLoadedCount: 1,
      alwaysLoadedNames: ["vex_ToolSearch"],
      searchableCount: 1,
      protocols: [{ name: "core", toolCount: 1 }],
    },
    changeNotes: [{ version: "0.0.0-test", date: "2026-08-02", summary: "Created." }],
  };
}

/** A project row plus its backing Studio session and its directory on disk. */
async function seedProject(): Promise<SeededProject> {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const slug = `p-${projectId.slice(0, 8)}`;
  await sql(
    "INSERT INTO sessions (id, mode, scope) VALUES ($1, 'agent', 'vex_studio')",
    [sessionId],
  );
  await sql(
    `INSERT INTO projects (id, name, slug, root_path, permission,
                           backing_session_id, scope_version)
     VALUES ($1, $2, $3, $3, 'restricted', $4, 1)`,
    [projectId, PROJECT_NAME, slug, sessionId],
  );
  const directory = path.join(projectsRoot, slug);
  await mkdir(directory, { recursive: true });
  return { projectId, sessionId, slug, directory };
}

/**
 * The state a crashed run leaves behind: the tombstone committed, the files
 * still on disk, the obligation recorded.
 *
 * Written with the production statement's own columns rather than through
 * `deleteProject`, because the sweep's subject is a tombstone whose cleanup
 * NEVER RAN - which is exactly what a completed `deleteProject` cannot produce.
 */
async function tombstoneWithPendingCleanup(
  projectId: string,
  cleanupState: "pending" | "trash_pending",
  deletedAt = "2026-08-01T00:00:00Z",
): Promise<void> {
  await sql(
    `UPDATE projects
        SET deleted_at = $3, cleanup_state = $2, cleanup_attempts = 0,
            cleanup_last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
    [projectId, cleanupState, deletedAt],
  );
  await sql(
    "UPDATE sessions SET deleted_at = NOW() WHERE id = (SELECT backing_session_id FROM projects WHERE id = $1)",
    [projectId],
  );
}

/**
 * One PENDING Studio approval intent, with the `approval_queue` row that pairs
 * with it. Both are required: the refusal primitive settles the queue row first
 * and the intent second, and a seed missing either half would prove only half
 * the contract.
 */
async function seedPendingStudioIntent(project: SeededProject): Promise<string> {
  const approvalId = randomUUID();
  await sql(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id,
                                 tool_call_id, source)
     VALUES ($1, '{}'::jsonb, 'because', 'pending', $2, $3, 'studio_mcp')`,
    [approvalId, project.sessionId, `call-${approvalId}`],
  );
  await sql(
    `INSERT INTO approval_intents
       (approval_id, session_id, mission_run_id, tool_call_id, action_kind,
        risk_level, preview_json, policy_json, decision, decided_at,
        execution_status, origin, project_id, scope_version_at_enqueue,
        dispatch_generation_at_enqueue)
     VALUES ($1, $2, NULL, $3, 'user_wallet_broadcast', 'high',
             '{}'::jsonb, '{}'::jsonb, NULL, NULL,
             'not_started', 'studio_mcp', $4, 1, '1')`,
    [approvalId, project.sessionId, `call-${approvalId}`, project.projectId],
  );
  return approvalId;
}

/** Write one artifact through the REAL renderer and record its provenance. */
async function installArtifact(
  projectId: string,
  directory: string,
  artifactKey: string,
  relativePath: string,
  text: string,
  entryHash: string | null,
  origin: "written" | "adopted" = "written",
): Promise<void> {
  const absolute = path.join(directory, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
  const recorded = await commitArtifactProvenance(projectId, {
    artifactKey,
    relativePath,
    entryHash,
    contentHash: hashText(text),
    // These helpers seed the state an INSTALL leaves behind, and an install
    // that rendered and replaced the bytes records `written`. Seeding
    // `adopted` by default would make every teardown assertion below trivially
    // pass by keeping everything, so it has to be asked for.
    origin,
  });
  if (!recorded.ok) throw new Error("provenance seed failed");
}

/**
 * Put the project's four artifacts on disk exactly as an install leaves them.
 *
 * Every byte comes from the production renderers and the production digest
 * function, so this seeds the state a real install produces rather than a
 * hand-written approximation of it. `agentsMdText` is an override used by the
 * drift case.
 */
async function installProjectArtifacts(
  project: SeededProject,
  options: { readonly agentsMdText?: string } = {},
): Promise<void> {
  const brief = briefFor(project.projectId);
  const facts = { projectId: project.projectId, bridgeCommand: "/opt/vex/vex-mcp" };

  const config = mergeStudioAgentConfig(FOREIGN_MCP_CONFIG, CLAUDE_CODE, facts);
  if (config.status !== "rendered") throw new Error("agent config seed did not render");
  const region = readStudioOwnedRegion(config.text, CLAUDE_CODE);
  if (region.kind !== "present") throw new Error("agent config seed has no Vex region");
  await installArtifact(
    project.projectId,
    project.directory,
    "agent:claude-code",
    CLAUDE_CODE.configPath,
    config.text,
    region.hash,
  );

  const merged = mergeStudioManagedBlock(USER_AGENTS_MD, brief, { overwriteDrift: false });
  if (merged.status !== "rendered") throw new Error("AGENTS.md seed did not render");
  const agentsMdText = options.agentsMdText ?? merged.text;
  // The RECORDED body hash is always the one the install wrote. A drifted
  // seed therefore carries the same provenance a drifted real project has.
  const ownership = studioManagedBlockOwnership(merged.text);
  if (ownership.kind !== "intact") throw new Error("AGENTS.md seed is not intact");
  await installArtifact(
    project.projectId,
    project.directory,
    "agents-md",
    "AGENTS.md",
    agentsMdText,
    ownership.bodyHash,
  );

  const claudeMd = mergeClaudeMdImport(USER_CLAUDE_MD);
  if (claudeMd.status !== "rendered") throw new Error("CLAUDE.md seed did not render");
  await installArtifact(
    project.projectId,
    project.directory,
    "claude-md",
    "CLAUDE.md",
    claudeMd.text,
    null,
  );

  await installArtifact(
    project.projectId,
    project.directory,
    "protocols-doc",
    ".vex/protocols.md",
    renderStudioProtocolsDoc(),
    null,
  );
}

async function readTombstone(projectId: string): Promise<{
  deleted: boolean;
  cleanup_state: string;
  cleanup_attempts: number;
}> {
  const rows = await sql<{
    deleted_at: Date | null;
    cleanup_state: string;
    cleanup_attempts: number;
  }>(
    "SELECT deleted_at, cleanup_state, cleanup_attempts FROM projects WHERE id = $1",
    [projectId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("project row missing");
  return {
    deleted: row.deleted_at !== null,
    cleanup_state: row.cleanup_state,
    cleanup_attempts: row.cleanup_attempts,
  };
}

async function provenanceKeys(projectId: string): Promise<string[]> {
  const rows = await sql<{ artifact_key: string }>(
    "SELECT artifact_key FROM project_file_provenance WHERE project_id = $1 ORDER BY artifact_key",
    [projectId],
  );
  return rows.map((row) => row.artifact_key);
}

function outcomeFor(
  cleanup: readonly StudioArtifactOutcome[],
  artifactPath: string,
): StudioArtifactOutcome {
  const found = cleanup.find((entry) => entry.path === artifactPath);
  if (found === undefined) {
    throw new Error(`no cleanup outcome for ${artifactPath}: ${JSON.stringify(cleanup)}`);
  }
  return found;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function unwrap(result: Result<ProjectDeleteResult, VexError>): ProjectDeleteResult {
  if (!result.ok) throw new Error(`deleteProject failed: ${result.error.code}`);
  return result.data;
}

beforeEach(async () => {
  await resetDatabase();
  // `resetDatabase` TRUNCATEs every table, including the singleton row
  // migration 086 seeds into `studio_runtime_gate`. Without it
  // `readStudioDispatchGeneration` answers `null` and the enqueue gate refuses
  // every intent - which is a correct refusal for a runtime that cannot prove
  // its fence, and would silently make the parked-call tests below assert
  // nothing.
  await sql(
    `INSERT INTO studio_runtime_gate (id, dispatch_generation)
     VALUES (1, 1) ON CONFLICT (id) DO NOTHING`,
  );
  resetStudioReadinessForTests();
  setStudioExecutorLoaderForTests(null);
  resetProjectLifecycleGateForTests();
  __resetStudioRenderQueuesForTests();
  runtime.trashItem.mockReset();
  runtime.trashItem.mockResolvedValue(undefined);
  projectsRoot = await mkdtemp(path.join(tmpdir(), "vex-studio-delete-"));
  runtime.projectsRoot = projectsRoot;
});

afterEach(async () => {
  setStudioExecutorLoaderForTests(null);
  resetStudioReadinessForTests();
  await rm(projectsRoot, { recursive: true, force: true });
});

/**
 * The two `project_wallets` rows every project has, with NO wallet selected.
 *
 * `projectWallets` requires a row per family (an absent one is a write-around
 * and reports `missing_family`), and a row whose `wallet_id` is NULL is the
 * honest "no selection" - which resolves without consulting the wallet
 * inventory. That keeps these tests off the keystore entirely: the subject is
 * the lifecycle gate, not which key would sign.
 */
async function seedProjectWallets(projectId: string): Promise<void> {
  await sql(
    `INSERT INTO project_wallets (project_id, family, wallet_id, address)
     VALUES ($1, 'evm', NULL, NULL), ($1, 'solana', NULL, NULL)`,
    [projectId],
  );
}

/**
 * The Studio executor chunk, replaced with one that always answers "this needs
 * approval".
 *
 * This is the ONE boundary these tests stub, and it is the right one: what a
 * restricted mutating tool does before its approval gate is A2's subject and
 * has its own suites. Everything downstream of the returned result - the waiter
 * reservation, the enqueue transaction and its project gate, the durable
 * intent, the broker park, the lease reclassification, and the settlement
 * mapping - is the production code path.
 *
 * The double is TYPED against the real chunk's contract instead of cast into
 * place. `@vex-agent/mcp/executor.js` exports exactly one value, so an object
 * literal carrying a correctly typed `executeStudioTool` already IS a
 * `StudioExecutorModule`. Typing it is what keeps the fake honest: it has to
 * echo the caller's `toolCallId`, which the previous double cast let it omit.
 */
function stubPendingApprovalExecutor(): void {
  setStudioExecutorLoaderForTests(() =>
    Promise.resolve({
      executeStudioTool: (
        _scope: ProjectScope,
        call: StudioToolCall,
      ): Promise<StudioExecution> =>
        Promise.resolve({
          result: {
            success: false,
            output: "This action needs approval.",
            pendingApproval: true,
            actionKind: "user_wallet_broadcast",
          },
          durationMs: 1,
          toolCallId: call.toolCallId,
        }),
    }),
  );
}

/** Poll until `predicate` holds, or fail with a message naming what was awaited. */
async function until(
  what: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The settlement bridge's `releaseWaiter` body, and only that.
 *
 * Production wires this through `setupStudioSettlementBridge`, which also
 * registers the dispatch preflight, runs the abandoned-dispatch reconciler and
 * owns a readiness epoch - none of which is the subject here. These two
 * statements ARE the release path: read the committed row by id, hand it to the
 * broker. Everything the assertions depend on downstream is production code.
 */
function subscribeReleaseBridge(): () => void {
  return studioSettlementBus.subscribe((event) => {
    void (async () => {
      const row = await getStudioSettlementByApprovalId(event.approvalId);
      if (row !== null) settleStudioWaiter(row);
    })();
  });
}

describe("deleteProject: the filesystem teardown", () => {
  it("removes every Vex byte and preserves every user byte", async () => {
    const project = await seedProject();
    await installProjectArtifacts(project);

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-teardown",
        deps,
      ),
    );

    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;

    // THE USER'S BYTES, asserted as CONTENTS. "the file still exists" would
    // pass on a file we emptied, which is the failure mode that matters.
    expect(await readFile(path.join(project.directory, "AGENTS.md"), "utf8")).toBe(
      USER_AGENTS_MD,
    );
    expect(await readFile(path.join(project.directory, "CLAUDE.md"), "utf8")).toBe(
      USER_CLAUDE_MD,
    );
    const config = JSON.parse(
      await readFile(path.join(project.directory, CLAUDE_CODE.configPath), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers["not-vex"]).toEqual({
      command: "other-cli",
      args: ["--serve"],
    });
    expect(Object.keys(config.mcpServers)).toEqual(["not-vex"]);

    // VEX'S OWN BYTES, gone.
    expect(await exists(path.join(project.directory, ".vex/protocols.md"))).toBe(false);

    expect(outcomeFor(result.cleanup, "AGENTS.md").status).toBe("removed");
    expect(outcomeFor(result.cleanup, "CLAUDE.md").status).toBe("removed");
    expect(outcomeFor(result.cleanup, ".vex/protocols.md").status).toBe("removed");
    expect(outcomeFor(result.cleanup, CLAUDE_CODE.configPath).status).toBe("removed");

    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
    });
    // The folder was not requested for trashing, so it is still there.
    expect(runtime.trashItem).not.toHaveBeenCalled();
    expect(result.trash).toBe("not_requested");
    expect(await exists(project.directory)).toBe(true);
  });

  /**
   * CONTRACT CHANGE (round 3): a drift refusal now DISCHARGES the obligation.
   *
   * This test previously asserted `cleanup_pending`, `cleanup_state = 'pending'`
   * and `cleanup_attempts = 1`. That made a CORRECT, permanent answer into an
   * eternal retry: every app start re-ran the teardown, refused the same edited
   * file again, incremented the count, and at five attempts raised a sticky
   * notice about a state that needed no attention.
   *
   * The rule now is that the cleanup obligation covers only bytes whose
   * ownership Vex can prove. A file the user edited is not provably Vex's, so
   * nothing is owed for it: the run is `done`, the kept file is named in the
   * per-artifact outcome list, and its provenance row - whose only purpose was
   * to prove ownership for a future rewrite of a project that no longer exists -
   * is released with it.
   */
  it("DISCHARGES the cleanup when a hand-edited block is all that is left", async () => {
    const project = await seedProject();
    const brief = briefFor(project.projectId);
    const merged = mergeStudioManagedBlock(USER_AGENTS_MD, brief, { overwriteDrift: false });
    if (merged.status !== "rendered") throw new Error("seed did not render");
    // A human edit INSIDE the fence. The body no longer hashes to the value in
    // its own marker, which is the whole drift contract.
    const drifted = merged.text.replace(
      "This repository is connected to Vex",
      "This repository is connected to Vex (edited by hand)",
    );
    expect(drifted).not.toBe(merged.text);
    await installProjectArtifacts(project, { agentsMdText: drifted });

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-drift",
        deps,
      ),
    );

    // The obligation is discharged, and the kept file is REPORTED, not hidden.
    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;
    expect(outcomeFor(result.cleanup, "AGENTS.md").status).toBe("drift_blocked");

    // NOT ONE BYTE of the drifted file changed.
    expect(await readFile(path.join(project.directory, "AGENTS.md"), "utf8")).toBe(drifted);
    // Everything Vex could prove it owned still went.
    expect(await exists(path.join(project.directory, ".vex/protocols.md"))).toBe(false);
    // The provenance row goes with the discharge: the project is gone, so there
    // is no future rewrite for it to prove ownership of.
    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
      cleanup_attempts: 0,
    });

    // And a second delete has nothing left to do, which is what "no retry loop"
    // means in the one place the user would feel it.
    const again = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-drift-2",
        deps,
      ),
    );
    expect(again.outcome).toBe("already_removed");
  });

  /**
   * THE COUNTERPART. A drift refusal discharges only when it is the WHOLE
   * remainder. Mixed with a transient failure - here a trash that would not
   * move - the obligation still stands, because the transient half still needs
   * doing, and the kept file's provenance is NOT released.
   */
  it("stays PENDING when a drift refusal is mixed with a transient failure", async () => {
    const project = await seedProject();
    const brief = briefFor(project.projectId);
    const merged = mergeStudioManagedBlock(USER_AGENTS_MD, brief, { overwriteDrift: false });
    if (merged.status !== "rendered") throw new Error("seed did not render");
    const drifted = merged.text.replace(
      "This repository is connected to Vex",
      "This repository is connected to Vex (edited by hand)",
    );
    await installProjectArtifacts(project, { agentsMdText: drifted });
    runtime.trashItem.mockRejectedValue(new Error("EPERM: operation not permitted"));

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: true, expectedName: PROJECT_NAME },
        "corr-drift-mixed",
        deps,
      ),
    );

    expect(result.outcome).toBe("cleanup_pending");
    if (result.outcome !== "cleanup_pending") return;
    expect(result.trash).toBe("failed");
    expect(outcomeFor(result.cleanup, "AGENTS.md").status).toBe("drift_blocked");
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "trash_pending",
      cleanup_attempts: 1,
    });
    // RETAINED, because the retry must still be able to report this artifact.
    expect(await provenanceKeys(project.projectId)).toEqual(["agents-md"]);
    expect(await readFile(path.join(project.directory, "AGENTS.md"), "utf8")).toBe(drifted);
  });

  /**
   * THE TOML DIALECT, which the JSON cases above cannot exercise: Codex's
   * `.codex/config.toml` is rewritten by SECTION-LEVEL TEXT REPLACEMENT, and the
   * property that matters is that every byte outside our one section - a foreign
   * server section, and the user's comments - survives the teardown verbatim.
   */
  it("removes only Vex's TOML section and leaves every other user byte", async () => {
    const project = await seedProject();
    const facts = { projectId: project.projectId, bridgeCommand: "/opt/vex/vex-mcp" };
    const seeded = mergeStudioAgentConfig(USER_CODEX_TOML, CODEX, facts);
    if (seeded.status !== "rendered") throw new Error("codex config seed did not render");
    const region = readStudioOwnedRegion(seeded.text, CODEX);
    if (region.kind !== "present") throw new Error("codex config seed has no Vex region");
    expect(seeded.text).toContain(studioTomlHeader(CODEX));

    await installArtifact(
      project.projectId,
      project.directory,
      "agent:codex",
      CODEX.configPath,
      seeded.text,
      region.hash,
    );

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-toml",
        deps,
      ),
    );

    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;
    expect(outcomeFor(result.cleanup, CODEX.configPath).status).toBe("removed");

    // THE BYTES, asserted whole. Not "the foreign key is still there" - the file
    // is exactly what the user had before Vex ever wrote into it.
    const after = await readFile(path.join(project.directory, CODEX.configPath), "utf8");
    expect(after).toBe(USER_CODEX_TOML);
    expect(after).not.toContain(studioTomlHeader(CODEX));
    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
    });
  });
});

describe("deleteProject: the trash step", () => {
  it("reports trash FAILURE without rolling back the authority commit", async () => {
    const project = await seedProject();
    await installProjectArtifacts(project);
    runtime.trashItem.mockRejectedValue(new Error("EPERM: operation not permitted"));

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: true, expectedName: PROJECT_NAME },
        "corr-trash-fail",
        deps,
      ),
    );

    expect(result.outcome).toBe("cleanup_pending");
    if (result.outcome !== "cleanup_pending") return;
    expect(result.trash).toBe("failed");
    // The failure must come from the TRASH CALL, not from a guard that ran
    // before it: an unasserted call count is how this test previously passed
    // while `shell` was undefined and nothing was ever attempted.
    expect(runtime.trashItem).toHaveBeenCalledTimes(1);
    expect(runtime.trashItem).toHaveBeenCalledWith(project.directory);
    // THE COMMIT STANDS. A folder that could not be moved is not a reason to
    // un-delete a project whose approvals were already refused.
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "trash_pending",
      cleanup_attempts: 1,
    });
    // The failure reason is a redacted sentence, never the provider message.
    const reason = await sql<{ cleanup_last_error: string | null }>(
      "SELECT cleanup_last_error FROM projects WHERE id = $1",
      [project.projectId],
    );
    expect(reason[0]?.cleanup_last_error).toBe(
      "The project folder could not be moved to the trash.",
    );
    expect(reason[0]?.cleanup_last_error).not.toMatch(/EPERM/);
    expect(await exists(project.directory)).toBe(true);
  });

  it("RESUMES an unfinished cleanup and honours the tombstone's trash intent", async () => {
    const project = await seedProject();
    await installProjectArtifacts(project);
    runtime.trashItem.mockRejectedValueOnce(new Error("EPERM"));

    const first = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: true, expectedName: PROJECT_NAME },
        "corr-resume-1",
        deps,
      ),
    );
    expect(first.outcome).toBe("cleanup_pending");

    // THE RETRY ASKS FOR NO TRASH. The durable decision was made at deletion
    // time and a retry's checkbox is not a second chance to change it.
    const second = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-resume-2",
        deps,
      ),
    );

    expect(second.outcome).toBe("cleanup_resumed");
    if (second.outcome !== "cleanup_resumed") return;
    expect(second.trash).toBe("trashed");
    expect(runtime.trashItem).toHaveBeenCalledTimes(2);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
    });

    // A third delete has nothing left to do, and says exactly that.
    const third = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-resume-3",
        deps,
      ),
    );
    expect(third.outcome).toBe("already_removed");
  });
});

describe("deleteProject: the drain", () => {
  it("BLOCKS on an in-flight call, reopens admission and writes nothing", async () => {
    const project = await seedProject();
    await installProjectArtifacts(project);

    const inFlight = acquireProjectLease(project.projectId, "executingCall");
    expect(inFlight.ok).toBe(true);

    try {
      const result = unwrap(
        await deleteProject(
          { projectId: project.projectId, alsoTrashFolder: true, expectedName: PROJECT_NAME },
          "corr-drain",
          deps,
        ),
      );

      expect(result).toEqual({ outcome: "blocked_active_calls", count: 1 });
      // NOTHING was written: no tombstone, no cleanup state, no artifact removed.
      expect(await readTombstone(project.projectId)).toMatchObject({
        deleted: false,
        cleanup_state: "none",
      });
      expect(await provenanceKeys(project.projectId)).toEqual([
        "agent:claude-code",
        "agents-md",
        "claude-md",
        "protocols-doc",
      ]);
      expect(await exists(path.join(project.directory, ".vex/protocols.md"))).toBe(true);
      expect(runtime.trashItem).not.toHaveBeenCalled();
      // And the project can be used again, which is what "abandoned" means.
      expect(isProjectAdmitting(project.projectId)).toBe(true);
    } finally {
      if (inFlight.ok) inFlight.lease.release();
    }
  }, 30_000);

  /**
   * THE DEADLOCK THE LEASE CLASSES EXIST TO PREVENT, DRIVEN THROUGH THE REAL
   * `runStudioCall`.
   *
   * This test used to hand-assemble the lease state: it called
   * `acquireProjectLease(projectId, "pendingApproval")` itself and asserted the
   * delete did not wait for it. That proved the GATE behaves as designed and
   * proved nothing about the system, because in production nothing ever took a
   * `pendingApproval` lease. `runStudioCall` acquired `executingCall` and held
   * it across the entire parked wait, so a real restricted call sitting on an
   * approval card was counted as bounded, drainable work: the drain waited its
   * full ten seconds, timed out, and the delete answered `blocked_active_calls`
   * for a call that could only finish when the delete refused it. The manufactured
   * lease was exactly what hid that.
   *
   * So the call below is REAL: production `runStudioCall`, production waiter
   * reservation, production enqueue transaction and project gate, a durable
   * `approval_intents` row, the production broker park. The only stub is the
   * executor chunk's verdict.
   *
   * `removed` is the deterministic discriminator. If the reclassification were
   * removed, the parked call would still hold `executingCall` and the only
   * reachable answer would be `blocked_active_calls` with a count of one.
   */
  it("does NOT wait on a REAL parked call, and its refusal releases the caller", async () => {
    const project = await seedProject();
    await seedProjectWallets(project.projectId);
    await installProjectArtifacts(project);
    markStudioRuntimeReady(beginStudioReadinessEpoch());
    stubPendingApprovalExecutor();
    const unsubscribe = subscribeReleaseBridge();

    try {
      // The call is STARTED, not awaited: it is going to block on a human.
      const call = runStudioCall(project.projectId, {
        name: "vex_SendTransaction",
        args: { to: "0x00000000000000000000000000000000000000ff" },
        toolCallId: `call-${randomUUID()}`,
      });

      // THE SYNCHRONIZATION POINT IS THE REGISTERED WAITER, not the lease.
      //
      // The reclassification happens the instant the tool result says
      // `pendingApproval`, which is BEFORE the enqueue transaction - deliberately,
      // so the deadlock window is closed rather than merely narrowed. So a
      // non-zero `pendingApproval` count does not yet mean a durable intent
      // exists. `studioWaiterCount() === 1` is the state that means all of it:
      // the intent committed, the broker registered, and the call is genuinely
      // waiting on a human.
      await until(
        "the call to register as a parked waiter",
        () => studioWaiterCount() === 1,
      );

      // Parked, and counted as PARKED rather than as executing. This is the
      // assertion the old test could not make, because nothing in production
      // ever moved the lease.
      expect(heldProjectLeases(project.projectId, "pendingApproval")).toBe(1);
      expect(heldProjectLeases(project.projectId, "executingCall")).toBe(0);

      // A real durable intent exists for it. Without this the delete would have
      // nothing to refuse and the release below would be an accident.
      const parkedRows = await sql<{ approval_id: string }>(
        `SELECT approval_id FROM approval_intents
          WHERE project_id = $1 AND origin = 'studio_mcp'`,
        [project.projectId],
      );
      expect(parkedRows).toHaveLength(1);
      const approvalId = parkedRows[0]?.approval_id ?? "";

      const result = unwrap(
        await deleteProject(
          { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
          "corr-parked",
          deps,
        ),
      );

      // The delete COMPLETED while a real call was parked on it.
      expect(result.outcome).toBe("removed");

      // The intent is durably refused, queue row included.
      const intent = await sql<{ decision: string | null; refusal_reason: string | null }>(
        "SELECT decision, refusal_reason FROM approval_intents WHERE approval_id = $1",
        [approvalId],
      );
      expect(intent[0]).toMatchObject({
        decision: "rejected",
        refusal_reason: "project_deleted",
      });
      const queue = await sql<{ status: string }>(
        "SELECT status FROM approval_queue WHERE id = $1",
        [approvalId],
      );
      expect(queue[0]?.status).not.toBe("pending");

      // AND THE CALLER WAS TOLD, by the refusal the delete itself committed.
      // This is the end of the loop the deadlock used to close: the call could
      // only finish because the delete finished.
      const outcome = await call;
      expect(outcome.kind).toBe("refused");

      // Nothing of this project's is left in the gate.
      expect(heldProjectLeases(project.projectId, "pendingApproval")).toBe(0);
      expect(heldProjectLeases(project.projectId, "executingCall")).toBe(0);
    } finally {
      unsubscribe();
    }
  }, 30_000);

  /**
   * THE REVERSE MOVE, with no delete anywhere near it.
   *
   * A call that parks and is then APPROVED has to stop being counted as parked:
   * `pendingApproval` is the class a delete deliberately refuses to wait for, so
   * a call that never moved back would be permanently invisible to a later
   * delete's drain - the same defect as the first, pointing the other way.
   *
   * The settlement is written to the durable row and announced exactly as the
   * approve path leaves it, and the assertion is on the BOOKKEEPING: the call
   * completes with the stored result, and the gate holds nothing afterwards.
   * A lease that failed to move back, or was released from the wrong class,
   * leaves a non-zero count here.
   */
  it("moves a settled call back out of pendingApproval and leaves the gate empty", async () => {
    const project = await seedProject();
    await seedProjectWallets(project.projectId);
    markStudioRuntimeReady(beginStudioReadinessEpoch());
    stubPendingApprovalExecutor();
    const unsubscribe = subscribeReleaseBridge();

    try {
      const call = runStudioCall(project.projectId, {
        name: "vex_SendTransaction",
        args: { to: "0x00000000000000000000000000000000000000ff" },
        toolCallId: `call-${randomUUID()}`,
      });
      await until(
        "the call to register as a parked waiter",
        () => studioWaiterCount() === 1,
      );
      expect(heldProjectLeases(project.projectId, "pendingApproval")).toBe(1);
      expect(heldProjectLeases(project.projectId, "executingCall")).toBe(0);

      const rows = await sql<{ approval_id: string }>(
        "SELECT approval_id FROM approval_intents WHERE project_id = $1",
        [project.projectId],
      );
      const approvalId = rows[0]?.approval_id ?? "";

      // The state a successful approved dispatch leaves: decided, terminal,
      // with the whole result stored through the production codec.
      const encoded = encodeStudioSettlement({ success: true, output: "0xdeadbeef" });
      await sql(
        `UPDATE approval_intents
            SET decision = 'approved', decided_at = NOW(),
                execution_status = 'succeeded',
                settlement = $2::jsonb, settlement_bytes = $3
          WHERE approval_id = $1`,
        [approvalId, encoded.json, encoded.bytes],
      );
      studioSettlementBus.emit({
        type: STUDIO_SETTLEMENT_EVENT_TYPE,
        approvalId,
        projectId: project.projectId,
        outcome: "settled",
        occurredAt: new Date().toISOString(),
      });

      const outcome = await call;
      expect(outcome.kind).toBe("completed");
      if (outcome.kind === "completed") {
        expect(outcome.result.output).toBe("0xdeadbeef");
      }

      // THE BOOKKEEPING. Both drained classes and the parked class are back to
      // zero, and admission was never closed, so the project is still usable.
      expect(heldProjectLeases(project.projectId, "pendingApproval")).toBe(0);
      expect(heldProjectLeases(project.projectId, "executingCall")).toBe(0);
      expect(heldProjectLeases(project.projectId, "dispatch")).toBe(0);
      expect(isProjectAdmitting(project.projectId)).toBe(true);
    } finally {
      unsubscribe();
    }
  }, 30_000);
});

/**
 * OWNERSHIP AT TEARDOWN: what a delete may and may not remove.
 *
 * Two independent defects lived here, and both deleted a user's own bytes.
 *
 *   1. THE TEARDOWN RAN WITH REPAIR AUTHORITY. `project-delete.ts` passed
 *      `repair: true`, which inside `decideAgentConfig` unlocks the
 *      provenance-proven TAKEOVER - the branch that replaces (here: REMOVES) a
 *      Vex entry whose bytes no longer match what provenance recorded, i.e. an
 *      entry a human edited. It fires BEFORE the drift and unknown-key checks,
 *      so deleting a project silently deleted a hand-edited Vex config entry.
 *      Repair means "the user asked Vex to overwrite their edit"; a delete is
 *      not that request.
 *   2. PROVENANCE DID NOT DISTINGUISH WRITTEN FROM ADOPTED. The reconciler
 *      adopts pre-existing bytes that are byte-for-byte what a fresh render
 *      produces, so a lost provenance commit is not refused as a collision
 *      forever. That adoption cannot tell "Vex wrote this and forgot" from "the
 *      user wrote exactly this before installing Vex" - and the teardown read
 *      every row as authorship proof, so it deleted the second kind.
 *
 * Every test below asserts on file CONTENTS, never existence: "the file is
 * still there" passes on a file whose entry we removed, which is the failure
 * mode that matters.
 */
describe("deleteProject: bytes Vex cannot prove it authored", () => {
  it("keeps a HAND-EDITED Vex JSON entry byte for byte, and discharges", async () => {
    const project = await seedProject();
    const facts = { projectId: project.projectId, bridgeCommand: "/opt/vex/vex-mcp" };
    const seeded = mergeStudioAgentConfig(FOREIGN_MCP_CONFIG, CLAUDE_CODE, facts);
    if (seeded.status !== "rendered") throw new Error("config seed did not render");
    const original = readStudioOwnedRegion(seeded.text, CLAUDE_CODE);
    if (original.kind !== "present") throw new Error("config seed has no Vex region");

    // THE HUMAN EDIT, inside Vex's own entry. Provenance keeps the digest of
    // what Vex WROTE, so the entry on disk no longer matches it - which is
    // exactly the state a hand edit leaves and the state Repair may take over.
    const edited = seeded.text.replace(
      "/opt/vex/vex-mcp",
      "/home/me/my-own-vex-wrapper",
    );
    expect(edited).not.toBe(seeded.text);
    await installArtifact(
      project.projectId,
      project.directory,
      "agent:claude-code",
      CLAUDE_CODE.configPath,
      edited,
      original.hash,
    );

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-edited-json",
        deps,
      ),
    );

    // AN OWNERSHIP REFUSAL, and the cleanup is DONE: a permanent, correct
    // answer must not become an eternal retry.
    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;
    const outcome = outcomeFor(result.cleanup, CLAUDE_CODE.configPath);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reason).toBe("provenance_collision");
    }
    // NOT ONE BYTE CHANGED.
    expect(
      await readFile(path.join(project.directory, CLAUDE_CODE.configPath), "utf8"),
    ).toBe(edited);
    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
      cleanup_attempts: 0,
    });
  });

  it("keeps a HAND-EDITED Vex TOML section byte for byte, and discharges", async () => {
    const project = await seedProject();
    const facts = { projectId: project.projectId, bridgeCommand: "/opt/vex/vex-mcp" };
    const seeded = mergeStudioAgentConfig(USER_CODEX_TOML, CODEX, facts);
    if (seeded.status !== "rendered") throw new Error("codex config seed did not render");
    const original = readStudioOwnedRegion(seeded.text, CODEX);
    if (original.kind !== "present") throw new Error("codex config seed has no Vex region");

    const edited = seeded.text.replace(
      "/opt/vex/vex-mcp",
      "/home/me/my-own-vex-wrapper",
    );
    expect(edited).not.toBe(seeded.text);
    await installArtifact(
      project.projectId,
      project.directory,
      "agent:codex",
      CODEX.configPath,
      edited,
      original.hash,
    );

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-edited-toml",
        deps,
      ),
    );

    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;
    const outcome = outcomeFor(result.cleanup, CODEX.configPath);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reason).toBe("provenance_collision");
    }
    expect(await readFile(path.join(project.directory, CODEX.configPath), "utf8")).toBe(
      edited,
    );
    // The user's own comments and the foreign server section are still there,
    // which is the property a section-level text rewrite has to preserve.
    expect(await readFile(path.join(project.directory, CODEX.configPath), "utf8")).toContain(
      "[mcp_servers.house-tools]",
    );
    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
    });
  });

  it("keeps UNKNOWN FIELDS a user added inside Vex's own JSON entry", async () => {
    const project = await seedProject();
    const facts = { projectId: project.projectId, bridgeCommand: "/opt/vex/vex-mcp" };
    const seeded = mergeStudioAgentConfig(FOREIGN_MCP_CONFIG, CLAUDE_CODE, facts);
    if (seeded.status !== "rendered") throw new Error("config seed did not render");

    // A field Vex never writes, added INSIDE Vex's entry. The recorded digest is
    // computed from THIS text, so the entry is provably Vex's and undrifted -
    // which is what makes the unknown-key check the reachable answer rather
    // than a collision. Under `repair: true` the takeover fired first and these
    // fields were deleted with the entry.
    const parsed = JSON.parse(seeded.text) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const vexEntry = parsed.mcpServers["vex"];
    if (vexEntry === undefined) throw new Error("seed has no vex entry");
    vexEntry["myTimeoutSeconds"] = 90;
    const withUnknownKey = `${JSON.stringify(parsed, null, 2)}\n`;
    const region = readStudioOwnedRegion(withUnknownKey, CLAUDE_CODE);
    if (region.kind !== "present") throw new Error("seed has no Vex region");
    expect(region.unknownKeys).toContain("myTimeoutSeconds");

    await installArtifact(
      project.projectId,
      project.directory,
      "agent:claude-code",
      CLAUDE_CODE.configPath,
      withUnknownKey,
      region.hash,
    );

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-unknown-keys",
        deps,
      ),
    );

    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;
    const outcome = outcomeFor(result.cleanup, CLAUDE_CODE.configPath);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reason).toBe("unknown_keys_in_vex_entry");
      // NAMED, not silently deleted.
      expect(outcome.detail).toContain("myTimeoutSeconds");
    }
    expect(
      await readFile(path.join(project.directory, CLAUDE_CODE.configPath), "utf8"),
    ).toBe(withUnknownKey);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
    });
  });

  it("releases the provenance of a removal whose artifact is ALREADY absent", async () => {
    const project = await seedProject();
    await installProjectArtifacts(project);
    // The user deleted the generated file themselves between the install and
    // the delete. There is nothing left to remove, so the obligation for that
    // artifact is SATISFIED - and its provenance row, whose only purpose was to
    // prove ownership of bytes that no longer exist, has to go with it. It used
    // to be left behind: the artifact reported `unchanged`, the cleanup was
    // marked done, and the row outlived every reader of it.
    await rm(path.join(project.directory, ".vex/protocols.md"));

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-already-absent",
        deps,
      ),
    );

    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;
    expect(outcomeFor(result.cleanup, ".vex/protocols.md").status).toBe("unchanged");
    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
    });
  });

  /**
   * THE ADOPTION CASE, which is the one no amount of drift checking catches.
   *
   * The user wrote a `vex` MCP entry and an `@AGENTS.md` import BEFORE they ever
   * installed Vex, and they wrote them exactly as Vex would. Vex's first install
   * therefore changed nothing on disk and ADOPTED those bytes - the reconciler's
   * finalize-what-the-disk-proves branch, which exists so a write whose
   * provenance commit was lost is not refused as a collision forever. Its
   * record is `origin: "adopted"`.
   *
   * Every check the teardown had would pass here: the bytes are undrifted, the
   * digests match, there are no unknown keys, and provenance holds a row. The
   * only thing standing between the user's own content and deletion is that the
   * row says Vex ADOPTED rather than WROTE it.
   *
   * The seeded state is exactly what the reconciler's adopt branch produces -
   * `installer-reconcile.test.ts` drives the real reconciler over pre-existing
   * identical bytes and asserts it records `adopted`. Seeded here rather than
   * rendered because a full `renderProjectFiles` needs the packaged bridge
   * binary, which is not the subject.
   */
  it("KEEPS entries Vex only adopted, and still removes the ones it wrote", async () => {
    const project = await seedProject();
    const facts = { projectId: project.projectId, bridgeCommand: "/opt/vex/vex-mcp" };

    // The user's own `vex` entry: identical to a fresh render, authored by them.
    const config = mergeStudioAgentConfig(FOREIGN_MCP_CONFIG, CLAUDE_CODE, facts);
    if (config.status !== "rendered") throw new Error("config seed did not render");
    const region = readStudioOwnedRegion(config.text, CLAUDE_CODE);
    if (region.kind !== "present") throw new Error("config seed has no Vex region");
    await installArtifact(
      project.projectId,
      project.directory,
      "agent:claude-code",
      CLAUDE_CODE.configPath,
      config.text,
      region.hash,
      "adopted",
    );

    // The user's own `@AGENTS.md` import line, likewise pre-existing.
    const claudeMd = mergeClaudeMdImport(USER_CLAUDE_MD);
    if (claudeMd.status !== "rendered") throw new Error("CLAUDE.md seed did not render");
    await installArtifact(
      project.projectId,
      project.directory,
      "claude-md",
      "CLAUDE.md",
      claudeMd.text,
      null,
      "adopted",
    );

    // And one artifact Vex genuinely wrote, as the control: the discharge must
    // not be "the teardown gave up", it must be "it removed what it owned".
    await installArtifact(
      project.projectId,
      project.directory,
      "protocols-doc",
      ".vex/protocols.md",
      renderStudioProtocolsDoc(),
      null,
    );

    const result = unwrap(
      await deleteProject(
        { projectId: project.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
        "corr-adopted",
        deps,
      ),
    );

    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;

    // THE USER'S BYTES SURVIVE, verbatim, both of them.
    expect(
      await readFile(path.join(project.directory, CLAUDE_CODE.configPath), "utf8"),
    ).toBe(config.text);
    expect(await readFile(path.join(project.directory, "CLAUDE.md"), "utf8")).toBe(
      claudeMd.text,
    );
    // Reported as an ownership refusal, never silently.
    for (const artifactPath of [CLAUDE_CODE.configPath, "CLAUDE.md"]) {
      const outcome = outcomeFor(result.cleanup, artifactPath);
      expect(outcome.status, artifactPath).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.reason).toBe("provenance_collision");
      }
    }

    // THE CONTROL: what Vex actually wrote is gone.
    expect(await exists(path.join(project.directory, ".vex/protocols.md"))).toBe(false);
    expect(outcomeFor(result.cleanup, ".vex/protocols.md").status).toBe("removed");

    // And the obligation is DISCHARGED, not retried forever.
    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
      cleanup_attempts: 0,
    });
  });
});

describe("deleteProject: the startup repair sweep", () => {
  it("finishes a cleanup a previous run left pending, and is a no-op after", async () => {
    const project = await seedProject();
    await installProjectArtifacts(project);
    // The state a crashed run leaves: the tombstone committed, the files still
    // on disk, the obligation recorded.
    await tombstoneWithPendingCleanup(project.projectId, "pending");

    await repairUnfinishedProjectCleanups(deps);

    expect(await exists(path.join(project.directory, ".vex/protocols.md"))).toBe(false);
    expect(await readFile(path.join(project.directory, "AGENTS.md"), "utf8")).toBe(
      USER_AGENTS_MD,
    );
    expect(await provenanceKeys(project.projectId)).toEqual([]);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
      cleanup_attempts: 0,
    });

    // THE SECOND SWEEP DOES NOTHING. A `done` row is not in the unfinished list,
    // so a repeat start cannot re-run a teardown over a user's restored files.
    await repairUnfinishedProjectCleanups(deps);
    expect(await readTombstone(project.projectId)).toMatchObject({
      deleted: true,
      cleanup_state: "done",
      cleanup_attempts: 0,
    });
  }, 30_000);

  it("attempts at most three tombstones per sweep and leaves the rest", async () => {
    // FOUR failing cleanups. The sweep is bounded so a pathological state cannot
    // turn every launch into a retry storm; the fourth waits for the next start.
    runtime.trashItem.mockRejectedValue(new Error("EPERM: operation not permitted"));
    const projects: SeededProject[] = [];
    for (let index = 0; index < 4; index += 1) {
      const project = await seedProject();
      await installProjectArtifacts(project);
      // Explicit, ordered timestamps: the sweep reads oldest first, and without
      // them four rows written in the same millisecond have no defined order.
      await tombstoneWithPendingCleanup(
        project.projectId,
        "trash_pending",
        `2026-08-0${String(index + 1)}T00:00:00Z`,
      );
      projects.push(project);
    }

    await repairUnfinishedProjectCleanups(deps);

    const attempts = await Promise.all(
      projects.map(async (project) => (await readTombstone(project.projectId)).cleanup_attempts),
    );
    expect(attempts).toEqual([1, 1, 1, 0]);
    expect(runtime.trashItem).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("reaches the sticky-attempt threshold on the row itself", async () => {
    // The sticky notice is a DURABLE fact on the row - state, attempts, last
    // error - so the surface that renders it reads the row rather than relying
    // on an event it might have missed. One more failure from the threshold.
    runtime.trashItem.mockRejectedValue(new Error("EPERM: operation not permitted"));
    const project = await seedProject();
    await installProjectArtifacts(project);
    await tombstoneWithPendingCleanup(project.projectId, "trash_pending");
    await sql("UPDATE projects SET cleanup_attempts = $2 WHERE id = $1", [
      project.projectId,
      PROJECT_CLEANUP_STICKY_ATTEMPTS - 1,
    ]);

    await repairUnfinishedProjectCleanups(deps);

    const row = await readTombstone(project.projectId);
    expect(row.cleanup_attempts).toBe(PROJECT_CLEANUP_STICKY_ATTEMPTS);
    expect(row.cleanup_state).toBe("trash_pending");
    const reason = await sql<{ cleanup_last_error: string | null }>(
      "SELECT cleanup_last_error FROM projects WHERE id = $1",
      [project.projectId],
    );
    expect(reason[0]?.cleanup_last_error).toBe(
      "The project folder could not be moved to the trash.",
    );
    expect(reason[0]?.cleanup_last_error).not.toMatch(/EPERM/);
  }, 30_000);
});

/**
 * STEP 6: WHAT THE PROJECT OWNS IS CLOSED ONLY AFTER THE TOMBSTONE COMMITS.
 *
 * This is an ORDERING contract, and ordering is the one thing a unit test of
 * either half cannot establish. `terminal-domain.test.ts` already proves the
 * close hook kills the right project's terminals; `project-lifecycle-gate`'s own
 * suite proves the hook registry runs its hooks. Both stay green if step 6 moves
 * ABOVE the transaction - and if it did, a terminal would be killed for a delete
 * that then hit a constraint and rolled back, leaving the user with a live
 * project whose shells Vex had already ended. Nothing in the tree would notice.
 *
 * So the observation is made from INSIDE the hook, against the real database: a
 * `deleted_at` read on a fresh pooled connection at the instant the hook fires
 * is committed state or it is nothing. A hook that ran before COMMIT would read
 * `null` - the transaction's own writes are invisible to another connection -
 * and a hook that ran before the transaction started would read `null` too. Both
 * failures collapse onto the same assertion.
 *
 * The resource the hook closes is a REAL `terminal` lease taken from the real
 * gate, which is exactly what `terminals.ts` holds per open terminal. The
 * `TerminalDomain` itself is deliberately not constructed here: its module graph
 * reaches `pty-host-starter.ts`, whose value import of `electron` this lane's
 * header (and its whole design) exists to keep out. What is under test is the
 * ORDER the gate imposes on its hooks, and that order is identical for every
 * hook the registry holds.
 *
 * Two facts are also worth having and cost nothing: the artifact still exists
 * when the hook runs (so close precedes cleanup, step 6 before step 7), and a
 * SECOND project's terminal lease is untouched (so the close is scoped to the
 * project being deleted, not to every terminal in the process).
 */
describe("deleteProject: step 6, closing what the project owns", () => {
  it("closes a live terminal only AFTER the tombstone transaction has committed", async () => {
    const doomed = await seedProject();
    await installProjectArtifacts(doomed);
    const bystander = await seedProject();

    // What `terminals.ts` holds per open terminal, taken from the real gate.
    const doomedTerminal = acquireProjectLease(doomed.projectId, "terminal");
    const bystanderTerminal = acquireProjectLease(bystander.projectId, "terminal");
    expect(doomedTerminal.ok).toBe(true);
    expect(bystanderTerminal.ok).toBe(true);
    expect(heldProjectLeases(doomed.projectId, "terminal")).toBe(1);

    // OBSERVATIONS, not assertions: the gate swallows a throw from a hook, so an
    // `expect` in here would be eaten and the delete would report success.
    let hookCalls = 0;
    const seen: {
      deletedAt: Date | null | undefined;
      artifactStillThere: boolean | undefined;
      bystanderLeases: number | undefined;
    } = {
      deletedAt: undefined,
      artifactStillThere: undefined,
      bystanderLeases: undefined,
    };

    const unregister = registerProjectCloseHook(async (projectId) => {
      if (projectId !== doomed.projectId) return;
      hookCalls += 1;
      const rows = await sql<{ deleted_at: Date | null }>(
        "SELECT deleted_at FROM projects WHERE id = $1",
        [doomed.projectId],
      );
      seen.deletedAt = rows[0]?.deleted_at ?? null;
      seen.artifactStillThere = await exists(
        path.join(doomed.directory, ".vex/protocols.md"),
      );
      seen.bystanderLeases = heldProjectLeases(bystander.projectId, "terminal");
      // The terminal closes here, which is what releases its lease.
      if (doomedTerminal.ok) doomedTerminal.lease.release();
    });

    try {
      const result = unwrap(
        await deleteProject(
          { projectId: doomed.projectId, alsoTrashFolder: false, expectedName: PROJECT_NAME },
          "corr-close-order",
          deps,
        ),
      );
      expect(result.outcome).toBe("removed");
    } finally {
      unregister();
      if (bystanderTerminal.ok) bystanderTerminal.lease.release();
    }

    // The hook ran, once, for this project.
    expect(hookCalls).toBe(1);
    // THE ORDERING CLAIM. A separate connection can only see this value because
    // the transaction that wrote it had already COMMITTED when the hook ran.
    expect(seen.deletedAt).toBeInstanceOf(Date);
    // Step 6 before step 7: nothing had been torn down yet.
    expect(seen.artifactStillThere).toBe(true);
    // Scoped to the project being deleted.
    expect(seen.bystanderLeases).toBe(1);

    // And the terminal really is gone afterwards.
    expect(heldProjectLeases(doomed.projectId, "terminal")).toBe(0);
    expect(await readTombstone(doomed.projectId)).toMatchObject({ deleted: true });
  }, 30_000);
});
