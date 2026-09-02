/**
 * `shellBridge` — preload-side composer for vex-app desktop integration.
 *
 * Imports each shell-domain bridge as a named export, builds a single
 * object that `satisfies VexShellBridge`, and re-exports it for the
 * root composer (`preload/index.ts`) to fold into `window.vex`.
 *
 * Explicit named imports + `satisfies` keep the surface tight:
 *
 *   - the type guard catches missing namespaces (compile error if a
 *     domain is added to `VexShellBridge` but not wired here),
 *   - a stray module-level value from any child file cannot become a
 *     bridge namespace by accident,
 *   - call-sites stay grep-friendly (no `export *` in the tree).
 */

import type { VexShellBridge } from "../../shared/types/bridge/shell/index.js";
import { capabilities } from "./capabilities.js";
import { database } from "./database.js";
import { docker } from "./docker.js";
import { files } from "./files.js";
import { market } from "./market.js";
import { lighterTrading } from "./lighter-trading.js";
import { studio } from "./studio.js";
import { onboarding } from "./onboarding.js";
import { secrets } from "./secrets.js";
import { settings } from "./settings.js";
import { support } from "./support.js";
import { system } from "./system.js";
import { terminal } from "./terminal.js";
import { telemetry } from "./telemetry.js";
import { updater } from "./updater.js";
import { wallet } from "./wallet.js";

export const shellBridge = {
  capabilities,
  system,
  docker,
  database,
  secrets,
  wallet,
  onboarding,
  settings,
  telemetry,
  support,
  updater,
  market,
  lighterTrading,
  studio,
  terminal,
  files,
} satisfies VexShellBridge;
