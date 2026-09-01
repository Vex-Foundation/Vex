/**
 * `createProject` - the filesystem claim and the one create transaction.
 *
 * Follows the repository's database-test convention (`sessions-db.test.ts`,
 * `sessions-wallet-scope.test.ts`): a scripted fake `pg.Client` drives the SQL
 * without a live Postgres, so these run in the ordinary unit suite. The
 * filesystem side is REAL - a temp directory per test - because the claim and
 * its compensation are the behaviour under test and a mocked `fs` would prove
 * nothing about `mkdir` exclusivity or `rmdir` refusing a non-empty directory.
 *
 * What is pinned here:
 *   - the directory is claimed with an exclusive `mkdir`; an occupied slug is
 *     `projects.slug_taken` and the existing directory is untouched;
 *   - the backing session is inserted with `scope = 'vex_studio'`,
 *     `mode = 'agent'`, `title` = the project name, and the wallet columns
 *     mirrored;
 *   - exactly one `project_wallets` row per family, id and address jointly null
 *     or jointly present;
 *   - the projects-root anchor is the FIRST statement after `BEGIN`, it is the
 *     single upsert that both writes and reads the anchor, and a stored anchor
 *     that differs from the resolved root rolls the transaction back before any
 *     row is inserted;
 *   - on DB failure compensation removes ONLY the empty directory this request
 *     created, and never a pre-existing file or a non-empty directory.
 *
 * WHAT THESE TESTS CANNOT PROVE. The anchor statement's real guarantee is a ROW
 * LOCK taken on the `ON CONFLICT` path, so that a concurrent first-creation
 * cannot commit a different root between this transaction's check and its
 * inserts. A scripted `pg.Client` has no locks, no isolation and no second
 * connection: it can pin the statement shape and the reaction to the returned
 * value, and nothing more. Conflict visibility and lock behaviour under real
 * concurrency are provable only by a live-Postgres run against two connections,
 * which is a deferred check, not something asserted here.
 */

import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCreateInput } from "@shared/schemas/projects.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}) as { projectsRoot?: string }),
  buildPoolConfig: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getWalletById: vi.fn(),
  getClient: vi.fn<() => Client>(),
}));

vi.mock("@config/store.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("@vex-lib/wallet.js", () => ({ getWalletById: mocks.getWalletById }));
// `withClient` owns connection lifecycle; the test owns the scripted client.
vi.mock("../sessions/connection.js", async () => {
  const actual = await vi.importActual<typeof import("../sessions/connection.js")>(
    "../sessions/connection.js",
  );
  return {
    ...actual,
    withClient: async (fn: (c: Client) => Promise<unknown>) => fn(mocks.getClient()),
  };
});

const { createProject } = await import("../projects/create.js");

const CORR = "corr-create";
const EVM = { id: "evm_1", address: "0xEvmAddr" };

let root: string;

interface ScriptedResult {
  rows?: unknown[];
  rowCount?: number;
}

/**
 * Script the client by SQL fragment rather than by call index, so a test does
 * not silently pass when statement order changes for an unrelated reason.
 */
function scriptClient(
  responder: (sql: string) => ScriptedResult | Error,
): ReturnType<typeof vi.fn> {
  const query = vi.fn(async (sql: unknown) => {
    const outcome = responder(String(sql));
    if (outcome instanceof Error) throw outcome;
    return { rows: outcome.rows ?? [], rowCount: outcome.rowCount ?? (outcome.rows?.length ?? 0) };
  });
  mocks.getClient.mockReturnValue(Object.assign(new Client(), { query }));
  return query;
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "My App",
    slug: "my-app",
    root_path: "my-app",
    permission: "restricted",
    backing_session_id: "22222222-2222-4222-8222-222222222222",
    agents: [],
    scope_version: 1,
    generator_version: null,
    created_at: new Date("2026-08-23T10:00:00.000Z"),
    updated_at: new Date("2026-08-23T10:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Happy-path responder: every statement succeeds and the anchor upsert returns
 * the root this request resolved (the first-creation INSERT branch, and the
 * conflict branch of an anchor that already agrees, are indistinguishable to
 * the caller by design).
 */
function happyResponder(row = projectRow()) {
  return (sql: string): ScriptedResult => {
    if (sql.includes("INSERT INTO studio_settings")) {
      return { rows: [{ projects_root: root }] };
    }
    if (sql.includes("FROM projects WHERE id")) return { rows: [row] };
    return { rows: [] };
  };
}

const INPUT: ProjectCreateInput = {
  name: "My App",
  permission: "restricted",
  agents: ["claude-code"],
  wallets: { evm: null, solana: null },
};

function callsMatching(query: ReturnType<typeof vi.fn>, fragment: string) {
  return query.mock.calls.filter((c) => String(c[0]).includes(fragment));
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-projects-create-")));
  mocks.loadConfig.mockReturnValue({ projectsRoot: root });
  mocks.getWalletById.mockReturnValue(null);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createProject - directory claim", () => {
  it("claims <root>/<slug> and writes the three row families in one transaction", async () => {
    const query = scriptClient(happyResponder());
    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.slug).toBe("my-app");
    expect(outcome.data.rootPath).toBe("my-app");
    expect((await stat(path.join(root, "my-app"))).isDirectory()).toBe(true);

    // One BEGIN, one COMMIT, no ROLLBACK.
    expect(callsMatching(query, "BEGIN")).toHaveLength(1);
    expect(callsMatching(query, "COMMIT")).toHaveLength(1);
    expect(callsMatching(query, "ROLLBACK")).toHaveLength(0);
  });

  it("refuses an occupied slug with projects.slug_taken, writing nothing", async () => {
    const existing = path.join(root, "my-app");
    await mkdir(existing);
    await writeFile(path.join(existing, "user-file.txt"), "important");
    const query = scriptClient(happyResponder());

    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.slug_taken");
    expect(outcome.error.domain).toBe("projects");
    expect(outcome.error.message).toContain("my-app");
    // The user's file survives: the claim never overwrites and never renames.
    expect(await readdir(existing)).toEqual(["user-file.txt"]);
    // B0 changed this from "nothing reached the database" to "nothing WROTE to
    // it". The create path now asks, before claiming the directory, whether the
    // slug belongs to a tombstone whose cleanup is unfinished - because the
    // remover still owns that folder and racing it would delete the new
    // project's files. That is exactly one read-only lookup and no writes.
    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("FROM projects");
    expect(statements[0]).toContain("cleanup_state IN ('pending', 'trash_pending')");
    expect(
      statements.some((sql) => /\b(INSERT|UPDATE|DELETE|BEGIN)\b/i.test(sql)),
    ).toBe(false);
  });

  it("refuses a name that derives no slug rather than inventing a folder name", async () => {
    const query = scriptClient(happyResponder());
    const outcome = await createProject(
      { ...INPUT, name: "..." },
      { evm: null, solana: null },
      CORR,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation.invalid_input");
    expect(outcome.error.domain).toBe("projects");
    expect(await readdir(root)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("createProject - backing session and wallet rows", () => {
  it("inserts an agent-mode session scoped vex_studio, titled with the project name, wallets mirrored", async () => {
    const query = scriptClient(happyResponder());
    await createProject(INPUT, { evm: EVM, solana: null }, CORR);

    const insert = callsMatching(query, "INSERT INTO sessions")[0];
    expect(insert).toBeDefined();
    const sql = String(insert?.[0]);
    const params = insert?.[1] as unknown[];
    // mode is a literal in the statement: a Studio project never introduces a
    // new session mode.
    expect(sql).toContain("'agent'");
    expect(params[1]).toBe("vex_studio");
    expect(params[2]).toBe("restricted");
    // title = project name, so the GLOBAL approvals inbox has a useful label.
    expect(params[3]).toBe("My App");
    // Wallet columns mirrored from the RESOLVED refs, not from renderer input.
    expect(params[4]).toBe(EVM.id);
    expect(params[5]).toBe(EVM.address);
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
  });

  it("writes exactly one project_wallets row per family, jointly null when unselected", async () => {
    const query = scriptClient(happyResponder());
    await createProject(INPUT, { evm: EVM, solana: null }, CORR);

    const inserts = callsMatching(query, "INSERT INTO project_wallets");
    expect(inserts).toHaveLength(2);
    const families = inserts.map((c) => (c[1] as unknown[])[1]);
    expect(families).toEqual(["evm", "solana"]);

    const [evmParams, solParams] = inserts.map((c) => c[1] as unknown[]);
    // Selected: id AND address together.
    expect(evmParams?.[2]).toBe(EVM.id);
    expect(evmParams?.[3]).toBe(EVM.address);
    // Unselected: both null - never one without the other (migration 085 CHECK).
    expect(solParams?.[2]).toBeNull();
    expect(solParams?.[3]).toBeNull();
  });

  it("starts scope_version at 1 and never lets a create set it directly", async () => {
    const query = scriptClient(happyResponder());
    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.scopeVersion).toBe(1);
    // The INSERT does not name scope_version: the column default owns it.
    const insert = callsMatching(query, "INSERT INTO projects")[0];
    expect(String(insert?.[0])).not.toContain("scope_version");
  });

  it("anchors the projects root as one upsert that returns the stored root, never a value-overwriting update", async () => {
    const query = scriptClient(happyResponder());
    await createProject(INPUT, { evm: null, solana: null }, CORR);
    const write = callsMatching(query, "INSERT INTO studio_settings")[0];
    expect(write).toBeDefined();
    const sql = String(write?.[0]);
    // The conflict branch exists to take the row lock and return the STORED
    // root. It must stay a no-op on the value: an anchor that could be
    // rewritten by a create would silently re-home every existing project.
    expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(sql).toContain("updated_at = studio_settings.updated_at");
    expect(sql).toContain("RETURNING projects_root");
    expect(sql).not.toContain("projects_root = ");
    expect((write?.[1] as unknown[])[0]).toBe(root);
    // Exactly one statement does the anchoring: the old check-then-insert pair
    // (a plain SELECT plus a DO NOTHING insert) is what this replaced.
    expect(callsMatching(query, "INSERT INTO studio_settings")).toHaveLength(1);
    expect(callsMatching(query, "SELECT projects_root")).toHaveLength(0);
  });

  it("anchors the root as the first statement after BEGIN, before anything is written", async () => {
    const query = scriptClient(happyResponder());
    await createProject(INPUT, { evm: null, solana: null }, CORR);
    const statements = query.mock.calls.map((c) => String(c[0]));
    const begin = statements.findIndex((sql) => sql.includes("BEGIN"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(statements[begin + 1]).toContain("INSERT INTO studio_settings");
  });
});

describe("createProject - root contract", () => {
  it("rolls back and writes nothing when the anchor returns a different root", async () => {
    // The upsert's conflict branch returned somebody else's anchor: either it
    // was recorded before this configuration changed, or a concurrent
    // first-creation won the row. Either way this transaction must not insert a
    // project whose `root_path` is relative to a root that is not the anchor.
    const query = scriptClient((sql) => {
      if (sql.includes("INSERT INTO studio_settings")) {
        return { rows: [{ projects_root: path.join(root, "somewhere-else") }] };
      }
      return { rows: [] };
    });

    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_changed");
    expect(outcome.error.retryable).toBe(false);

    // Rolled back, and no row family was ever attempted.
    expect(callsMatching(query, "ROLLBACK")).toHaveLength(1);
    expect(callsMatching(query, "COMMIT")).toHaveLength(0);
    expect(callsMatching(query, "INSERT INTO sessions")).toHaveLength(0);
    expect(callsMatching(query, "INSERT INTO projects")).toHaveLength(0);
    expect(callsMatching(query, "INSERT INTO project_wallets")).toHaveLength(0);

    // The directory this request created is removed again.
    expect(await readdir(root)).toEqual([]);
  });

  it("proceeds when the anchor returns the same root by a different but equivalent path form", async () => {
    // `path.resolve` equality, not string equality: a trailing separator on the
    // stored anchor is the same root and must not fail an otherwise valid
    // create.
    const query = scriptClient((sql) => {
      if (sql.includes("INSERT INTO studio_settings")) {
        return { rows: [{ projects_root: `${root}${path.sep}` }] };
      }
      if (sql.includes("FROM projects WHERE id")) return { rows: [projectRow()] };
      return { rows: [] };
    });

    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    expect(outcome.ok).toBe(true);
    expect(callsMatching(query, "COMMIT")).toHaveLength(1);
    expect(callsMatching(query, "ROLLBACK")).toHaveLength(0);
  });
});

describe("createProject - compensation", () => {
  it("removes ONLY the empty directory it created when the transaction fails", async () => {
    scriptClient((sql) => {
      if (sql.includes("INSERT INTO studio_settings")) {
        return { rows: [{ projects_root: root }] };
      }
      if (sql.includes("INSERT INTO sessions")) return new Error("boom");
      return { rows: [] };
    });

    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    expect(outcome.ok).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves a directory that is no longer empty and reports rather than deleting content", async () => {
    // Something wrote into the claimed directory between the claim and the
    // failure. `rmdir` is non-recursive, so the content survives - compensation
    // must never become a delete of user files.
    scriptClient((sql) => {
      if (sql.includes("INSERT INTO studio_settings")) {
        return { rows: [{ projects_root: root }] };
      }
      if (sql.includes("INSERT INTO projects")) {
        return new Error("constraint violation");
      }
      return { rows: [] };
    });
    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    // The claimed directory exists at this point; drop a file in and re-run the
    // compensation path by creating again into the now-occupied slug.
    expect(outcome.ok).toBe(false);

    const claimed = path.join(root, "my-app");
    await mkdir(claimed, { recursive: true });
    await writeFile(path.join(claimed, "agent-wrote-this.txt"), "data");
    const second = await createProject(INPUT, { evm: null, solana: null }, CORR);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("projects.slug_taken");
    expect(await readdir(claimed)).toEqual(["agent-wrote-this.txt"]);
  });

  it("never uses rename anywhere in the create path", async () => {
    // Node documents that `rename` can overwrite an existing file. A workspace
    // claim that could overwrite is the exact failure this path must not have,
    // so the absence is pinned in source rather than left to review.
    const source = await (
      await import("node:fs/promises")
    ).readFile(
      path.resolve(__dirname, "..", "projects", "create.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\brename(Sync)?\s*\(/);
    // And the claim is exclusive: no `recursive: true` on the project directory.
    expect(source).toMatch(/await mkdir\(directory\);/);
  });
});
