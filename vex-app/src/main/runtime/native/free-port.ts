/**
 * Choosing the Postgres port at launch (D5): the last-used port when it is
 * free, otherwise one the OS hands out for port 0.
 *
 * Either answer is only a candidate. The probe socket is closed before
 * Postgres binds, so another process can take the port in between; the
 * supervisor treats Postgres' own "Address already in use" as the authority
 * and retries with a fresh candidate.
 */

import { createServer } from "node:net";
import { LOOPBACK_DB_HOST } from "../../database/connection-state.js";

/** Bind `port` on loopback and release it. Resolves the bound port, or null. */
function bindAndRelease(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen({ port, host: LOOPBACK_DB_HOST, exclusive: true }, () => {
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
}

export async function chooseFreePort(preferred: ReadonlyArray<number | null>): Promise<number> {
  for (const port of preferred) {
    if (port === null) continue;
    if ((await bindAndRelease(port)) === port) return port;
  }
  const ephemeral = await bindAndRelease(0);
  if (ephemeral === null) throw new Error(`could not bind any port on ${LOOPBACK_DB_HOST}`);
  return ephemeral;
}
