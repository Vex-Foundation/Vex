/**
 * The secret deps the main process uses: CONFIG_DIR, the Electron secret
 * adapter and node crypto. Kept apart from `pg-password.ts` so that module
 * (and the compose renderer that re-exports it) stays free of Electron.
 */

import { safeStorage } from "electron";
import { CONFIG_DIR } from "../../paths/config-dir.js";
import { makeElectronSecretAdapter } from "./electron-secret-adapter.js";
import { nodeCryptoAdapter, nodeRandomAdapter, type PgPasswordDeps } from "./pg-password.js";

export function productionPgPasswordDeps(): PgPasswordDeps {
  return {
    userDataDir: CONFIG_DIR,
    secretAdapter: makeElectronSecretAdapter({ safeStorage }),
    randomAdapter: nodeRandomAdapter,
    cryptoAdapter: nodeCryptoAdapter,
  };
}
