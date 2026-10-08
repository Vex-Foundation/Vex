import type { Result } from "../../../ipc/result.js";
import type {
  SecretsLockResult,
  SecretsStatus,
  SecretsUnlockInput,
  SecretsUnlockResult,
  ResetToFreshVaultInput,
  ResetToFreshVaultResult,
} from "../../../schemas/secrets.js";

export interface SecretsBridge {
  /** Empty, validated native menu request; the renderer uses the normal lock IPC. */
  readonly onLockRequested: (callback: () => void) => () => void;
  readonly status: () => Promise<Result<SecretsStatus>>;
  readonly unlock: (
    input: SecretsUnlockInput
  ) => Promise<Result<SecretsUnlockResult>>;
  readonly lock: () => Promise<Result<SecretsLockResult>>;
  readonly resetToFreshVault: (
    input: ResetToFreshVaultInput,
  ) => Promise<Result<ResetToFreshVaultResult>>;
}
