/**
 * K-4 routing guard: which main-process DB modules still open their own
 * `pg.Client`, and which go through `runWithMainDbClient`.
 *
 * The IPC read/write wrappers share one connection policy (`main-ipc-pg-pool`)
 * so `MAIN_IPC_PG_POOL` covers them all. The modules left on their own client
 * are readiness probes, the quit-time active-work check, the wake read and
 * the dimension lock (a different statement timeout). A new `new Client(`
 * outside that list fails here, so a wrapper cannot silently grow back.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DATABASE_DIR = path.resolve(__dirname, "..");

const OWN_CLIENT_ALLOWED = [
  "dim-lock.ts",
  "memory-jobs-db.ts",
  "mission-runs-db.ts",
  "regime-db.ts",
  "sync-db.ts",
  "tool-embeddings-db.ts",
  "wake-db.ts",
].sort();

const ROUTED = [
  "agent-scan-db-query.ts",
  "approvals-db.ts",
  "bug-reports/connection.ts",
  "compaction-db.ts",
  "compaction-preparation-db.ts",
  "event-loop-samples-db.ts",
  "long-memory-db.ts",
  "memory-db.ts",
  "memory-inspector-db.ts",
  "messages/connection.ts",
  "missions-db.ts",
  "portfolio-db.ts",
  "runtime-db-client.ts",
  "sessions/connection.ts",
  "token-history-db-query.ts",
  "usage-db.ts",
].sort();

function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue;
    const full = path.join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full, rel));
    } else if (name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

describe("main-process DB connection routing", () => {
  const files = sourceFiles(DATABASE_DIR);
  const read = (rel: string): string => readFileSync(path.join(DATABASE_DIR, rel), "utf8");

  it("opens a raw pg.Client only in the allow-listed probe modules", () => {
    const own = files
      .filter((rel) => rel !== "main-ipc-pg-pool.ts")
      .filter((rel) => read(rel).includes("new Client("))
      .sort();
    expect(own).toEqual(OWN_CLIENT_ALLOWED);
  });

  it("routes every IPC connection wrapper through runWithMainDbClient", () => {
    const routed = files.filter((rel) => read(rel).includes("runWithMainDbClient(")).sort();
    expect(routed).toEqual(ROUTED);
  });
});
