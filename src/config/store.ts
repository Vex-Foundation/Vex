import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CHAIN } from "../constants/chain.js";
import { CONFIG_DIR, CONFIG_FILE } from "./paths.js";
import { minLogger as logger } from "../utils/logger-shim.js";

/**
 * One wallet in the per-family inventory (puzzle 5 stage 1, multi-wallet).
 * Private key material lives in a keystore FILE, never in config:
 *   - `legacy: true` → the pre-multi-wallet fixed keystore (KEYSTORE_FILE /
 *     SOLANA_KEYSTORE_FILE); reserved id `evm_legacy` / `sol_legacy`.
 *   - otherwise → a per-id file derived from `id` under CONFIG_DIR
 *     (see tools/wallet/inventory.ts `derivePath`).
 * `address` is the on-chain identity every financial table keys on.
 */
export interface WalletInventoryEntry {
  id: string;
  address: string;
  label: string;
  createdAt: string;
  // `| undefined` keeps this assignable from Zod `.optional()` outputs
  // under vex-app's exactOptionalPropertyTypes profile (root tsc treats
  // both spellings identically).
  legacy?: boolean | undefined;
}

const WALLET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Family-bound, legacy-aware wallet id validation — the single source of truth
 * for config normalization (drop non-canonical rows) and `derivePath` (refuse
 * to build a keystore path for an id that isn't canonical for its family +
 * legacy flag). Also the path-traversal guard: a non-legacy id must be
 * `<prefix>_<uuid>`, so no `/`, `\` or `.` can reach the derived filename.
 *   - legacy === true → exactly `evm_legacy` (EVM) / `sol_legacy` (Solana).
 *   - legacy !== true → `<prefix>_<uuid>` with the prefix matching the family.
 */
export function isValidWalletId(family: "evm" | "solana", id: string, legacy: boolean): boolean {
  const prefix = family === "solana" ? "sol" : "evm";
  if (legacy) return id === `${prefix}_legacy`;
  if (!id.startsWith(`${prefix}_`)) return false;
  return WALLET_UUID.test(id.slice(prefix.length + 1));
}

const walletInventoryEntrySchema = z.object({
  id: z.string().min(1).max(80),
  address: z.string().min(1).max(128),
  label: z.string().max(120),
  createdAt: z.string(),
  legacy: z.boolean().optional(),
});

/** Deterministic timestamp for synthesized legacy entries (avoids per-load drift). */
const LEGACY_CREATED_AT = new Date(0).toISOString();

export interface VexConfig {
  version: 1;
  chain: {
    chainId: number;
    name: string;
    rpcUrl: string;
    explorerUrl: string;
    nativeCurrency: {
      name: string;
      symbol: string;
      decimals: number;
    };
  };
  wallet: {
    evm: WalletInventoryEntry[];
    solana: WalletInventoryEntry[];
  };
  services: {
    khalaniApiUrl: string;
    relayApiUrl: string;
    dexScreenerApiUrl: string;
    trenchExpressApiUrl: string;
    trenchExpressTestnetApiUrl: string;
    poolsFunApiUrl: string;
    virtualsApiUrl: string;
    pendleApiUrl: string;
    morphoApiUrl: string;
    kyberswapAggregatorUrl: string;
    kyberswapTokenApiUrl: string;
    kyberswapCommonServiceUrl: string;
    // AgentScan ingest base URL (public activity explorer). Empty = reporting
    // fully off — dark until the AgentScan domain is decided; the deep-merge in
    // loadConfig() fills the key for existing installs when a default lands.
    agentscanApiUrl: string;
    // pools.fun VEX-badge attestation base URL. Empty = the lane is fully dark
    // - the partner endpoint is not live yet, so it ships with no default at
    // all, exactly like agentscanApiUrl. The URL resolver in
    // sync/pools-attribution-production-deps.ts refuses an empty, malformed or
    // insecure value before any row is claimed, and the deep-merge in
    // loadConfig() fills the key for existing installs when a real default
    // lands (see dropEmptyPoolsFunAttestApiUrl).
    poolsFunAttestApiUrl: string;
  };
  solana: {
    cluster: "mainnet-beta" | "devnet" | "testnet" | "custom";
    rpcUrl: string;
    explorerUrl: string;
    commitment: string;
    jupiterApiKey: string;
  };
  // Optional members carry `| undefined` so parsed-config spreads remain
  // assignable under vex-app's exactOptionalPropertyTypes profile.
  claude?: {
    provider: string;
    model: string;
    providerEndpoint: string;
    proxyPort: number;
  } | undefined;
  // Optional user RPC overrides for local (non-Khalani) EVM chains, keyed by
  // chainId string (e.g. "4663"). User-supplied endpoint URL only — never a
  // bundled key. Absent by default; consumed by src/tools/evm-chains/registry.ts.
  localChainRpcUrls?: Record<string, string> | undefined;
  // Optional user RPC overrides for Pendle chains, keyed by chainId string
  // (e.g. "42161"). User-supplied endpoint URL only — never a bundled key.
  // Absent by default; the bundled default RPC (per the Pendle chain registry)
  // wins otherwise. Consumed by src/tools/pendle/evm-client.ts.
  pendleRpcUrls?: Record<string, string> | undefined;
  /**
   * Master switch for the pools.fun VEX-badge attestation lane. `false` (the
   * default) means the launch handler produces NO signature, writes NO
   * attestation column, sends NO HTTP and logs NOTHING for this lane, and the
   * sweep claims no rows.
   *
   * FAIL CLOSED, STRICTLY. This is the only flag in this file that gates a
   * SIGNING operation, so it is parsed after the raw config spread and only a
   * real JSON `true` enables it. A stored string `"true"`, a `1`, or any other
   * truthy shape leaves it `false` - see `parsePoolsFunAttestationEnabled`.
   */
  poolsFunAttestationEnabled: boolean;
}

/**
 * Strict boolean parse for the one config flag that authorizes a signature.
 *
 * `loadConfig` spreads the parsed file over the defaults, so WITHOUT this the
 * disk value would reach the flag unvalidated and a hand-edited or migrated
 * `"true"` string would read as truthy at every call site. The gate is
 * therefore re-derived from the raw value AFTER the spread: anything that is
 * not the boolean `true` is `false`.
 */
export function parsePoolsFunAttestationEnabled(raw: unknown): boolean {
  return raw === true;
}

/**
 * The runtime gate every pools-attestation call site asks. Lives HERE, next to
 * the strict parse, so the signing leg and the delivery sweep cannot drift to
 * different answers about whether the lane is on.
 */
export function poolsAttestationEnabled(): boolean {
  return loadConfig().poolsFunAttestationEnabled === true;
}

export function getDefaultConfig(): VexConfig {
  return {
    version: 1,
    chain: {
      chainId: CHAIN.chainId,
      name: CHAIN.name,
      rpcUrl: CHAIN.rpc,
      explorerUrl: CHAIN.explorer,
      nativeCurrency: CHAIN.nativeCurrency,
    },
    wallet: {
      evm: [],
      solana: [],
    },
    solana: {
      cluster: "mainnet-beta" as const,
      rpcUrl: "https://api.mainnet-beta.solana.com",
      explorerUrl: "https://explorer.solana.com",
      commitment: "confirmed",
      jupiterApiKey: "",
    },
    services: {
      khalaniApiUrl: "https://api.hyperstream.dev",
      relayApiUrl: "https://api.relay.link",
      dexScreenerApiUrl: "https://api.dexscreener.com",
      trenchExpressApiUrl: "https://api.trench.express",
      trenchExpressTestnetApiUrl: "https://api-testnet.trench.express",
      poolsFunApiUrl: "https://api.bankr.bot",
      virtualsApiUrl: "https://api.virtuals.io",
      pendleApiUrl: "https://api-v2.pendle.finance/core",
      // Morpho's keyless GraphQL endpoint. No API key exists, so no
      // `requiresEnv` gates the morpho tools (Relay precedent: an optional key
      // in requiresEnv hides tools from users who never needed one).
      morphoApiUrl: "https://api.morpho.org/graphql",
      kyberswapAggregatorUrl: "https://aggregator-api.kyberswap.com",
      kyberswapTokenApiUrl: "https://token-api.kyberswap.com",
      kyberswapCommonServiceUrl: "https://common-service.kyberswap.com",
      agentscanApiUrl: "https://agentscan.projectvex.ai",
      // SHIPS DARK: no partner endpoint exists yet, so there is nothing safe to
      // point at. The resolver treats "" as "lane off" and claims no rows.
      poolsFunAttestApiUrl: "",
    },
    // SHIPS OFF. The lane signs with the launching wallet, so it stays disabled
    // until it is deliberately turned on.
    poolsFunAttestationEnabled: false,
  };
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    logger.debug(`Created config directory: ${CONFIG_DIR}`);
  }
}

/**
 * Validate an optional chainId-string → RPC-URL override map (used by both
 * `localChainRpcUrls` and `pendleRpcUrls`). Untrusted config input: keep only
 * string→string entries. The consuming registry additionally validates each URL
 * shape before use.
 */
function parseChainRpcUrls(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A stored `agentscanApiUrl` that is empty (or whitespace-only) must never
 * shadow a future non-empty default — the lane stays dark until that default
 * lands, and an existing install's persisted `""` would otherwise pin it dark
 * forever. Dropping the key lets the defaults spread underneath it win.
 */
export function dropEmptyAgentscanApiUrl(
  services: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return dropEmptyDarkServiceUrl(services, "agentscanApiUrl");
}

/**
 * Every ships-dark service URL in this config obeys the same rule as
 * `agentscanApiUrl` above, so the mechanism lives once and the named wrappers
 * say which key each lane owns.
 */
function dropEmptyDarkServiceUrl(
  services: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  if (!services) return {};
  const raw = services[key];
  if (typeof raw !== "string" || raw.trim().length > 0) return services;
  const { [key]: _empty, ...rest } = services;
  return rest;
}

/**
 * The same rule for the pools.fun attestation base URL: the partner endpoint is
 * not live yet, so an install that persisted `""` today must not be pinned dark
 * once a real default ships.
 */
export function dropEmptyPoolsFunAttestApiUrl(
  services: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return dropEmptyDarkServiceUrl(services, "poolsFunAttestApiUrl");
}

function parseClaudeConfig(raw: unknown): VexConfig["claude"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.provider !== "string"
    || typeof candidate.model !== "string"
    || typeof candidate.providerEndpoint !== "string"
    || typeof candidate.proxyPort !== "number"
  ) {
    return undefined;
  }

  return {
    provider: candidate.provider,
    model: candidate.model,
    providerEndpoint: candidate.providerEndpoint,
    proxyPort: candidate.proxyPort,
  };
}

/**
 * Normalize the persisted `wallet` section into the per-family inventory.
 *
 * Shapes accepted:
 *   - new: `{ evm: WalletInventoryEntry[], solana: WalletInventoryEntry[] }`
 *   - legacy (pre multi-wallet): `{ address, solanaAddress }` → synthesized
 *     into reserved `*_legacy` entries pointing at the fixed keystore files.
 *     Read-once: never written back as authoritative fields (saveConfig only
 *     persists the arrays).
 *   - missing/garbage → empty inventory.
 *
 * Malformed array entries are dropped with a warning instead of throwing, so a
 * single corrupt row cannot brick config load; the keystore file survives and
 * the wallet can be re-imported.
 */
export function normalizeWalletSection(raw: unknown): VexConfig["wallet"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { evm: [], solana: [] };
  }
  const obj = raw as Record<string, unknown>;

  // New shape wins when either array is present.
  if (Array.isArray(obj.evm) || Array.isArray(obj.solana)) {
    return {
      evm: parseEntryArray(obj.evm, "evm"),
      solana: parseEntryArray(obj.solana, "solana"),
    };
  }

  // Legacy single-wallet shape → reserved legacy entries (fixed keystore).
  const evm: WalletInventoryEntry[] = [];
  const solana: WalletInventoryEntry[] = [];
  if (typeof obj.address === "string" && obj.address.length > 0) {
    evm.push({ id: "evm_legacy", address: obj.address, label: "Primary", createdAt: LEGACY_CREATED_AT, legacy: true });
  }
  if (typeof obj.solanaAddress === "string" && obj.solanaAddress.length > 0) {
    solana.push({ id: "sol_legacy", address: obj.solanaAddress, label: "Primary", createdAt: LEGACY_CREATED_AT, legacy: true });
  }
  return { evm, solana };
}

function parseEntryArray(raw: unknown, family: "evm" | "solana"): WalletInventoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WalletInventoryEntry[] = [];
  for (const item of raw) {
    const parsed = walletInventoryEntrySchema.safeParse(item);
    if (!parsed.success) {
      logger.warn(`Dropping malformed ${family} wallet inventory entry`);
      continue;
    }
    if (!isValidWalletId(family, parsed.data.id, parsed.data.legacy === true)) {
      // Cross-family, reserved-as-non-legacy, or non-canonical id — drop it
      // rather than let a bad row reach derivePath.
      logger.warn(`Dropping ${family} wallet inventory entry with non-canonical id`);
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

export function loadConfig(): VexConfig {
  ensureConfigDir();
  const defaults = getDefaultConfig();

  if (!existsSync(CONFIG_FILE)) {
    logger.debug("Config file not found, using defaults");
    return defaults;
  }

  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Validate version
    if (parsed.version !== 1) {
      logger.warn(`Unknown config version ${parsed.version}, using defaults`);
      return defaults;
    }

    const {
      watchlist: _legacyWatchlist,
      ...parsedWithoutLegacy
    } = parsed;

    // Deep merge with defaults to handle missing fields
    return {
      ...defaults,
      ...parsedWithoutLegacy,
      chain: {
        ...defaults.chain,
        ...((parsed.chain as Record<string, unknown> | undefined) ?? {}),
      },
      wallet: normalizeWalletSection(parsed.wallet),
      solana: {
        ...defaults.solana,
        ...((parsed.solana as Record<string, unknown> | undefined) ?? {}),
      },
      services: {
        ...defaults.services,
        ...dropEmptyPoolsFunAttestApiUrl(
          dropEmptyAgentscanApiUrl(parsed.services as Record<string, unknown> | undefined),
        ),
      },
      // AFTER the `...parsedWithoutLegacy` spread above, and deliberately so:
      // that spread would otherwise land the raw disk value on a flag that
      // authorizes a signature. Only a real boolean `true` enables the lane.
      poolsFunAttestationEnabled: parsePoolsFunAttestationEnabled(
        parsed.poolsFunAttestationEnabled,
      ),
      ...(parseClaudeConfig(parsed.claude) ? { claude: parseClaudeConfig(parsed.claude) } : {}),
      ...(parseChainRpcUrls(parsed.localChainRpcUrls) ? { localChainRpcUrls: parseChainRpcUrls(parsed.localChainRpcUrls) } : {}),
      ...(parseChainRpcUrls(parsed.pendleRpcUrls) ? { pendleRpcUrls: parseChainRpcUrls(parsed.pendleRpcUrls) } : {}),
    };
  } catch (err) {
    logger.error(`Failed to parse config: ${err}`);
    return defaults;
  }
}

export function saveConfig(config: VexConfig): void {
  ensureConfigDir();

  const dir = dirname(CONFIG_FILE);
  const tmpFile = join(dir, `.config.tmp.${Date.now()}.json`);

  try {
    // Atomic write: write to temp, then rename
    writeFileSync(tmpFile, JSON.stringify(config, null, 2), "utf-8");
    renameSync(tmpFile, CONFIG_FILE);
    logger.debug(`Config saved to ${CONFIG_FILE}`);
  } catch (err) {
    // Cleanup temp file if rename failed
    try {
      if (existsSync(tmpFile)) {
        unlinkSync(tmpFile);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

// ── Partial patch ────────────────────────────────────────────────────

/**
 * Shape accepted by {@link saveConfigPatch} — every top-level section is
 * optional, and for object-valued sections (chain, services, …) the patch
 * only needs to mention the fields it wants to override. `wallet` and
 * `claude` follow the same rule.
 *
 * This is NOT a `DeepPartial<VexConfig>` — we keep the nesting explicit at
 * one level so the merge code stays simple and the call sites stay typed.
 */
export type VexConfigPatch = {
  chain?: Partial<VexConfig["chain"]>;
  wallet?: Partial<VexConfig["wallet"]>;
  solana?: Partial<VexConfig["solana"]>;
  services?: Partial<VexConfig["services"]>;
  claude?: NonNullable<VexConfig["claude"]>;
};

/**
 * Apply a partial config patch — loads current config (merged with defaults),
 * shallow-merges each provided section, and atomically writes the result.
 * Intended for UI editors (shell settings panel) that only know about a
 * subset of fields.
 *
 * Returns the persisted config so the caller can refresh any cached view.
 */
export function saveConfigPatch(patch: VexConfigPatch): VexConfig {
  const current = loadConfig();
  const next: VexConfig = {
    ...current,
    ...(patch.chain ? { chain: { ...current.chain, ...patch.chain } } : {}),
    ...(patch.wallet ? { wallet: { ...current.wallet, ...patch.wallet } } : {}),
    ...(patch.solana ? { solana: { ...current.solana, ...patch.solana } } : {}),
    ...(patch.services ? { services: { ...current.services, ...patch.services } } : {}),
    ...(patch.claude ? { claude: { ...(current.claude ?? {} as VexConfig["claude"]), ...patch.claude } as VexConfig["claude"] } : {}),
  };
  saveConfig(next);
  return next;
}
