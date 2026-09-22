import { getLighterClient } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { readUniqueLighterMasterAccount, type LighterAccountOwnershipReader } from "@tools/lighter/wallet-funding/account-ownership.js";
import { throwIfAborted } from "../../../../src/utils/cancellation.js";
import { readSessionWalletFromEngine } from "./onboarding-checklist.js";

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
  const accountIndex = await readUniqueLighterMasterAccount(deps.client, input.environment, walletAddress);
  throwIfAborted(input.signal);
  return accountIndex;
}
