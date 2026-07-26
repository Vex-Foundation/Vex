import { CH } from "../../shared/ipc/channels.js";
import { apiKeysSetInputSchema } from "../../shared/schemas/api-keys.js";
import type { ApiKeysSetInput } from "../../shared/schemas/api-keys.js";
import { agentCoreConfigureInputSchema } from "../../shared/schemas/agent-core.js";
import type { AgentCoreConfigureInput } from "../../shared/schemas/agent-core.js";
import { embeddingConfigureInputSchema } from "../../shared/schemas/embedding.js";
import type { EmbeddingConfigureInput } from "../../shared/schemas/embedding.js";
import { completeSetupInputSchema } from "../../shared/schemas/finalize.js";
import type { CompleteSetupInput } from "../../shared/schemas/finalize.js";
import {
  providerListModelsInputSchema,
  providerPersistInputSchema,
} from "../../shared/schemas/provider.js";
import type {
  ProviderListModelsInput,
  ProviderPersistInput,
} from "../../shared/schemas/provider.js";
import {
  walletAddInputSchema,
  walletExportAllInputSchema,
  walletGenerateInputSchema,
  walletImportAddInputSchema,
  walletImportEvmInputSchema,
  walletImportSolanaInputSchema,
  walletListBackupsInputSchema,
  walletOpenBackupFolderInputSchema,
  walletRestoreArchiveInputSchema,
  walletRestoreInputSchema,
} from "../../shared/schemas/wallets.js";
import type {
  WalletAddInput,
  WalletExportAllInput,
  WalletImportAddInput,
  WalletImportEvmInput,
  WalletImportSolanaInput,
  WalletOpenBackupFolderInput,
  WalletRestoreInput,
} from "../../shared/schemas/wallets.js";
import {
  keystoreSetInputSchema,
  setWizardStateInputSchema,
} from "../../shared/schemas/wizard.js";
import type {
  KeystoreSetInput,
  SetWizardStateInput,
} from "../../shared/schemas/wizard.js";
import type { OnboardingBridge } from "../../shared/types/bridge/shell/onboarding.js";
import { invokeWithSchema } from "../_dispatch.js";

export const onboarding = {
  getEnvState() {
    return invokeWithSchema(CH.onboarding.getEnvState, {});
  },
  getWizardState() {
    return invokeWithSchema(CH.onboarding.getWizardState, {});
  },
  setWizardState(input: SetWizardStateInput) {
    return invokeWithSchema(
      CH.onboarding.setWizardState,
      input,
      setWizardStateInputSchema
    );
  },
  keystoreSet(input: KeystoreSetInput) {
    return invokeWithSchema(
      CH.onboarding.keystoreSet,
      input,
      keystoreSetInputSchema
    );
  },
  walletGenerateEvm() {
    return invokeWithSchema(
      CH.onboarding.walletGenerateEvm,
      {},
      walletGenerateInputSchema
    );
  },
  walletGenerateSolana() {
    return invokeWithSchema(
      CH.onboarding.walletGenerateSolana,
      {},
      walletGenerateInputSchema
    );
  },
  walletImportEvm(input: WalletImportEvmInput) {
    return invokeWithSchema(
      CH.onboarding.walletImportEvm,
      input,
      walletImportEvmInputSchema
    );
  },
  walletImportSolana(input: WalletImportSolanaInput) {
    return invokeWithSchema(
      CH.onboarding.walletImportSolana,
      input,
      walletImportSolanaInputSchema
    );
  },
  walletRestoreFromBackup(input: WalletRestoreInput) {
    return invokeWithSchema(
      CH.onboarding.walletRestoreFromBackup,
      input,
      walletRestoreInputSchema
    );
  },
  listBackups() {
    return invokeWithSchema(
      CH.onboarding.walletListBackups,
      {},
      walletListBackupsInputSchema
    );
  },
  restoreArchive(id: string, password: string) {
    return invokeWithSchema(
      CH.onboarding.walletRestoreArchive,
      { id, password },
      walletRestoreArchiveInputSchema
    );
  },
  walletOpenBackupFolder(input: WalletOpenBackupFolderInput) {
    return invokeWithSchema(
      CH.onboarding.walletOpenBackupFolder,
      input,
      walletOpenBackupFolderInputSchema
    );
  },
  walletAddEvm(input: WalletAddInput) {
    return invokeWithSchema(
      CH.onboarding.walletAddEvm,
      input,
      walletAddInputSchema
    );
  },
  walletAddSolana(input: WalletAddInput) {
    return invokeWithSchema(
      CH.onboarding.walletAddSolana,
      input,
      walletAddInputSchema
    );
  },
  walletImportAddEvm(input: WalletImportAddInput) {
    return invokeWithSchema(
      CH.onboarding.walletImportAddEvm,
      input,
      walletImportAddInputSchema
    );
  },
  walletImportAddSolana(input: WalletImportAddInput) {
    return invokeWithSchema(
      CH.onboarding.walletImportAddSolana,
      input,
      walletImportAddInputSchema
    );
  },
  walletExportAll(input: WalletExportAllInput) {
    return invokeWithSchema(
      CH.onboarding.walletExportAll,
      input,
      walletExportAllInputSchema
    );
  },
  apiKeysSet(input: ApiKeysSetInput) {
    return invokeWithSchema(
      CH.onboarding.apiKeysSet,
      input,
      apiKeysSetInputSchema
    );
  },
  embeddingConfigure(input: EmbeddingConfigureInput) {
    return invokeWithSchema(
      CH.onboarding.embeddingConfigure,
      input,
      embeddingConfigureInputSchema
    );
  },
  agentCoreConfigure(input: AgentCoreConfigureInput) {
    return invokeWithSchema(
      CH.onboarding.agentCoreConfigure,
      input,
      agentCoreConfigureInputSchema
    );
  },
  providerPersist(input: ProviderPersistInput) {
    return invokeWithSchema(
      CH.onboarding.providerPersist,
      input,
      providerPersistInputSchema
    );
  },
  providerListModels(input: ProviderListModelsInput = {}) {
    return invokeWithSchema(
      CH.onboarding.providerListModels,
      input,
      providerListModelsInputSchema
    );
  },
  completeSetup(input: CompleteSetupInput) {
    return invokeWithSchema(
      CH.onboarding.completeSetup,
      input,
      completeSetupInputSchema
    );
  },
} satisfies OnboardingBridge;
