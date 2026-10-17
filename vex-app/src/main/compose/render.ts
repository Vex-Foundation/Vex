/**
 * Pure compose render core (codex turn 4 RED #1). NO Electron imports
 * here; dependencies are injected so tests can run it without Electron.
 *
 * Dependencies are injected via `RenderDeps` so:
 *   - vex-app main process passes `electronSecretAdapter` (DPAPI-backed
 *     on Windows, plain mode-0o600 on POSIX)
 *   - tests pass deterministic adapters that capture writes in-memory
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_EMBED_PORT } from "../onboarding/embedding-defaults.js";
import { DEFAULT_PG_PORT } from "@shared/local-service-ports.js";
import {
  getPgPassword,
  type CryptoAdapter,
  type RandomAdapter,
  type SecretAdapter,
} from "../runtime/secrets/pg-password.js";

// The secret plumbing is shared with the native runtime and lives with it;
// re-exported so compose callers keep one import.
export { getPgPassword };
export type { CryptoAdapter, PgPasswordDeps, RandomAdapter, SecretAdapter } from "../runtime/secrets/pg-password.js";

export interface RenderDeps {
  readonly userDataDir: string;
  readonly resourcesDir: string;
  readonly secretAdapter: SecretAdapter;
  readonly randomAdapter: RandomAdapter;
  readonly cryptoAdapter: CryptoAdapter;
}

export interface RenderOptions {
  readonly pgPort?: number;
  readonly embedPort?: number;
}

export interface RenderResult {
  readonly outPath: string;
  readonly installId: string;
  readonly pgPasswordComposePath: string;
  /**
   * Port the compose template will publish for the embeddings runtime
   * on the loopback interface. Forwarded to `ensureEmbeddingDefaults`
   * and host-side health probes so we never disagree on the URL.
   */
  readonly embedPort: number;
}

const TEMPLATE_NAME = "docker-compose.template.yml";
const COMPOSE_OUT_DIR_NAME = "compose";
const COMPOSE_OUT_FILE_NAME = "docker-compose.yml";
const INSTALL_ID_FILE_NAME = ".install-id";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Where `renderCompose` writes this install's project file. */
export function renderedComposePath(userDataDir: string): string {
  return path.join(userDataDir, COMPOSE_OUT_DIR_NAME, COMPOSE_OUT_FILE_NAME);
}

/**
 * The install id if one was ever generated, else null. Never creates one:
 * the data migration asks whether this install ever ran the compose stack.
 */
export async function readInstallId(userDataDir: string): Promise<string | null> {
  try {
    const id = (await fs.readFile(path.join(userDataDir, INSTALL_ID_FILE_NAME), "utf8")).trim();
    return id.length > 0 ? id : null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Reads or generates the install id. Once written, it is immutable for
 * the lifetime of this `userDataDir` so per-install resource names
 * (volumes, secrets, compose project) stay stable across launches.
 */
export async function getInstallId(deps: RenderDeps): Promise<string> {
  const target = path.join(deps.userDataDir, INSTALL_ID_FILE_NAME);
  if (await fileExists(target)) {
    const existing = (await fs.readFile(target, "utf8")).trim();
    if (existing.length > 0) return existing;
  }
  await fs.mkdir(deps.userDataDir, { recursive: true });
  const id = deps.randomAdapter.uuid();
  await fs.writeFile(target, id, { encoding: "utf8" });
  return id;
}


export async function renderCompose(
  deps: RenderDeps,
  options: RenderOptions = {}
): Promise<RenderResult> {
  const installId = await getInstallId(deps);
  const pgPassword = await getPgPassword(deps);

  const templatePath = path.join(deps.resourcesDir, TEMPLATE_NAME);
  const template = await fs.readFile(templatePath, "utf8");

  const pgPort = options.pgPort ?? DEFAULT_PG_PORT;
  const embedPort = options.embedPort ?? DEFAULT_EMBED_PORT;
  const rendered = template
    .replaceAll("${VEX_INSTALL_ID}", installId)
    .replaceAll("${VEX_PG_PASSWORD_FILE}", pgPassword.composePath)
    .replaceAll(`\${VEX_PG_PORT:-${DEFAULT_PG_PORT}}`, String(pgPort))
    .replaceAll(
      `\${VEX_EMBED_PORT:-${DEFAULT_EMBED_PORT}}`,
      String(embedPort)
    );

  const outPath = renderedComposePath(deps.userDataDir);
  const outDir = path.dirname(outPath);
  await fs.mkdir(outDir, { recursive: true });

  // Atomic write — temp + rename so a crash mid-write never leaves
  // compose with an unparseable file.
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, rendered, "utf8");
  await fs.rename(tempPath, outPath);

  return {
    outPath,
    installId,
    pgPasswordComposePath: pgPassword.composePath,
    embedPort,
  };
}
