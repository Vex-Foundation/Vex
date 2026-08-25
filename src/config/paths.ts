import { homedir, platform } from "node:os";
import path, { isAbsolute, join } from "node:path";

const APP_NAME = "vex";

export interface ConfigDirDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The path flavour for a TARGET platform, not for the host this code runs on.
 *
 * Mirrors `vex-app/src/main/paths/config-dir.ts` exactly. `path.join` is
 * host-dependent, so a `win32` case evaluated on Linux would be joined with
 * `/`; the golden vectors name ONE expected string per case, so the flavour
 * comes from the input. On a real win32 host `path.win32 === path`, so runtime
 * behaviour is unchanged.
 */
function flavour(target: NodeJS.Platform): path.PlatformPath {
  return target === "win32" ? path.win32 : path.posix;
}

/**
 * A directory environment variable is USABLE only when it is non-empty and
 * absolute.
 *
 * Empty counts as unset because the XDG Base Directory specification requires
 * it ("If $XDG_CONFIG_HOME is either not set or empty, a default equal to
 * $HOME/.config should be used") and because `??` alone let an empty
 * `XDG_CONFIG_HOME` produce the RELATIVE path `"vex"`, putting privileged
 * state in whatever cwd the launcher happened to have. Relative is rejected
 * for the same reason `VEX_CONFIG_DIR` rejects it.
 */
function usableDirEnv(
  value: string | undefined,
  target: path.PlatformPath,
): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!target.isAbsolute(value)) return null;
  return value;
}

/**
 * The pure CONFIG_DIR resolver, mirrored verbatim in
 * `vex-app/src/main/paths/config-dir.ts` and re-derived independently by the
 * Go bridge (`bridge/internal/configdir`). All three run the same golden
 * vectors (`studio-mcp/bridge-endpoint-vectors.json`, section `configDir`),
 * because the Studio endpoint hash is taken over this directory and a drift
 * here is a bridge that dials a path the app never bound.
 */
export function resolveConfigDir(deps: ConfigDirDeps): string {
  const target = flavour(deps.platform);

  // Test/CI override - accept an explicit absolute path so Playwright (and any
  // future integration harness) can isolate state per spec without touching
  // ~/.config or %APPDATA%.
  const override = usableDirEnv(deps.env["VEX_CONFIG_DIR"], target);
  if (override !== null) return override;

  if (deps.platform === "win32") {
    // Windows: %APPDATA%/vex
    const appData =
      usableDirEnv(deps.env["APPDATA"], target)
      ?? target.join(deps.homedir, "AppData", "Roaming");
    return target.join(appData, APP_NAME);
  }

  if (deps.platform === "darwin") {
    // macOS: ~/Library/Application Support/vex
    return target.join(deps.homedir, "Library", "Application Support", APP_NAME);
  }

  // Linux/Unix: ~/.config/vex
  const xdgConfig =
    usableDirEnv(deps.env["XDG_CONFIG_HOME"], target)
    ?? target.join(deps.homedir, ".config");
  return target.join(xdgConfig, APP_NAME);
}

function getConfigDir(): string {
  return resolveConfigDir({
    platform: platform(),
    homedir: homedir(),
    env: process.env,
  });
}

export const CONFIG_DIR = getConfigDir();
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const KEYSTORE_FILE = join(CONFIG_DIR, "keystore.json");
export const SOLANA_KEYSTORE_FILE = join(CONFIG_DIR, "solana-keystore.json");
export const INTENTS_DIR = join(CONFIG_DIR, "intents");
export const JWT_FILE = join(CONFIG_DIR, "jwt.json");
// App-specific .env (provider-neutral)
export const ENV_FILE = join(CONFIG_DIR, ".env");
export const SECRETS_VAULT_FILE = join(CONFIG_DIR, "secrets.vault.json");

// Backup paths
export const BACKUPS_DIR = join(CONFIG_DIR, "backups");

// Bot paths
export const BOT_DIR = join(CONFIG_DIR, "bot");
export const BOT_ORDERS_FILE = join(BOT_DIR, "orders.json");
export const BOT_STATE_FILE = join(BOT_DIR, "state.json");
export const BOT_PID_FILE = join(BOT_DIR, "bot.pid");
export const BOT_SHUTDOWN_FILE = join(BOT_DIR, "bot.shutdown");
export const BOT_LOG_FILE = join(BOT_DIR, "bot.log");
export const BOT_STOPPED_FILE = join(BOT_DIR, "bot.stopped");

// Launcher paths
export const LAUNCHER_DIR = join(CONFIG_DIR, "launcher");
export const LAUNCHER_PID_FILE = join(LAUNCHER_DIR, "launcher.pid");
export const LAUNCHER_LOG_FILE = join(LAUNCHER_DIR, "launcher.log");
export const LAUNCHER_STOPPED_FILE = join(LAUNCHER_DIR, "launcher.stopped");
export const LAUNCHER_DEFAULT_PORT = 4200;
export const CONNECTORS_DIR = join(CONFIG_DIR, "connectors");

// Solana paths
export const SOLANA_TOKEN_CACHE_FILE = join(CONFIG_DIR, "solana-token-cache.json");

// ── Vex Studio projects root ──────────────────────────────────────────────
//
// User-visible workspace, deliberately NOT under CONFIG_DIR: a Studio project
// is a folder the user opens in their own editor and terminal. Mirrored
// verbatim in `vex-app/src/main/paths/config-dir.ts`; keep the two in lock-step.
//
// This module stays below the config reader (`./store.ts` imports it), so the
// `projectsRoot` override from `config.json` is applied by the caller through
// `resolveProjectsRootPath` rather than read here.
export const DEFAULT_PROJECTS_ROOT = join(homedir(), "Vex", "projects");

/**
 * Resolve the effective projects root from a `config.json` override. Honoured
 * only when non-empty AND absolute; a relative value falls through to the
 * default so a typo cannot redirect project directories into the cwd.
 */
export function resolveProjectsRootPath(
  configuredRoot: string | null | undefined,
): string {
  if (
    typeof configuredRoot === "string"
    && configuredRoot.length > 0
    && isAbsolute(configuredRoot)
  ) {
    return configuredRoot;
  }
  return DEFAULT_PROJECTS_ROOT;
}
