/**
 * Presence-only setup probes for `vex.onboarding.getEnvState()`.
 * MUST NOT decrypt keystores — codex turn 3 RED #3. Wallet status
 * collapses to `present | missing`, which is everything the System
 * Check screen needs.
 *
 * Wallet source of truth: the multi-wallet INVENTORY in `config.json`
 * (`wallet.evm[]` / `wallet.solana[]`), normalized via the engine's
 * `normalizeWalletSection` (key-free, viem-free). A family is `present`
 * iff it has a primary inventory entry AND that entry's keystore file
 * exists on disk; the displayed address is the primary entry's
 * `address`. The legacy single-wallet config (`wallet.address` /
 * `wallet.solanaAddress`) and the fixed `keystore.json` files are still
 * honored through the normalizer's legacy fallback. We do NOT key off
 * fixed-keystore-file existence anymore: that missed wallets created via
 * the inventory-add / full-archive-restore paths (per-id
 * `wallet-<id>.json` keystores), which left walletAddresses null and
 * blocked finalize even though wallets existed.
 *
 * M9: extends the shape with per-API-key status (jupiter / tavily /
 * rettiwt) + embeddings.allFieldsConfigured + embeddings.dbReachable.
 * The legacy `hasJupiterApiKey` field stays
 * as a deprecated mirror of `apiKeys.jupiterConfigured` so M2/M7
 * callers keep parsing without changes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  ENV_FILE,
  SETUP_COMPLETE_FILE,
} from "../paths/config-dir.js";
import type {
  EnvState,
  ProviderState,
  WalletAddresses,
  WalletPresence,
} from "@shared/schemas/onboarding.js";
import {
  normalizeWalletSection,
  type WalletInventoryEntry,
} from "@config/store.js";
import { log } from "../logger/index.js";
import { probeEmbeddings } from "./embedding-state.js";
import { probeProvider } from "./provider-state.js";
import { getUnlockedSecretPresence } from "../secrets/session.js";
import {
  hasUnlockedLighterTradingCredential,
  listUnlockedManagedLighterTradingCredentialScopes,
} from "../secrets/lighter-trading-credential.js";

// Fixed-keystore filenames for legacy (pre multi-wallet) primary entries.
// Non-legacy inventory entries use `wallet-<id>.json` (see primaryKeystoreFile).
const EVM_LEGACY_KEYSTORE_FILE = "keystore.json";
const SOLANA_LEGACY_KEYSTORE_FILE = "solana-keystore.json";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function readEnvKeyPresence(
  envPath: string,
  key: string
): Promise<boolean> {
  try {
    const content = await fs.readFile(envPath, "utf8");
    const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*\\S`, "m");
    return re.test(content);
  } catch {
    return false;
  }
}

export async function readEnvValue(
  envPath: string,
  key: string
): Promise<string | null> {
  try {
    const content = await fs.readFile(envPath, "utf8");
    const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+)$`, "m");
    const match = re.exec(content);
    if (!match) return null;
    let value = (match[1] ?? "").trim();
    value = value.replace(/^["']/, "").replace(/["']$/, "");
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function redactEmbeddingUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Normalized multi-wallet inventory from `config.json` — the AUTHORITATIVE
 * source for which wallets exist (`wallet.evm[]` / `wallet.solana[]`).
 *
 * Reuses the engine's `normalizeWalletSection` so this probe applies the
 * EXACT same precedence (inventory arrays win over legacy scalars — all or
 * nothing, never per-field) and malformed/invalid-row dropping that
 * `loadConfig()` does. env-state must never report a wallet the real
 * inventory would reject (codex harness Q2). `normalizeWalletSection` is
 * pure + viem-free (it lives in `@config/store`, off the signing-capable
 * `@vex-lib/wallet` barrel), so the probe stays key-free and never drags
 * `viem/accounts` into this path (codex turn 3 RED #3 still honored).
 *
 * Missing file (expected first-run) collapses silently to an empty
 * inventory; malformed JSON / read errors warn and also collapse to empty.
 */
async function gatherWalletInventory(
  configFile: string = CONFIG_FILE,
): Promise<{ evm: WalletInventoryEntry[]; solana: WalletInventoryEntry[] }> {
  try {
    const raw = await fs.readFile(configFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const walletSection =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { wallet?: unknown }).wallet
        : undefined;
    return normalizeWalletSection(walletSection);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return { evm: [], solana: [] };
    }
    log.warn("[env-state] gatherWalletInventory failed", cause);
    return { evm: [], solana: [] };
  }
}

/**
 * Resolve the on-disk keystore filename for a primary inventory entry,
 * mirroring `tools/wallet/inventory.ts derivePath` (the canonical rule):
 *   - legacy entry  → the fixed family keystore file (`keystore.json` /
 *                     `solana-keystore.json`);
 *   - otherwise     → `wallet-<id>.json` under CONFIG_DIR.
 * The id was already validated by `normalizeWalletSection` (isValidWalletId
 * drops non-canonical rows), so it cannot contain `/`, `\` or `.` and can
 * never escape CONFIG_DIR. Key-free: filename rule only, no crypto.
 */
function primaryKeystoreFile(
  configDir: string,
  family: "evm" | "solana",
  entry: WalletInventoryEntry,
): string {
  if (entry.legacy === true) {
    return path.join(
      configDir,
      family === "solana"
        ? SOLANA_LEGACY_KEYSTORE_FILE
        : EVM_LEGACY_KEYSTORE_FILE,
    );
  }
  return path.join(configDir, `wallet-${entry.id}.json`);
}

/**
 * A family is `present` iff it has a primary inventory entry AND that
 * entry's keystore file exists on disk. The inventory is authoritative for
 * which wallets exist; the file check additionally catches config/file
 * drift (a config row whose keystore was deleted) so finalize never marks
 * setup complete on a wallet that cannot sign. Stays presence-only — no
 * decryption (codex turn 3 RED #3 / harness Q2).
 */
async function familyPresent(
  configDir: string,
  family: "evm" | "solana",
  entry: WalletInventoryEntry | undefined,
): Promise<boolean> {
  if (!entry) return false;
  return fileExists(primaryKeystoreFile(configDir, family, entry));
}

export interface WalletProbe {
  readonly addresses: WalletAddresses;
  readonly status: { readonly evm: WalletPresence; readonly solana: WalletPresence };
}

/**
 * Single inventory read → both the displayed primary addresses and the
 * presence status, derived from the same source so address and status can
 * never disagree. `configDir` is injectable for tests; production passes
 * the shared CONFIG_DIR where both `config.json` and the keystore files
 * live.
 */
export async function gatherWalletProbe(
  configFile: string = CONFIG_FILE,
  configDir: string = CONFIG_DIR,
): Promise<WalletProbe> {
  const inventory = await gatherWalletInventory(configFile);
  const [evmPresent, solanaPresent] = await Promise.all([
    familyPresent(configDir, "evm", inventory.evm[0]),
    familyPresent(configDir, "solana", inventory.solana[0]),
  ]);
  return {
    addresses: {
      evm: inventory.evm[0]?.address ?? null,
      solana: inventory.solana[0]?.address ?? null,
    },
    status: {
      evm: evmPresent ? "present" : "missing",
      solana: solanaPresent ? "present" : "missing",
    },
  };
}

export async function gatherEnvState(): Promise<EnvState> {
  const secretPresence = getUnlockedSecretPresence();
  const [
    wallets,
    setupFlag,
    embeddings,
    provider,
  ] = await Promise.all([
    gatherWalletProbe(),
    fileExists(SETUP_COMPLETE_FILE),
    probeEmbeddings(ENV_FILE),
    probeProvider(ENV_FILE),
  ]);
  const hasPwd = secretPresence.vaultConfigured;
  const hasJupiter = secretPresence.secrets.JUPITER_API_KEY === true;
  const hasTavily = secretPresence.secrets.TAVILY_API_KEY === true;
  const hasRettiwt = secretPresence.secrets.RETTIWT_API_KEY === true;
  const hasRelay = secretPresence.secrets.RELAY_API_KEY === true;
  const hasLighterCoreTrading = hasUnlockedLighterTradingCredential("core");
  const hasLighterRhcTrading = hasUnlockedLighterTradingCredential("rhc");
  const lighterCoreManagedTradingScopes =
    listUnlockedManagedLighterTradingCredentialScopes("core").map((scope) => ({
      accountIndex: scope.accountIndex,
      apiKeyIndex: scope.apiKeyIndex,
    }));
  const lighterRhcManagedTradingScopes =
    listUnlockedManagedLighterTradingCredentialScopes("rhc").map((scope) => ({
      accountIndex: scope.accountIndex,
      apiKeyIndex: scope.apiKeyIndex,
    }));

  return {
    hasKeystorePassword: hasPwd,
    hasJupiterApiKey: hasJupiter,
    apiKeys: {
      jupiterConfigured: hasJupiter,
      tavilyConfigured: hasTavily,
      rettiwtConfigured: hasRettiwt,
      relayConfigured: hasRelay,
      lighterCoreTradingConfigured: hasLighterCoreTrading,
      lighterRhcTradingConfigured: hasLighterRhcTrading,
      lighterCoreManagedTradingScopes,
      lighterRhcManagedTradingScopes,
    },
    secrets: {
      vaultConfigured: secretPresence.vaultConfigured,
      unlocked: secretPresence.unlocked,
    },
    embeddings,
    walletStatus: wallets.status,
    walletAddresses: wallets.addresses,
    provider,
    setupCompleteFlag: setupFlag,
  };
}

// Re-export ProviderState for downstream typing convenience.
export type { ProviderState };
