/**
 * `updateProjectScope` and the project reads.
 *
 * Scripted fake `pg.Client`, same convention as `sessions-wallet-scope.test.ts`.
 *
 * The three properties that matter here:
 *
 *   1. OPTIMISTIC CONCURRENCY. The guarded `UPDATE ... AND scope_version = $2`
 *      is the serialization point. Two concurrent edits both holding version N
 *      cannot both win: the second matches zero rows, is refused by name with
 *      `projects.scope_conflict`, and writes nothing.
 *   2. THE STUDIO-ONLY MIRROR. The backing session is updated by a direct
 *      `UPDATE sessions ... AND scope = 'vex_studio'`, never through
 *      `initializeSessionWalletScope` - whose initialize-if-empty CAS is
 *      hard-coded to `vex_app` and refuses a session with messages. A project's
 *      scope stays editable after its backing session has carried turns, and
 *      the agent-session CAS is left untouched.
 *   3. WALLET DRIFT FAILS CLOSED on read: a stored selection whose address no
 *      longer matches the inventory entry is refused rather than handed back.
 *   4a. THE GLOBAL LOCK ORDER (stage A3). The backing session id is read
 *      OUTSIDE the transaction (it is write-once), the session control lock is
 *      taken FIRST inside it, the project's pending Studio approvals are
 *      refused NEXT, and only then is the `projects` row locked and bumped.
 *      That is the same order every A3 transaction takes, which is what makes
 *      an approve racing a scope edit unable to deadlock; and the refusal is
 *      inside THIS transaction because an approval granted under the version
 *      being replaced must not survive the bump.
 *   4. NOTHING COMMITS UNTIL THE EDIT IS WHOLE. The backing-session mirror must
 *      match exactly one row and the edited project must project cleanly
 *      through `buildProjectDtos`. Either failure rolls back, so a refusal the
 *      caller sees can never sit on top of a committed write.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectUpdateScopeInput } from "@shared/schemas/projects.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}) as { projectsRoot?: string }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getWalletById: vi.fn(),
  client: null as unknown as { query: ReturnType<typeof vi.fn> },
}));

vi.mock("@config/store.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("@vex-lib/wallet.js", () => ({ getWalletById: mocks.getWalletById }));
vi.mock("../sessions/connection.js", async () => {
  const actual = await vi.importActual<typeof import("../sessions/connection.js")>(
    "../sessions/connection.js",
  );
  return {
    ...actual,
    withClient: async (fn: (c: Client) => Promise<unknown>) =>
      fn(mocks.client as unknown as Client),
  };
});

const { updateProjectScope } = await import("../projects/scope.js");
const { getProject, listProjects } = await import("../projects/read.js");

const CORR = "corr-scope";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const EVM = { id: "evm_1", address: "0xEvmAddr" };

let root: string;

interface ScriptedResult {
  rows?: unknown[];
  rowCount?: number;
}

function scriptClient(responder: (sql: string) => ScriptedResult | Error) {
  const query = vi.fn(async (sql: unknown) => {
    const outcome = responder(String(sql));
    if (outcome instanceof Error) throw outcome;
    return {
      rows: outcome.rows ?? [],
      rowCount: outcome.rowCount ?? (outcome.rows?.length ?? 0),
    };
  });
  mocks.client = { query };
  return query;
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    name: "My App",
    slug: "my-app",
    root_path: "my-app",
    permission: "full",
    backing_session_id: SESSION_ID,
    agents: ["claude-code"],
    scope_version: 2,
    generator_version: null,
    created_at: new Date("2026-08-23T10:00:00.000Z"),
    updated_at: new Date("2026-08-23T11:00:00.000Z"),
    ...overrides,
  };
}

function walletRows(
  evm: { wallet_id: string | null; address: string | null } = {
    wallet_id: null,
    address: null,
  },
) {
  return [
    { project_id: PROJECT_ID, family: "evm", ...evm },
    { project_id: PROJECT_ID, family: "solana", wallet_id: null, address: null },
  ];
}

function callsMatching(query: ReturnType<typeof vi.fn>, fragment: string) {
  return query.mock.calls.filter((c) => String(c[0]).includes(fragment));
}

const BASE_INPUT: ProjectUpdateScopeInput = {
  projectId: PROJECT_ID,
  expectedScopeVersion: 1,
  permission: "full",
};

beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-projects-scope-")));
  mocks.loadConfig.mockReturnValue({ projectsRoot: root });
  mocks.getWalletById.mockReturnValue(null);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("updateProjectScope - optimistic concurrency", () => {
  it("bumps scope_version and mirrors permission into the vex_studio session", async () => {
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) return { rows: walletRows() };
      return { rows: [] };
    });

    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.scopeVersion).toBe(2);

    const update = callsMatching(query, "UPDATE projects")[0];
    expect(String(update?.[0])).toContain("scope_version = scope_version + 1");
    expect(String(update?.[0])).toContain("scope_version = $2");
    expect((update?.[1] as unknown[])[1]).toBe(1);

    // The mirror is a direct, scope-filtered UPDATE on the backing session.
    const mirror = callsMatching(query, "UPDATE sessions")[0];
    expect(String(mirror?.[0])).toContain("scope = $3");
    expect((mirror?.[1] as unknown[])[0]).toBe(SESSION_ID);
    expect((mirror?.[1] as unknown[])[2]).toBe("vex_studio");
    expect(callsMatching(query, "COMMIT")).toHaveLength(1);
  });

  it("refuses a stale expected version with projects.scope_conflict and writes nothing", async () => {
    // The second of two concurrent edits: the guarded UPDATE matches zero rows
    // because the first edit already moved the project to version 2.
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [] };
      if (sql.includes("SELECT scope_version")) return { rows: [{ scope_version: 2 }] };
      return { rows: [] };
    });

    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.scope_conflict");
    expect(outcome.error.retryable).toBe(false);
    // The refusal names both versions: a conflict that does not say what moved
    // is not actionable.
    expect(outcome.error.message).toContain("1");
    expect(outcome.error.message).toContain("2");
    // Nothing was mirrored and nothing committed.
    expect(callsMatching(query, "UPDATE sessions")).toHaveLength(0);
    expect(callsMatching(query, "INSERT INTO project_wallets")).toHaveLength(0);
    expect(callsMatching(query, "COMMIT")).toHaveLength(0);
    expect(callsMatching(query, "ROLLBACK")).toHaveLength(1);
  });

  it("distinguishes a missing project from a lost race", async () => {
    scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [] };
      if (sql.includes("SELECT scope_version")) return { rows: [] };
      return { rows: [] };
    });
    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.not_found");
  });

  it("serializes two concurrent edits: the first wins, the second conflicts", async () => {
    // One shared version counter drives both calls, so the ordering is the
    // database's, not the test's assertion order.
    let version = 1;
    scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) {
        // The guarded UPDATE only matches while the expected version is current.
        if (version === 1) {
          version = 2;
          return { rows: [projectRow({ scope_version: 2 })] };
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT scope_version")) return { rows: [{ scope_version: version }] };
      if (sql.includes("FROM project_wallets")) return { rows: walletRows() };
      return { rows: [] };
    });

    const first = await updateProjectScope(BASE_INPUT, null, CORR);
    const second = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (first.ok) expect(first.data.scopeVersion).toBe(2);
    if (!second.ok) expect(second.error.code).toBe("projects.scope_conflict");
  });
});

describe("updateProjectScope - wallet mirror", () => {
  it("upserts project_wallets and mirrors the wallet columns when the selection changes", async () => {
    mocks.getWalletById.mockReturnValue(EVM);
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) {
        return { rows: walletRows({ wallet_id: EVM.id, address: EVM.address }) };
      }
      return { rows: [] };
    });

    const outcome = await updateProjectScope(
      { ...BASE_INPUT, wallets: { evm: EVM.id, solana: null } },
      { evm: EVM, solana: null },
      CORR,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.wallets.evm).toEqual(EVM);
    expect(outcome.data.wallets.solana).toBeNull();

    const upserts = callsMatching(query, "INSERT INTO project_wallets");
    expect(upserts).toHaveLength(2);
    expect(String(upserts[0]?.[0])).toContain("ON CONFLICT (project_id, family)");

    const mirror = callsMatching(query, "UPDATE sessions")[0];
    const params = mirror?.[1] as unknown[];
    expect(String(mirror?.[0])).toContain("selected_evm_wallet_address");
    expect(params[2]).toBe(EVM.id);
    expect(params[3]).toBe(EVM.address);
    expect(params[6]).toBe("vex_studio");
  });

  it("leaves the wallet columns alone when only the permission changes", async () => {
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) return { rows: walletRows() };
      return { rows: [] };
    });
    await updateProjectScope(BASE_INPUT, null, CORR);
    expect(callsMatching(query, "INSERT INTO project_wallets")).toHaveLength(0);
    const mirror = callsMatching(query, "UPDATE sessions")[0];
    expect(String(mirror?.[0])).not.toContain("selected_evm_wallet_id");
  });

  it("succeeds regardless of the backing session's message_count, and never calls the agent-session CAS", async () => {
    // The scope module's SQL must carry no `message_count = 0` guard and no
    // `selected_evm_wallet_id IS NULL` guard - those belong to the immutable
    // agent-session CAS in `sessions/wallet-scope.ts`, which stage P does not
    // touch. A project scope edit must work after the session has carried turns.
    const raw = await (
      await import("node:fs/promises")
    ).readFile(path.resolve(__dirname, "..", "projects", "scope.ts"), "utf8");
    // Strip comments: the module's docblock names the CAS in order to explain
    // why it is NOT used, so the assertion must look at code alone.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("message_count");
    expect(code).not.toContain("initializeSessionWalletScope");
    expect(code).not.toContain("vex_app");

    mocks.getWalletById.mockReturnValue(EVM);
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) {
        return { rows: walletRows({ wallet_id: EVM.id, address: EVM.address }) };
      }
      return { rows: [] };
    });
    const outcome = await updateProjectScope(
      { ...BASE_INPUT, wallets: { evm: EVM.id, solana: null } },
      { evm: EVM, solana: null },
      CORR,
    );
    expect(outcome.ok).toBe(true);
    // The mirror overwrites a previously-set family, which the CAS would refuse.
    expect(callsMatching(query, "UPDATE sessions")).toHaveLength(1);
  });
});

describe("updateProjectScope - commit gate", () => {
  it("rolls back instead of committing when the backing-session mirror matches no row", async () => {
    // The project row updated fine, but its backing session is gone or is no
    // longer a `vex_studio` session. Committing here would leave the project
    // claiming a permission and a wallet scope that no session-keyed gate has.
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 0 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) return { rows: walletRows() };
      return { rows: [] };
    });

    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.backing_session_integrity");
    expect(outcome.error.domain).toBe("projects");
    // Not retryable, and the message says the project is unchanged and why a
    // retry will not help.
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.error.message).toMatch(/NOT changed/);
    expect(outcome.error.message).toMatch(/repair/i);

    // The mirror was attempted and then undone. Nothing committed.
    expect(callsMatching(query, "UPDATE sessions")).toHaveLength(1);
    expect(callsMatching(query, "COMMIT")).toHaveLength(0);
    expect(callsMatching(query, "ROLLBACK")).toHaveLength(1);
    // ROLLBACK comes AFTER the mirror: the guarded project UPDATE and the
    // mirror both sit inside the transaction that is being undone.
    const statements = query.mock.calls.map((c) => String(c[0]));
    expect(statements.findIndex((sql) => sql.includes("ROLLBACK"))).toBeGreaterThan(
      statements.findIndex((sql) => sql.includes("UPDATE sessions")),
    );
  });

  it("rolls back when the mirror matches more than one row", async () => {
    // Impossible against the shipped schema (`backing_session_id` is UNIQUE and
    // `sessions.id` is the primary key), which is exactly why a count above one
    // must fail rather than be assumed away.
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 2 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) return { rows: walletRows() };
      return { rows: [] };
    });

    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.backing_session_integrity");
    expect(callsMatching(query, "COMMIT")).toHaveLength(0);
    expect(callsMatching(query, "ROLLBACK")).toHaveLength(1);
  });

  it("rolls back a permission-only edit whose stored wallet selection has drifted", async () => {
    // The edit itself is valid, but the project's stored EVM selection no longer
    // resolves to the same address. `buildProjectDtos` refuses to project it,
    // and that refusal must undo the edit: reporting `wallet_drift` while the
    // permission change stood would be a refusal the database disagrees with.
    mocks.getWalletById.mockReturnValue({ id: EVM.id, address: "0xDifferentKey" });
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) {
        return { rows: walletRows({ wallet_id: EVM.id, address: EVM.address }) };
      }
      return { rows: [] };
    });

    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.wallet_drift");

    expect(callsMatching(query, "COMMIT")).toHaveLength(0);
    expect(callsMatching(query, "ROLLBACK")).toHaveLength(1);
    // The mirror statement was issued and then rolled back, never committed.
    const statements = query.mock.calls.map((c) => String(c[0]));
    const mirrorAt = statements.findIndex((sql) => sql.includes("UPDATE sessions"));
    const rollbackAt = statements.findIndex((sql) => sql.includes("ROLLBACK"));
    expect(mirrorAt).toBeGreaterThanOrEqual(0);
    expect(rollbackAt).toBeGreaterThan(mirrorAt);
    expect(statements.some((sql) => sql.includes("COMMIT"))).toBe(false);
  });

  it("projects BEFORE it commits, so a successful edit never commits an unprojectable project", async () => {
    mocks.getWalletById.mockReturnValue(EVM);
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) {
        return { rows: walletRows({ wallet_id: EVM.id, address: EVM.address }) };
      }
      return { rows: [] };
    });

    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(true);
    // The wallet read that feeds the projection happens inside the transaction,
    // ahead of COMMIT.
    const statements = query.mock.calls.map((c) => String(c[0]));
    const walletReadAt = statements.findIndex((sql) =>
      sql.includes("FROM project_wallets WHERE project_id"),
    );
    const commitAt = statements.findIndex((sql) => sql.includes("COMMIT"));
    expect(walletReadAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(walletReadAt);
    // COMMIT is the last statement: nothing is decided after it.
    expect(commitAt).toBe(statements.length - 1);
  });
});

describe("project reads", () => {
  it("returns the project joined with its authoritative project_wallets rows", async () => {
    mocks.getWalletById.mockReturnValue(EVM);
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("FROM projects WHERE id")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) {
        return { rows: walletRows({ wallet_id: EVM.id, address: EVM.address }) };
      }
      return { rows: [] };
    });

    const outcome = await getProject(PROJECT_ID, CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data?.wallets.evm).toEqual(EVM);
    // The read never consults the backing session's mirrored columns.
    expect(callsMatching(query, "FROM sessions")).toHaveLength(0);
    // `displayPath` is label text, and `rootPath` stays root-relative: no
    // absolute path crosses the boundary as a capability.
    expect(outcome.data?.rootPath).toBe("my-app");
  });

  it("returns null for an unknown id rather than an error", async () => {
    scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      return { rows: [] };
    });
    const outcome = await getProject(PROJECT_ID, CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toBeNull();
  });

  it("fails closed with projects.wallet_drift when a stored address no longer matches its id", async () => {
    // The wallet id still resolves, but to a DIFFERENT key - a force re-import.
    // Handing this selection back would let a later signing path treat a key the
    // user never chose as their choice.
    mocks.getWalletById.mockReturnValue({ id: EVM.id, address: "0xDifferentKey" });
    scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("FROM projects WHERE id")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) {
        return { rows: walletRows({ wallet_id: EVM.id, address: EVM.address }) };
      }
      return { rows: [] };
    });

    const outcome = await getProject(PROJECT_ID, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.wallet_drift");
    expect(outcome.error.message).toMatch(/EVM/);
    expect(outcome.error.message).toMatch(/select the wallet again/i);
  });

  it("fails closed the same way when the wallet id vanished from the inventory", async () => {
    mocks.getWalletById.mockReturnValue(null);
    scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("FROM projects WHERE id")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) {
        return { rows: walletRows({ wallet_id: EVM.id, address: EVM.address }) };
      }
      return { rows: [] };
    });
    const outcome = await getProject(PROJECT_ID, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.wallet_drift");
  });

  it("rejects every read once the configured root no longer matches the recorded one", async () => {
    scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) {
        return { rows: [{ projects_root: path.join(root, "elsewhere") }] };
      }
      if (sql.includes("FROM projects")) return { rows: [projectRow()] };
      return { rows: [] };
    });
    const got = await getProject(PROJECT_ID, CORR);
    const listed = await listProjects(CORR);
    expect(got.ok).toBe(false);
    expect(listed.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe("projects.root_changed");
    if (!listed.ok) expect(listed.error.code).toBe("projects.root_changed");
  });

  it("lists projects newest first and skips the wallet query when there are none", async () => {
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      return { rows: [] };
    });
    const outcome = await listProjects(CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual([]);
    expect(String(callsMatching(query, "FROM projects")[0]?.[0])).toContain(
      "ORDER BY created_at DESC",
    );
    expect(callsMatching(query, "FROM project_wallets")).toHaveLength(0);
  });
});

describe("updateProjectScope - the global lock order and the Studio refusal", () => {
  /**
   * Script every statement the re-sequenced transaction issues, including the
   * ones the older tests let fall through to an empty result.
   */
  function scriptOrderedClient(pendingStudioIds: readonly string[] = []) {
    return scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("SELECT backing_session_id FROM projects")) {
        return { rows: [{ backing_session_id: SESSION_ID }] };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM approval_intents")) {
        return {
          rows: pendingStudioIds.map((id) => ({
            approval_id: id,
            project_id: PROJECT_ID,
          })),
        };
      }
      if (sql.includes("UPDATE approval_queue")) return { rows: [{ id: "q" }] };
      if (sql.includes("UPDATE approval_intents")) return { rows: [{ approval_id: "i" }], rowCount: 1 };
      if (sql.includes("UPDATE sessions")) return { rowCount: 1 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) return { rows: walletRows() };
      return { rows: [] };
    });
  }

  it("reads the backing session before BEGIN and takes the session control lock first", async () => {
    const query = scriptOrderedClient();
    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(true);

    const statements = query.mock.calls.map((c) => String(c[0]));
    const backingAt = statements.findIndex((s) =>
      s.includes("SELECT backing_session_id FROM projects"),
    );
    const beginAt = statements.findIndex((s) => s.includes("BEGIN"));
    const lockAt = statements.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const refuseAt = statements.findIndex((s) => s.includes("FROM approval_intents"));
    const updateAt = statements.findIndex((s) => s.includes("UPDATE projects"));

    // `backing_session_id` is write-once, so reading it outside the transaction
    // cannot go stale - and reading it inside would mean locking the project
    // row before the session control lock, inverting the global order.
    expect(backingAt).toBeGreaterThanOrEqual(0);
    expect(beginAt).toBeGreaterThan(backingAt);
    // session control lock -> approval rows -> project row.
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(refuseAt).toBeGreaterThan(lockAt);
    expect(updateAt).toBeGreaterThan(refuseAt);
  });

  it("refuses the project's pending Studio approvals in the SAME transaction as the bump", async () => {
    const query = scriptOrderedClient(["approval-1"]);
    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(true);

    const statements = query.mock.calls.map((c) => String(c[0]));
    const lock = statements.find((s) => s.includes("FROM approval_intents"));
    expect(lock).toContain("origin = 'studio_mcp'");
    expect(lock).toContain("decision IS NULL");
    expect(lock).toContain("FOR UPDATE");
    // The machine cause rides in the same CAS as the decision.
    const decision = query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes("UPDATE approval_intents"),
    ) as unknown[] | undefined;
    expect((decision?.[1] as unknown[])[4]).toBe("scope_changed");
    // Refusal before the bump, both before COMMIT.
    const refuseAt = statements.findIndex((s) => s.includes("UPDATE approval_intents"));
    const commitAt = statements.findIndex((s) => s.includes("COMMIT"));
    expect(refuseAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(refuseAt);
  });

  it("refuses nothing when the edit rolls back", async () => {
    // The mirror matches no row, so the whole edit is undone. A refusal that
    // was rolled back must not be announced to a blocked call.
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("SELECT backing_session_id FROM projects")) {
        return { rows: [{ backing_session_id: SESSION_ID }] };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM approval_intents")) {
        return { rows: [{ approval_id: "approval-1", project_id: PROJECT_ID }] };
      }
      if (sql.includes("UPDATE approval_queue")) return { rows: [{ id: "q" }] };
      if (sql.includes("UPDATE approval_intents")) return { rows: [{ approval_id: "i" }], rowCount: 1 };
      if (sql.includes("UPDATE sessions")) return { rowCount: 0 };
      if (sql.includes("UPDATE projects")) return { rows: [projectRow()] };
      if (sql.includes("FROM project_wallets")) return { rows: walletRows() };
      return { rows: [] };
    });
    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(false);
    const statements = query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes("COMMIT"))).toBe(false);
    expect(statements.filter((s) => s.includes("ROLLBACK"))).toHaveLength(1);
  });

  it("still reports `projects.not_found` when the project has no backing session to lock", async () => {
    const query = scriptClient((sql) => {
      if (sql.includes("FROM studio_settings")) return { rows: [{ projects_root: root }] };
      if (sql.includes("UPDATE projects")) return { rows: [] };
      if (sql.includes("SELECT scope_version")) return { rows: [] };
      return { rows: [] };
    });
    const outcome = await updateProjectScope(BASE_INPUT, null, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.not_found");
    // No session id means no lock is taken; the guarded UPDATE still answers.
    const statements = query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(false);
  });
});
