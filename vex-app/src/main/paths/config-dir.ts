/**
 * Pure CONFIG_DIR resolver — mirrors `/mnt/x/Vex/src/config/paths.ts`
 * exactly so vex-app and the local agent runtime agree on a single
 * `~/.config/vex` (Linux) / `~/Library/Application Support/vex` (macOS) /
 * `%APPDATA%/vex` (Windows).
 *
 * No Electron imports here — must remain consumable from plain Node /
 * tsx contexts so the future M5 compose render module (also pure)
 * can derive shared paths without dragging Electron in.
 */

import { homedir } from "node:os";
import path from "node:path";

const APP_NAME = "vex";

interface ResolveDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The path flavour for a TARGET platform, not for the host this code runs on.
 *
 * `path.join` is host-dependent, so on a Linux CI box a `win32` case would be
 * joined with `/`. The resolver is a contract both this app and the standalone
 * Go bridge re-derive from the same golden vectors, and a vector has to name
 * ONE expected string, so the flavour is selected from the input rather than
 * inherited from the process. On a real win32 host `path.win32 === path`, so
 * runtime behaviour is unchanged.
 *
 * EXPORTED because the Studio endpoint planner
 * (`main/studio/mcp-host/endpoint.ts`) needs exactly the same selection for
 * exactly the same reason, and two copies of this three-line decision is two
 * places a future edit can make host-dependent again. The Go bridge's
 * `internal/configdir` lexical helpers are the same rule on its side.
 */
export function flavour(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * A directory environment variable is USABLE only when it is non-empty and
 * absolute.
 *
 * Empty is treated as unset because that is what the XDG Base Directory
 * specification requires ("If $XDG_CONFIG_HOME is either not set or empty, a
 * default equal to $HOME/.config should be used"), and because `??` alone let
 * an empty `XDG_CONFIG_HOME` produce the RELATIVE path `"vex"` - a config
 * directory in whatever cwd the launcher happened to have. Relative is
 * rejected for the same reason `VEX_CONFIG_DIR` rejects it: a typo must never
 * redirect privileged state into the launcher's working directory.
 */
function usableDirEnv(
  value: string | undefined,
  target: path.PlatformPath,
): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!target.isAbsolute(value)) return null;
  return value;
}

export function resolveConfigDir(deps: ResolveDeps): string {
  const { platform, homedir: home, env } = deps;
  const target = flavour(platform);

  // Test/CI override - Playwright fixtures (and any future integration
  // harness) need to isolate per-spec state from the user's real
  // ~/.config or %APPDATA%. Honour `VEX_CONFIG_DIR` ONLY when it is
  // non-empty AND absolute. Mirrors the override in src/config/paths.ts
  // so the local agent runtime sees the same root.
  const override = usableDirEnv(env["VEX_CONFIG_DIR"], target);
  if (override !== null) return override;

  if (platform === "win32") {
    const appData =
      usableDirEnv(env["APPDATA"], target)
      ?? target.join(home, "AppData", "Roaming");
    return target.join(appData, APP_NAME);
  }

  if (platform === "darwin") {
    return target.join(home, "Library", "Application Support", APP_NAME);
  }

  // Linux + every other unix
  const xdgConfig =
    usableDirEnv(env["XDG_CONFIG_HOME"], target) ?? target.join(home, ".config");
  return target.join(xdgConfig, APP_NAME);
}

export const CONFIG_DIR = resolveConfigDir({
  platform: process.platform,
  homedir: homedir(),
  env: process.env,
});

/**
 * Electron-private state lives nested under CONFIG_DIR so the directory
 * tree stays one place but Chromium's session cache, our preferences
 * store, and electron-log files do not pollute shared runtime files
 * (`.env`, `keystore.json`, `config.json`, ...).
 */
export const ELECTRON_STATE_DIR = path.join(CONFIG_DIR, ".electron-state");

/**
 * Shared local runtime resources:
 *
 *   CONFIG_DIR/
 *     .env                              shared TRACKED_ENV_KEYS
 *     secrets.vault.json                encrypted API/provider credentials
 *     .install-id                       per-install uuid (M5)
 *     .setup-complete                   wizard completion flag
 *     keystore.json                     EVM keystore
 *     solana-keystore.json              Solana keystore
 *     config.json                       wallet addresses, chain config
 *     compose/docker-compose.yml        rendered compose (M5)
 *     local-infra/secrets/pg_password   PG password (M5)
 *     .electron-state/                  Electron-only (window state, cache)
 *
 * Vex Studio projects live OUTSIDE this tree, under `DEFAULT_PROJECTS_ROOT`
 * (`~/Vex/projects`) or the absolute `projectsRoot` override in `config.json`,
 * because they are user-visible working directories rather than app state.
 */
export const ENV_FILE = path.join(CONFIG_DIR, ".env");
export const SECRETS_VAULT_FILE = path.join(CONFIG_DIR, "secrets.vault.json");
export const INSTALL_ID_FILE = path.join(CONFIG_DIR, ".install-id");
export const SETUP_COMPLETE_FILE = path.join(CONFIG_DIR, ".setup-complete");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const COMPOSE_OUTPUT_DIR = path.join(CONFIG_DIR, "compose");
export const SECRETS_DIR = path.join(CONFIG_DIR, "local-infra", "secrets");
export const PG_PASSWORD_FILE = path.join(SECRETS_DIR, "pg_password");
export const VAULT_RESET_JOURNAL_FILE = path.join(
  CONFIG_DIR,
  ".vault-reset-journal.json",
);

// ── Vex Studio projects root ──────────────────────────────────────────────
//
// User-visible workspace, deliberately NOT under CONFIG_DIR: a Studio project
// is a folder the user opens in their own editor and terminal, so it belongs in
// their home directory, not inside Vex's private config tree.
//
//   ~/Vex/projects/
//     <slug>/                          one project, claimed with exclusive mkdir
//
// Mirrored verbatim in `src/config/paths.ts` so vex-app and the agent runtime
// agree on one root. Both files stay Electron-free and CONFIG-FREE: the
// override lives in `config.json`, whose owner is `src/config/store.ts`, and
// importing that owner here would make this module depend on the config reader
// it is meant to stay below. The composition point is
// `vex-app/src/main/studio/projects-root.ts`, which reads the override from the
// config owner and passes it to `resolveProjectsRootPath` below.

export const DEFAULT_PROJECTS_ROOT = path.join(homedir(), "Vex", "projects");

/**
 * Resolve the effective projects root from a `config.json` override.
 *
 * Honour the override ONLY when it is non-empty AND absolute; a relative value
 * falls through to the default for the same reason `VEX_CONFIG_DIR` does - a
 * typo must never redirect project directories into the launcher's cwd.
 */
export function resolveProjectsRootPath(
  configuredRoot: string | null | undefined,
): string {
  if (
    typeof configuredRoot === "string" &&
    configuredRoot.length > 0 &&
    path.isAbsolute(configuredRoot)
  ) {
    return configuredRoot;
  }
  return DEFAULT_PROJECTS_ROOT;
}
