/**
 * The production wiring of the Vex Cloud owner: the real HTTP client, the
 * wallet inventory, the vault-backed session store, the template signer and,
 * for deposits, Robinhood Chain and the vault-held key.
 * One place, so the sign-in handler, the account handler and the provider
 * persist path cannot reach the world through different seams.
 */

import { getAddress } from "viem";
import { listWallets } from "@vex-lib/wallet.js";
import { vexCloudSiweBinding } from "@vex-lib/vex-cloud-endpoint.js";
import { resolveVexCloudDepositAddress } from "@vex-lib/vex-cloud-deposit-address.js";
import { signVexCloudSiweMessage } from "@tools/wallet/siwe-signing.js";
import type { Result } from "@shared/ipc/result.js";
import { loadEvmKey } from "@tools/wallet/inventory.js";
import { isExecutionGateOpen } from "../lifecycle/execution-gate.js";
import { isSecretSessionUnlocked } from "../secrets/session.js";
import {
  createErc20TransferPort,
  pinnedTransferChainClients,
  type Erc20TransferPort,
} from "@tools/evm-chains/erc20-transfer-port.js";
import { VEX_CLOUD_CHAIN_ID, VEX_TOKEN_ADDRESS } from "@shared/vex-cloud-money.js";
import type { DepositDeps } from "./funding/deposit-core.js";
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
  /** The deposit owner's reach beyond the HTTP client and the session. */
  readonly deposit: Omit<DepositDeps, "api" | "readSession" | "clearSession">;
}

/** One chain port per process, built on first use (it resolves the RPC endpoints). */
let depositChain: Erc20TransferPort | null = null;
function productionDepositChain(): Erc20TransferPort {
  depositChain ??= createErc20TransferPort(pinnedTransferChainClients(VEX_CLOUD_CHAIN_ID), VEX_TOKEN_ADDRESS);
  return depositChain;
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
      pinnedDepositAddress: () => resolveVexCloudDepositAddress(),
      now: () => new Date(),
    },
    clearSession: clearVexCloudSession,
    deposit: {
      chain: productionDepositChain,
      listEvmWallets: () => listWallets("evm"),
      isVaultUnlocked: isSecretSessionUnlocked,
      isExecutionReady: isExecutionGateOpen,
      pinnedDepositAddress: () => resolveVexCloudDepositAddress(),
      loadPrivateKey: async (entry) => (await loadEvmKey(entry)).privateKey,
      now: () => new Date(),
    },
  };
}
