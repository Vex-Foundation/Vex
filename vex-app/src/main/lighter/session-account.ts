import { getLighterClient } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { readUniqueLighterMasterAccount, type LighterAccountOwnershipReader } from "@tools/lighter/wallet-funding/account-ownership.js";
import { throwIfAborted } from "../../../../src/utils/cancellation.js";
import { readSessionWalletFromEngine } from "./onboarding-checklist.js";
import { recordLighterDeskOwnership } from "@vex-agent/tools/protocols/lighter/preview-snapshot.js";

/** Resolve public ownership under the session's wallet policy, never a renderer account selector. */
export async function resolveLighterSessionAccount(
  input: { readonly sessionId: string; readonly environment: LighterEnvironment; readonly signal?: AbortSignal },
  deps: {
    readonly readSessionWallet: typeof readSessionWalletFromEngine;
    readonly client: LighterAccountOwnershipReader;
  } = { readSessionWallet: readSessionWalletFromEngine, client: getLighterClient() },
): Promise<number> {
  throwIfAborted(input.signal);
  const { walletAddress } = await deps.readSessionWallet(input.sessionId);
  throwIfAborted(input.signal);
  const readAtMs = Date.now();
  const accountIndex = await readUniqueLighterMasterAccount(deps.client, input.environment, walletAddress);
  // LIGHTER_DESK_PREWARM_OWNERSHIP: this fresh proof (the desk account panel
  // makes one every 15 s) stands in for the next desk preview's ownership
  // read while it is young. No-op while the switch is OFF.
  recordLighterDeskOwnership({ environment: input.environment, walletAddress, accountIndex, atMs: readAtMs });
  throwIfAborted(input.signal);
  return accountIndex;
}
