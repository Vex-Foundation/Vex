/**
 * "The previous release" on this machine, for the real migration tests: a
 * disposable compose project for a test-only install id (`migtest-...`) on the
 * SAME pinned image the app ships, with the app's own compose code, all its
 * migrations and realistic data, stopped as the old app's quit would leave it.
 *
 * Shared by `docker-to-native.real.test.ts` (which migrates it with the engine
 * directly) and `previous-release.seed.real.test.ts` (which leaves one in a
 * config dir for the built app to migrate through its UI). Everything it
 * creates carries the `migtest-` id, and `removeAll` removes exactly that.
 *
 * Callers mock `electron` (the secret adapter imports its types only) and the
 * logger before importing this.
 */

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { renderCompose } from "../../../compose/render.js";
import { composeUpDetached } from "../../../compose/up.js";
import { waitForHealth } from "../../../compose/health.js";
import { composeDown } from "../../../compose/lifecycle.js";
import { runMigrationsWithProgress } from "../../../../../../src/lib/db/migrate-runner.js";
import { chooseFreePort } from "../../native/free-port.js";
import { makeElectronSecretAdapter } from "../../secrets/electron-secret-adapter.js";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");
export const RESOURCES_DIR = path.join(REPO_ROOT, "vex-app", "resources", "compose");
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "src", "vex-agent", "db", "migrations");
const TEMPLATE = readFileSync(path.join(RESOURCES_DIR, "docker-compose.template.yml"), "utf8");
export const IMAGE = /image: (pgvector\/pgvector:[^\s]+)/.exec(TEMPLATE)?.[1] ?? "";

export const SEED = { sessions: 60, messagesPerSession: 250, knowledge: 3_000, walletIntents: 40, dim: 768 } as const;

/** Null when this machine can run the previous release, or why it cannot. */
export function dockerAnswers(): string | null {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000 });
  if (info.status !== 0) return `docker does not answer (${(info.stderr || info.error?.message || "").trim().split("\n")[0] ?? ""})`;
  const image = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { encoding: "utf8", timeout: 20_000 });
  return image.status === 0 ? null : `the pinned image ${IMAGE} is not present locally (docker pull it once)`;
}

export function vectorLiteral(seed: number): string {
  // Deterministic, varied magnitudes and signs, including tiny values that
  // print with exponents.
  const values: string[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < SEED.dim; i++) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    const v = (x / 2 ** 32 - 0.5) * (i % 97 === 0 ? 1e-6 : 1);
    values.push(Math.fround(v).toString());
  }
  return `[${values.join(",")}]`;
}

export interface Seeded {
  readonly migrationsApplied: number;
  readonly counts: Record<string, number>;
  readonly databaseSize: string | undefined;
  /** knowledge_entries id -> embedding text, as the old database printed it. */
  readonly vectors: Map<number, string>;
  readonly messages: number;
}

export interface PreviousRelease {
  readonly installId: string;
  readonly project: string;
  readonly volumes: readonly string[];
  readonly configDir: string;
  readonly composeDir: string;
  readonly sourcePort: number;
  renderDeps(): Parameters<typeof renderCompose>[0];
  /** The install's Postgres password; set once the source first came up. */
  password(): string;
  docker(args: readonly string[]): { status: number | null; stdout: string; stderr: string };
  volumeExists(name: string): boolean;
  runningContainers(): string[];
  withClient<T>(port: number, body: (c: pg.Client) => Promise<T>): Promise<T>;
  /** The `db` service up on `sourcePort`, healthy. */
  bringUp(): Promise<void>;
  /** `compose stop`, as the old app's quit leaves it. */
  stop(): Promise<void>;
  /** Up, every migration, the seed data, stopped. */
  seed(): Promise<Seeded>;
  /** This project's containers and volumes, by their migtest- names only. */
  removeAll(): void;
}

/** `configDir` gets the `.install-id`; nothing outside it and the project is touched. */
export async function createPreviousRelease(options: {
  readonly configDir: string;
  readonly installId?: string;
}): Promise<PreviousRelease> {
  const installId = options.installId ?? `migtest-${randomUUID()}`;
  if (!installId.startsWith("migtest-")) throw new Error(`refusing a non-test install id: ${installId}`);
  const configDir = options.configDir;
  const composeDir = path.join(configDir, "compose");
  const project = `vex-${installId}`;
  const volumes = [`vex-postgres-data-${installId}`, `vex-embed-models-${installId}`];
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, ".install-id"), installId);
  const sourcePort = await chooseFreePort([]);
  let password = "";

  const renderDeps = (): Parameters<typeof renderCompose>[0] => ({
    userDataDir: configDir,
    resourcesDir: RESOURCES_DIR,
    secretAdapter: makeElectronSecretAdapter(),
    randomAdapter: { uuid: () => randomUUID(), randomBytes: (n) => randomBytes(n) },
    cryptoAdapter: { base64url: (b) => Buffer.from(b).toString("base64url") },
  });

  const docker = (args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  async function withClient<T>(port: number, body: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "vex", password, database: "vex", connectionTimeoutMillis: 10_000 });
    await c.connect();
    try {
      return await body(c);
    } finally {
      await c.end();
    }
  }

  async function bringUp(): Promise<void> {
    const rendered = await renderCompose(renderDeps(), { pgPort: sourcePort, embedPort: await chooseFreePort([]) });
    const up = await composeUpDetached({ composeDir: path.dirname(rendered.outPath), services: ["db"] });
    if (up.code !== 0) throw new Error(`compose up failed: ${up.stderr}`);
    const health = await waitForHealth({ pgPort: sourcePort, pgPasswordPath: rendered.pgPasswordComposePath, installId });
    if (health.verdict !== "usable") throw new Error(`the old database is not usable: ${health.message}`);
    password = readFileSync(path.join(configDir, "local-infra", "secrets", "pg_password"), "utf8").trim();
  }

  async function stop(): Promise<void> {
    const down = await composeDown(path.join(composeDir, "docker-compose.yml"), installId);
    if (down.kind !== "stopped") throw new Error(`compose stop failed: ${down.message}`);
  }

  async function seed(): Promise<Seeded> {
    await bringUp();
    const pool = new pg.Pool({ host: "127.0.0.1", port: sourcePort, user: "vex", password, database: "vex", max: 2 });
    let migrationsApplied = 0;
    try {
      migrationsApplied = (await runMigrationsWithProgress({ pool, migrationsDir: MIGRATIONS_DIR })).applied;
    } finally {
      await pool.end();
    }

    const vectors = new Map<number, string>();
    let messages = 0;
    const result = await withClient(sourcePort, async (c) => {
      await c.query("BEGIN");
      for (let s = 0; s < SEED.sessions; s++) {
        const sessionId = `session-${String(s)}-${randomUUID()}`;
        await c.query("INSERT INTO sessions (id, mode, scope, summary, initial_goal) VALUES ($1, $2, 'vex_app', $3, $4)", [
          sessionId,
          s % 3 === 0 ? "mission" : "agent",
          `Résumé ${String(s)}: swapped ⚡ SOL → USDC, «quotes» and \\backslashes\\`,
          s % 2 === 0 ? null : `goal\nwith newline ${String(s)}`,
        ]);
        const rows: string[] = [];
        const params: unknown[] = [];
        for (let m = 0; m < SEED.messagesPerSession; m++) {
          const base = params.length;
          rows.push(`($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(base + 4)}::jsonb, now() - ($${String(base + 5)} || ' seconds')::interval)`);
          params.push(
            sessionId,
            m % 2 === 0 ? "user" : "assistant",
            `message ${String(m)} 🦊 ${"x".repeat(m % 50)}`,
            m % 5 === 0 ? JSON.stringify([{ id: `call_${String(m)}`, type: "function", function: { name: "wallet.send", arguments: { amount: "0.000001", to: "0xAbC", nested: { a: [1, 2.5, null, true] } } } }]) : null,
            String(m * 7),
          );
        }
        await c.query(`INSERT INTO messages (session_id, role, content, tool_calls, created_at) VALUES ${rows.join(",")}`, params);
        messages += SEED.messagesPerSession;
        if (s < SEED.walletIntents) {
          await c.query(
            `INSERT INTO wallet_intents (intent_id, session_id, wallet_address, network, to_address, amount, preview_json, status, expires_at)
             VALUES ($1, $2, '0xWallet', 'eip155', '0xdest', '1.000000000000000001', $3::jsonb, 'pending', now() + interval '10 minutes')`,
            [`intent-${randomUUID()}`, sessionId, JSON.stringify({ label: "send", criticalArgs: { chainId: 8453, gas: 21000 } })],
          );
        }
      }
      for (let k = 0; k < SEED.knowledge; k++) {
        const literal = vectorLiteral(k + 1);
        const r = await c.query<{ id: number; v: string }>(
          `INSERT INTO knowledge_entries (kind, title, summary, content_md, content_hash, embedding_model, embedding_dim, embedding, tags, source_refs, confidence)
           VALUES ('risk_rule', $1, $2, $3, $4, 'ai/embeddinggemma:300M-Q8_0', 768, $5::vector, $6, $7::jsonb, $8)
           RETURNING id, embedding::text AS v`,
          [
            `rule ${String(k)}`,
            `summary ${String(k)} — ünïcödé`,
            `# Content ${String(k)}\n\n${"lorem ipsum ".repeat(k % 40)}`,
            `hash-${String(k)}-${randomUUID()}`,
            literal,
            [`tag${String(k % 7)}`, "π"],
            JSON.stringify({ protocol_execution_ids: [k, k + 1], instrument_key: `sol:${String(k)}` }),
            k % 4 === 0 ? null : (k % 100) / 100,
          ],
        );
        const row = r.rows[0];
        if (row !== undefined) vectors.set(row.id, row.v);
      }
      await c.query("COMMIT");
      const counts = await c.query<{ t: string; n: string }>(
        `SELECT 'sessions' AS t, count(*)::text AS n FROM sessions UNION ALL SELECT 'messages', count(*)::text FROM messages
         UNION ALL SELECT 'knowledge_entries', count(*)::text FROM knowledge_entries UNION ALL SELECT 'wallet_intents', count(*)::text FROM wallet_intents`,
      );
      const size = await c.query<{ s: string }>("SELECT pg_size_pretty(pg_database_size('vex')) AS s");
      return { counts: Object.fromEntries(counts.rows.map((r) => [r.t, Number(r.n)])), databaseSize: size.rows[0]?.s };
    });
    await stop();
    return { migrationsApplied, counts: result.counts, databaseSize: result.databaseSize, vectors, messages };
  }

  return {
    installId,
    project,
    volumes,
    configDir,
    composeDir,
    sourcePort,
    renderDeps,
    password: () => password,
    docker,
    volumeExists: (name) => docker(["volume", "inspect", name]).status === 0,
    runningContainers: () =>
      docker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "status=running", "--format", "{{.Names}}"])
        .stdout.split("\n")
        .filter(Boolean),
    withClient,
    bringUp,
    stop,
    seed,
    removeAll() {
      if (!installId.startsWith("migtest-")) return;
      if (existsSync(path.join(composeDir, "docker-compose.yml"))) {
        spawnSync("docker", ["compose", "-p", project, "down", "--volumes", "--remove-orphans"], { cwd: composeDir, timeout: 120_000 });
      }
      for (const v of volumes) if (v.includes("-migtest-")) spawnSync("docker", ["volume", "rm", "-f", v], { timeout: 60_000 });
    },
  };
}
