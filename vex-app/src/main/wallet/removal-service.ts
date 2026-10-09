import { disableWalletForRemoval, finishWalletRemoval, listWalletRemovalRecords, WalletLifecycleError, type WalletRemovalRecord } from "@vex-lib/wallet-removal.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { inspectRemovalDependencies, lockRemovalDependencies, retireRemovalDependencies } from "@vex-agent/db/repos/wallet-removal.js";
import { tryAcquireSigningLock } from "@vex-agent/engine/core/in-flight-signing.js";
import { invalidateLighterReadAuthCache } from "@vex-agent/tools/protocols/lighter/read-auth-cache.js";
import { clearLighterDeskPrewarm } from "@vex-agent/tools/protocols/lighter/desk-prewarm.js";
import { withWalletLock } from "../onboarding/wallet-mutex.js";
import { dropVaultDerivedKeys } from "../secrets/vault-key-cache.js";

export async function commitWalletRemoval(record: WalletRemovalRecord, recovery = false, authorized: () => boolean = () => true) {
  const dependencies = await withTransaction(async (client) => {
    await lockRemovalDependencies(client);
    const result = await inspectRemovalDependencies(client, record);
    if (!authorized()) throw new WalletLifecycleError("Wallet confirmation expired. Nothing was removed.");
    if (!recovery) disableWalletForRemoval(record);
    dropVaultDerivedKeys();
    invalidateLighterReadAuthCache();
    clearLighterDeskPrewarm();
    await retireRemovalDependencies(client, record, result);
    return result;
  });
  finishWalletRemoval(record);
  return dependencies;
}

/** Startup calls this before opening execution admission. Failures keep the gate closed. */
export async function recoverWalletRemovals(): Promise<void> {
  await withWalletLock(async () => {
    const release = tryAcquireSigningLock();
    if (!release) throw new WalletLifecycleError();
    try {
      for (const record of listWalletRemovalRecords()) {
        if (record.state === "removing") await commitWalletRemoval(record, true);
      }
    } finally { release(); }
  });
}
