/**
 * Engine DB URL refresh shared by the chat entrypoints (`chat.submit`,
 * `chat.steer`): points the engine's pool at the app-managed Postgres and
 * recycles the pool when the URL changes.
 */

import { URL } from "node:url";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { closePool } from "@vex-agent/db/client.js";
import { buildPoolConfig } from "../../database/db-config.js";
import { log } from "../../logger/index.js";

export function dbUnavailableError(correlationId: string): VexError {
  return {
    code: "internal.unexpected",
    domain: "database",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function makePostgresUrl(args: {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}): string {
  const url = new URL(`postgresql://${args.host}:${args.port}/${args.database}`);
  url.username = args.user;
  url.password = args.password;
  return url.toString();
}

export async function ensureEngineDbUrl(
  correlationId: string,
): Promise<Result<void, VexError>> {
  try {
    const cfg = await buildPoolConfig();
    if (cfg === null) return err(dbUnavailableError(correlationId));
    const nextUrl = makePostgresUrl(cfg);
    if (process.env.VEX_DB_URL === nextUrl) return ok(undefined);

    process.env.VEX_DB_URL = nextUrl;
    await closePool();
    log.info(
      `[ipc:chat] engine database connection refreshed correlationId=${correlationId}`,
    );
    return ok(undefined);
  } catch {
    return err(dbUnavailableError(correlationId));
  }
}
