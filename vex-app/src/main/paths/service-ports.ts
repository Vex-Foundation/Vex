/**
 * Host ports THIS install publishes for the local Docker stack.
 *
 * The constants in `@shared/local-service-ports.js` and
 * `onboarding/embedding-defaults.js` stay fixed: the compose template
 * spells them literally (`${VEX_PG_PORT:-27432}`) and `compose/render`
 * substitutes on that exact string, so changing the constant would
 * silently stop matching the placeholder. This module layers the
 * runtime override on top instead.
 *
 * Why an override exists at all: a second, deliberately isolated
 * install (its own `VEX_CONFIG_DIR`, therefore its own install id and
 * its own `vex-<uuid>` compose project) still publishes on the SAME
 * fixed host ports as the primary install. Whichever stack comes up
 * second then fails the port pre-check with "Containers from a
 * previous Vex installation are holding the required ports". Setting
 * `VEX_PG_PORT` / `VEX_EMBED_PORT` alongside `VEX_CONFIG_DIR` gives
 * that install its own ports so both can run at once.
 *
 * No Electron imports here, for the same reason as `config-dir.ts`.
 */

import { DEFAULT_PG_PORT } from "@shared/local-service-ports.js";
import { DEFAULT_EMBED_PORT } from "../onboarding/embedding-defaults.js";

/**
 * A port environment variable is USABLE only when it is a plain
 * decimal integer inside the TCP port range. Empty, non-numeric, 0 and
 * out-of-range values are treated as unset rather than published as a
 * nonsense port - the same "a typo must not redirect runtime state"
 * rule `usableDirEnv` applies in `config-dir.ts`.
 */
function usablePortEnv(value: string | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  if (port < 1 || port > 65535) return null;
  return port;
}

export function resolvePgPort(env: NodeJS.ProcessEnv = process.env): number {
  return usablePortEnv(env["VEX_PG_PORT"]) ?? DEFAULT_PG_PORT;
}

export function resolveEmbedPort(env: NodeJS.ProcessEnv = process.env): number {
  return usablePortEnv(env["VEX_EMBED_PORT"]) ?? DEFAULT_EMBED_PORT;
}
