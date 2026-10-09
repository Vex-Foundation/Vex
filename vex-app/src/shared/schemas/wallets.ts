/**
 * Wallet schemas — Wizard Step 2 (M8) IPC boundary.
 *
 * Six channels live under `CH.onboarding.wallet*`:
 *   - walletGenerate{Evm,Solana}    — generate fresh keypair, encrypt with
 *                                     master password from M7
 *   - walletImport{Evm,Solana}      — accept user-supplied raw private key
 *                                     (EVM hex / Solana base58 or JSON array),
 *                                     encrypt + persist
 *   - walletRestoreFromBackup        — main opens dialog → user picks .json
 *                                     keystore → main decrypts + verifies +
 *                                     mismatch-confirms + atomic-restores
 *   - walletOpenBackupFolder        — open a previously-created backup dir
 *                                     in the OS file manager
 *
 * Design notes per codex turn 8:
 * - rawKey for import is a SECRET. The schema accepts it at the IPC boundary
 *   but the renderer MUST collect it via uncontrolled DOM ref + clear-on-submit
 *   and MUST NOT route it through TanStack `useMutation` (which can park the
 *   variables in observer/cache state — SKILL §14 "no secrets in renderer
 *   state/query cache").
 * - The generate/import result schemas intentionally do NOT carry a
 *   `backupDir` field. M8 refuses overwrite (no force flag), so a fresh
 *   generate/import never triggers `autoBackup()`. Restore is the only path
 *   that produces a backup directory and exposes it for "Open backup folder".
 * - User cancellation of the file picker (restore) maps to
 *   `err({code:"internal.cancelled"})` so the renderer can silently no-op
 *   instead of rendering an error.
 *
 * Façade/barrel: this module was structurally split into the `./wallets/*`
 * sibling modules and now re-exports the IDENTICAL public surface. The
 * PRIVATE `solanaAddressSchema` (single-sourced in `./wallets/base-chain.js`
 * for `./wallets/generate.js`) is deliberately NOT re-exported here — the
 * base-chain re-export is explicit (chainSchema, evmAddressSchema,
 * WalletChain) to preserve the exact original export set.
 */

export { chainSchema, evmAddressSchema } from "./wallets/base-chain.js";
export type { WalletChain } from "./wallets/base-chain.js";

export * from "./wallets/generate.js";
export * from "./wallets/import.js";
export * from "./wallets/restore.js";
export * from "./wallets/backup-archive.js";
export * from "./wallets/inventory-export-all.js";
export * from "./wallets/export-private-key.js";
export * from "./wallets/session-available.js";
export * from "./wallets/intent-action-dtos.js";

export * from "./wallets/removal.js";
