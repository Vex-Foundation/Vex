/**
 * `commitArtifactProvenance`: `written` is a ONE-WAY DOOR, proven in SQL.
 *
 * ## The invariant, and why it belongs to the statement
 *
 * `origin` decides whether the B0 project teardown may DELETE an artifact's
 * bytes. `written` means Vex authored them and the teardown removes them;
 * `adopted` means the bytes merely matched a fresh render, which the teardown
 * treats as "not provably ours" and keeps. A commit that downgraded a `written`
 * row to `adopted` would therefore silently revoke a deletion right the project
 * already held - and nothing about that is visible at the call site.
 *
 * The reconciler declines to make that call, and its own suite covers that. But
 * a caller's discipline is not a durable guarantee: the next caller has not
 * been written yet. So the `ON CONFLICT ... DO UPDATE` keeps `written` itself,
 * and this file drives the REAL statement against a REAL PostgreSQL to prove
 * it, because a CASE expression in an upsert is exactly the kind of thing a
 * fake would assert nothing about.
 *
 * Both directions are asserted: the downgrade is refused, and the UPGRADE
 * (`adopted` -> `written`) still goes through - a no-downgrade rule that also
 * froze the upgrade would break every genuine rewrite.
 */

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../db-config.js", () => ({
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

import { ok } from "@shared/ipc/result.js";
import { withClient } from "../sessions/connection.js";
import {
  commitArtifactProvenance,
  readArtifactProvenance,
  type ArtifactProvenanceOrigin,
} from "../projects/installer-provenance.js";

async function sql(text: string, values: readonly unknown[] = []): Promise<void> {
  const result = await withClient(async (client) => {
    await client.query(text, [...values]);
    return ok(null);
  });
  if (!result.ok) throw new Error(`seed statement failed: ${text}`);
}

const ARTIFACT_KEY = "agents-md";
let projectId = "";
let sessionId = "";

/** Commit one record for the shared artifact key, differing only in `origin`. */
async function commit(origin: ArtifactProvenanceOrigin): Promise<void> {
  const result = await commitArtifactProvenance(projectId, {
    artifactKey: ARTIFACT_KEY,
    relativePath: "AGENTS.md",
    entryHash: `entry-${origin}`,
    contentHash: `content-${origin}`,
    origin,
  });
  expect(result.ok).toBe(true);
}

/** Read the row back through the production reader. */
async function storedOrigin(): Promise<ArtifactProvenanceOrigin | undefined> {
  const read = await readArtifactProvenance(projectId);
  expect(read.ok).toBe(true);
  if (!read.ok) return undefined;
  return read.data.get(ARTIFACT_KEY)?.origin;
}

beforeEach(async () => {
  projectId = randomUUID();
  sessionId = randomUUID();
  await sql(
    "INSERT INTO sessions (id, mode, scope) VALUES ($1, 'agent', 'vex_studio')",
    [sessionId],
  );
  await sql(
    `INSERT INTO projects (id, name, slug, root_path, permission,
                           backing_session_id, scope_version)
     VALUES ($1, 'Provenance', $2, $2, 'restricted', $3, 1)`,
    [projectId, `prov-${projectId.slice(0, 8)}`, sessionId],
  );
});

afterEach(async () => {
  await sql("DELETE FROM project_file_provenance WHERE project_id = $1", [projectId]);
  await sql("DELETE FROM projects WHERE id = $1", [projectId]);
  await sql("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

describe("commitArtifactProvenance origin transitions", () => {
  it("keeps written when a later commit claims adopted", async () => {
    await commit("written");
    expect(await storedOrigin()).toBe("written");

    // The downgrade. It succeeds as a statement - the other columns DO move,
    // because a re-adoption is still a fresh observation of the file - but the
    // authorship proof survives it.
    await commit("adopted");

    expect(await storedOrigin()).toBe("written");
  });

  it("still updates the digests the downgrading commit carried", async () => {
    await commit("written");
    await commit("adopted");

    const read = await readArtifactProvenance(projectId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const row = read.data.get(ARTIFACT_KEY);
    // Only `origin` is pinned. Freezing the whole row would make a later
    // adoption a silent no-op and leave stale digests behind, which is a
    // different defect.
    expect(row?.contentHash).toBe("content-adopted");
    expect(row?.entryHash).toBe("entry-adopted");
  });

  it("upgrades adopted to written", async () => {
    await commit("adopted");
    expect(await storedOrigin()).toBe("adopted");

    await commit("written");

    expect(await storedOrigin()).toBe("written");
  });
});
