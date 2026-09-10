/** Coordinator-only maintenance: no signer, broadcast or secret output. */
import { closePool } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { repairEvmNonceState } from "../sync/repair-evm-nonce-state.js";

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--once") throw new Error("Usage: repair-evm-nonces.ts --once");
  if (!process.env.VEX_DB_URL) throw new Error("Set VEX_DB_URL for the intended database before running this command");
  await runMigrations();
  console.log(JSON.stringify(await repairEvmNonceState()));
}
try { await main(); }
catch { console.error("Nonce repair could not complete. Check database availability and the structured recovery logs; no transaction was sent."); process.exitCode = 1; }
finally { await closePool(); }
