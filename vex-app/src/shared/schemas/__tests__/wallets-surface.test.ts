/**
 * Façade surface lock for `shared/schemas/wallets.ts`.
 *
 * `wallets.ts` was structurally split into the `./wallets/*` sibling modules
 * (`base-chain`, `generate`, `import`, `restore`, `backup-archive`,
 * `inventory-export-all`, `export-private-key`, `session-available`,
 * `intent-action-dtos`) and now re-exports the IDENTICAL public surface. This
 * test pins that surface so a future structural change cannot silently drop,
 * rename, or re-type an export that the preload/renderer/main/shared-bridge
 * layers — and the sibling `schemas/api-keys.ts` (`evmAddressSchema`) — import
 * from the barrel path `@shared/schemas/wallets.js`.
 *
 * It asserts:
 *   - the EXACT set of 42 RUNTIME-VALUE export keys (no extras, none missing).
 *     In particular the PRIVATE `solanaAddressSchema` (single-sourced in
 *     `./wallets/base-chain.js`) must NOT leak through the barrel.
 *   - each runtime export is present with the expected `typeof`.
 *   - the 39 TYPE-only exports still compile when imported as types (they
 *     erase at runtime and are therefore NOT runtime export keys).
 */

import { describe, expect, it } from "vitest";
import * as wallets from "../wallets.js";

// ── Type-only surface: must compile (erases at runtime). Each alias pins that
// the public type export remains importable from the barrel. ───────────────
import type {
  WalletChain,
  WalletGenerateEvmResult,
  WalletGenerateSolanaResult,
  WalletImportEvmInput,
  WalletImportSolanaInput,
  WalletImportEvmResult,
  WalletImportSolanaResult,
  WalletRestoreInput,
  WalletRestoreResult,
  WalletListBackupsInput,
  WalletAvailableBackup,
  WalletListBackupsResult,
  WalletRestoreArchiveInput,
  WalletRestoredEntry,
  WalletRestoreArchiveResult,
  WalletAddInput,
  WalletImportAddInput,
  WalletAddResult,
  WalletExportAllInput,
  WalletExportAllResult,
  WalletOpenBackupFolderInput,
  WalletOpenBackupFolderResult,
  WalletExportPrivateKeyInput,
  WalletExportPrivateKeyResult,
  SelectedWalletDto,
  SessionWalletScopeDto,
  WalletsListSessionInput,
  WalletsSetScopeInput,
  WalletsListAvailableInput,
  AvailableWalletDto,
  AvailableWalletsDto,
  WalletIntentNetwork,
  WalletIntentStatus,
  WalletIntentPreview,
  PreparedIntentDto,
  WalletsGetPreparedIntentInput,
  WalletsCancelPreparedIntentInput,
  WalletsActionResult,
  WalletsSetScopeResult,
  WalletRemovalInput,
  WalletRecoveryInput,
  WalletRemovalResult,
  RemovedWallets,
} from "../wallets.js";

// Compile-only assertion: each name resolves to a usable type. `never` is
// assignable to every type, so this never executes — it only type-checks.
type _TypeSurface = [
  WalletChain,
  WalletGenerateEvmResult,
  WalletGenerateSolanaResult,
  WalletImportEvmInput,
  WalletImportSolanaInput,
  WalletImportEvmResult,
  WalletImportSolanaResult,
  WalletRestoreInput,
  WalletRestoreResult,
  WalletListBackupsInput,
  WalletAvailableBackup,
  WalletListBackupsResult,
  WalletRestoreArchiveInput,
  WalletRestoredEntry,
  WalletRestoreArchiveResult,
  WalletAddInput,
  WalletImportAddInput,
  WalletAddResult,
  WalletExportAllInput,
  WalletExportAllResult,
  WalletOpenBackupFolderInput,
  WalletOpenBackupFolderResult,
  WalletExportPrivateKeyInput,
  WalletExportPrivateKeyResult,
  SelectedWalletDto,
  SessionWalletScopeDto,
  WalletsListSessionInput,
  WalletsSetScopeInput,
  WalletsListAvailableInput,
  AvailableWalletDto,
  AvailableWalletsDto,
  WalletIntentNetwork,
  WalletIntentStatus,
  WalletIntentPreview,
  PreparedIntentDto,
  WalletsGetPreparedIntentInput,
  WalletsCancelPreparedIntentInput,
  WalletsActionResult,
  WalletsSetScopeResult,
  WalletRemovalInput,
  WalletRecoveryInput,
  WalletRemovalResult,
  RemovedWallets,
];
const _typeSurface = (value: never): _TypeSurface => value;
void _typeSurface;

// The 42 runtime-value exports (Zod schemas + the WALLET_INTENT_MAX_LIST
// const). Every one is an `object` at runtime EXCEPT the numeric const.
const EXPECTED_SCHEMA_EXPORTS = [
  "chainSchema",
  "evmAddressSchema",
  "walletGenerateInputSchema",
  "walletGenerateEvmResultSchema",
  "walletGenerateSolanaResultSchema",
  "walletImportEvmInputSchema",
  "walletImportSolanaInputSchema",
  "walletImportEvmResultSchema",
  "walletImportSolanaResultSchema",
  "walletRestoreInputSchema",
  "walletRestoreResultSchema",
  "walletListBackupsInputSchema",
  "walletAvailableBackupSchema",
  "walletListBackupsResultSchema",
  "walletRestoreArchiveInputSchema",
  "walletRestoredEntrySchema",
  "walletRestoreArchiveResultSchema",
  "walletAddInputSchema",
  "walletImportAddInputSchema",
  "walletAddResultSchema",
  "walletExportAllInputSchema",
  "walletExportAllResultSchema",
  "walletOpenBackupFolderInputSchema",
  "walletOpenBackupFolderResultSchema",
  "walletExportPrivateKeyInputSchema",
  "walletExportPrivateKeyResultSchema",
  "selectedWalletDtoSchema",
  "sessionWalletScopeDtoSchema",
  "walletsListSessionInputSchema",
  "walletsSetScopeInputSchema",
  "walletsListAvailableInputSchema",
  "availableWalletDtoSchema",
  "availableWalletsDtoSchema",
  "walletIntentNetworkSchema",
  "walletIntentStatusSchema",
  "walletIntentPreviewSchema",
  "preparedIntentDtoSchema",
  "walletsGetPreparedIntentInputSchema",
  "walletsCancelPreparedIntentInputSchema",
  "walletsActionResultSchema",
  "walletsSetScopeResultSchema",
  "walletRemovalInputSchema",
  "walletRecoveryInputSchema",
  "walletRemovalResultSchema",
  "removedWalletsSchema",
] as const;

const EXPECTED_CONST_EXPORTS = ["WALLET_INTENT_MAX_LIST"] as const;

const ALL_RUNTIME_EXPORTS = [
  ...EXPECTED_SCHEMA_EXPORTS,
  ...EXPECTED_CONST_EXPORTS,
];

describe("wallets schema façade surface", () => {
  it("exposes exactly the expected runtime export keys", () => {
    const runtimeKeys = Object.keys(wallets).sort();
    expect(runtimeKeys).toEqual([...ALL_RUNTIME_EXPORTS].sort());
  });

  it("exposes each Zod schema export as a parseable object", () => {
    for (const key of EXPECTED_SCHEMA_EXPORTS) {
      const schema = (wallets as Record<string, unknown>)[key];
      expect(typeof schema).toBe("object");
      expect(schema).not.toBeNull();
      // Every wallet schema is a Zod schema — `safeParse` is its runtime marker.
      expect(typeof (schema as { safeParse?: unknown }).safeParse).toBe(
        "function",
      );
    }
  });

  it("exposes WALLET_INTENT_MAX_LIST as the numeric cap 16", () => {
    expect(typeof wallets.WALLET_INTENT_MAX_LIST).toBe("number");
    expect(wallets.WALLET_INTENT_MAX_LIST).toBe(16);
  });

  it("does NOT leak the private solanaAddressSchema through the barrel", () => {
    expect(
      (wallets as Record<string, unknown>).solanaAddressSchema,
    ).toBeUndefined();
  });
});
