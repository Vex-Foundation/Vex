/**
 * Builds a `pg.Pool` config from the compose state held in
 * `connection-state.ts`. Reads the password from the secret file the
 * compose stack mounts — that file is owned by main and never crosses
 * the preload boundary.
 *
 * Returns `null` when no compose has run yet; callers must surface
 * that as a user-facing failure (compose bootstrap must succeed first).
 */

import { promises as fs } from "node:fs";
import { getDbConnection } from "./connection-state.js";

export interface DbPoolConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

const DEFAULT_DATABASE = "vex";
const DEFAULT_USER = "vex";

export async function buildPoolConfig(): Promise<DbPoolConfig | null> {
  const conn = getDbConnection();
  if (conn === null) return null;
  let password: string;
  try {
    const raw = await fs.readFile(conn.pgPasswordPath, "utf8");
    password = raw.trim();
  } catch {
    return null;
  }
  if (password.length === 0) return null;
  return {
    host: conn.host,
    port: conn.pgPort,
    database: DEFAULT_DATABASE,
    user: DEFAULT_USER,
    password,
  };
}
