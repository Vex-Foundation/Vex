import type { Result } from "../../../ipc/result.js";
import type { EnvState } from "../../../schemas/onboarding.js";
import type {
  KeystoreSetInput,
  KeystoreSetResult,
  SetWizardStateInput,
  WizardState,
} from "../../../schemas/wizard.js";
import type {
  WalletAddInput,
  WalletAddResult,
  WalletExportAllInput,
  WalletExportAllResult,
  WalletGenerateEvmResult,
  WalletGenerateSolanaResult,
  WalletImportAddInput,
  WalletImportEvmInput,
  WalletImportEvmResult,
  WalletImportSolanaInput,
  WalletImportSolanaResult,
  WalletListBackupsResult,
  WalletOpenBackupFolderInput,
  WalletOpenBackupFolderResult,
  WalletRestoreArchiveResult,
  WalletRestoreInput,
  WalletRestoreResult,
} from "../../../schemas/wallets.js";
import type {
  ApiKeysSetInput,
  ApiKeysSetResult,
  PolymarketAutoSetupInput,
  PolymarketAutoSetupResult,
  PolymarketConfiguredAddressesResult,
} from "../../../schemas/api-keys.js";
import type {
  EmbeddingConfigureInput,
  EmbeddingConfigureResult,
} from "../../../schemas/embedding.js";
import type {
  AgentCoreConfigureInput,
  AgentCoreConfigureResult,
} from "../../../schemas/agent-core.js";
import type {
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderPersistInput,
  ProviderPersistResult,
} from "../../../schemas/provider.js";
import type {
  CompleteSetupInput,
  CompleteSetupResult,
} from "../../../schemas/finalize.js";

export interface OnboardingBridge {
  readonly getEnvState: () => Promise<Result<EnvState>>;
  readonly getWizardState: () => Promise<Result<WizardState>>;
  readonly setWizardState: (
    input: SetWizardStateInput
  ) => Promise<Result<WizardState>>;
  readonly keystoreSet: (
    input: KeystoreSetInput
  ) => Promise<Result<KeystoreSetResult>>;
  readonly walletGenerateEvm: () => Promise<Result<WalletGenerateEvmResult>>;
  readonly walletGenerateSolana: () => Promise<Result<WalletGenerateSolanaResult>>;
  readonly walletImportEvm: (
    input: WalletImportEvmInput
  ) => Promise<Result<WalletImportEvmResult>>;
  readonly walletImportSolana: (
    input: WalletImportSolanaInput
  ) => Promise<Result<WalletImportSolanaResult>>;
  readonly walletRestoreFromBackup: (
    input: WalletRestoreInput
  ) => Promise<Result<WalletRestoreResult>>;
  /**
   * Full-archive restore (C2). `listBackups` returns metadata only (opaque
   * backup ids, public addresses — no secrets, no absolute paths).
   * `restoreArchive` takes the opaque `id` + master password; main resolves
   * the id under BACKUPS_DIR, restores the whole archive (wallets + vault +
   * .env), and refreshes the process runtime. The result carries no key
   * material and no absolute path.
   */
  readonly listBackups: () => Promise<Result<WalletListBackupsResult>>;
  readonly restoreArchive: (
    id: string,
    password: string
  ) => Promise<Result<WalletRestoreArchiveResult>>;
  readonly walletOpenBackupFolder: (
    input: WalletOpenBackupFolderInput
  ) => Promise<Result<WalletOpenBackupFolderResult>>;
  // Multi-wallet inventory (puzzle 5 phase 5D) — append ≤3/family + export all.
  readonly walletAddEvm: (
    input: WalletAddInput
  ) => Promise<Result<WalletAddResult>>;
  readonly walletAddSolana: (
    input: WalletAddInput
  ) => Promise<Result<WalletAddResult>>;
  readonly walletImportAddEvm: (
    input: WalletImportAddInput
  ) => Promise<Result<WalletAddResult>>;
  readonly walletImportAddSolana: (
    input: WalletImportAddInput
  ) => Promise<Result<WalletAddResult>>;
  readonly walletExportAll: (
    input: WalletExportAllInput
  ) => Promise<Result<WalletExportAllResult>>;
  readonly apiKeysSet: (
    input: ApiKeysSetInput
  ) => Promise<Result<ApiKeysSetResult>>;
  /**
   * One-click Polymarket setup (Phase 2 feature #7). Derives CLOB API
   * credentials from the unlocked EVM wallet keystore via the engine
   * primitive, persists them inside the encrypted secret vault, and
   * returns the wallet address. Result does NOT carry credentials —
   * the renderer reads canonical envState for confirmation.
   */
  readonly polymarketAutoSetup: (
    input: PolymarketAutoSetupInput
  ) => Promise<Result<PolymarketAutoSetupResult>>;
  /**
   * Lowercased EVM addresses that currently have Polymarket CLOB credentials
   * in the vault (puzzle 5 B-UI). Drives the per-wallet ✓ configured / ◦ not
   * badge in the wallet picker. Returns PUBLIC ADDRESSES ONLY.
   */
  readonly polymarketConfiguredAddresses: () => Promise<
    Result<PolymarketConfiguredAddressesResult>
  >;
  readonly embeddingConfigure: (
    input: EmbeddingConfigureInput
  ) => Promise<Result<EmbeddingConfigureResult>>;
  readonly agentCoreConfigure: (
    input: AgentCoreConfigureInput
  ) => Promise<Result<AgentCoreConfigureResult>>;
  readonly providerPersist: (
    input: ProviderPersistInput
  ) => Promise<Result<ProviderPersistResult>>;
  readonly providerListModels: (
    input?: ProviderListModelsInput
  ) => Promise<Result<ProviderListModelsResult>>;
  readonly completeSetup: (
    input: CompleteSetupInput
  ) => Promise<Result<CompleteSetupResult>>;
}
