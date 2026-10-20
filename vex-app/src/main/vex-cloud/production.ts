/**
 * The production wiring of the Vex Cloud owner: the real HTTP client, the
 * wallet inventory, the vault-backed session store and the template signer.
 * One place, so the sign-in handler, the account handler and the provider
 * persist path cannot reach the world through different seams.
 */

import { getAddress } from "viem";
import { listWallets } from "@vex-lib/wallet.js";
import { vexCloudSiweBinding } from "@vex-lib/vex-cloud-endpoint.js";
import { signVexCloudSiweMessage } from "@tools/wallet/siwe-signing.js";
import type { Result } from "@shared/ipc/result.js";
import { isSecretSessionUnlocked } from "../secrets/session.js";
import type { ReadAccountDeps } from "./account.js";
import { createVexCloudApi, type VexCloudApi } from "./api-client.js";
import { clearVexCloudSession, readVexCloudSession, storeVexCloudSession } from "./session-store.js";
import type { SignInDeps } from "./sign-in.js";

/** Everything the Vex Cloud handlers reach the world through; injected by tests. */
export interface VexCloudDeps {
  readonly api: VexCloudApi;
  readonly signIn: Omit<SignInDeps, "api">;
  readonly account: Omit<ReadAccountDeps, "api">;
  readonly clearSession: () => Promise<Result<void>>;
}

function localEvmAddresses(): readonly string[] {
  return listWallets("evm").map((entry) => getAddress(entry.address));
}

export function productionVexCloudDeps(): VexCloudDeps {
  return {
    api: createVexCloudApi(),
    signIn: {
      listEvmWallets: () => listWallets("evm"),
      isVaultUnlocked: isSecretSessionUnlocked,
      signMessage: signVexCloudSiweMessage,
      binding: () => vexCloudSiweBinding(),
      storeSession: storeVexCloudSession,
      now: () => new Date(),
    },
    account: {
      readSession: readVexCloudSession,
      clearSession: clearVexCloudSession,
      localWallets: localEvmAddresses,
      now: () => new Date(),
    },
    clearSession: clearVexCloudSession,
  };
}
