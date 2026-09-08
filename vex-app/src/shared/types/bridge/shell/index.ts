/**
 * `VexShellBridge` — vex-app desktop integration surface.
 *
 * Aggregates the shell-side domain bridges: native shell concerns
 * (system, Docker, secret vault, onboarding, settings, telemetry,
 * support, sudo wallet export) that belong to the Electron host
 * lifecycle rather than the agent runtime.
 *
 * Re-exports each domain interface explicitly (no `export *`) so the
 * surface stays searchable and a stray declaration in a child module
 * cannot grow the public type by accident.
 */

import type { CapabilitiesBridge } from "./capabilities.js";
import type { DatabaseBridge } from "./database.js";
import type { DockerBridge } from "./docker.js";
import type { FilesBridge } from "./files.js";
import type { MarketBridge } from "./market.js";
import type { LighterTradingBridge } from "./lighter-trading.js";
import type { OnboardingBridge } from "./onboarding.js";
import type { SearchBridge } from "./search.js";
import type { SecretsBridge } from "./secrets.js";
import type { SettingsBridge } from "./settings.js";
import type { ShellBackdropBridge } from "./shell-backdrop.js";
import type { StudioBridge } from "./studio.js";
import type { SupportBridge } from "./support.js";
import type { SystemBridge } from "./system.js";
import type { TerminalBridge } from "./terminal.js";
import type { TerminalLinksBridge } from "./terminal-links.js";
import type { TelemetryBridge } from "./telemetry.js";
import type { UpdaterBridge } from "./updater.js";
import type { WalletBridge } from "./wallet.js";

export type { CapabilitiesBridge } from "./capabilities.js";
export type { DatabaseBridge } from "./database.js";
export type { DockerBridge } from "./docker.js";
export type { FilesBridge } from "./files.js";
export type { MarketBridge } from "./market.js";
export type { LighterTradingBridge } from "./lighter-trading.js";
export type { OnboardingBridge } from "./onboarding.js";
export type { SearchBridge } from "./search.js";
export type { SecretsBridge } from "./secrets.js";
export type { SettingsBridge } from "./settings.js";
export type { ShellBackdropBridge } from "./shell-backdrop.js";
export type { StudioBridge } from "./studio.js";
export type { SupportBridge } from "./support.js";
export type { SystemBridge } from "./system.js";
export type { TerminalBridge } from "./terminal.js";
export type { TerminalLinksBridge } from "./terminal-links.js";
export type { TelemetryBridge } from "./telemetry.js";
export type { UpdaterBridge } from "./updater.js";
export type { WalletBridge } from "./wallet.js";

export interface VexShellBridge {
  readonly capabilities: CapabilitiesBridge;
  readonly system: SystemBridge;
  readonly docker: DockerBridge;
  readonly database: DatabaseBridge;
  readonly secrets: SecretsBridge;
  readonly wallet: WalletBridge;
  readonly onboarding: OnboardingBridge;
  readonly settings: SettingsBridge;
  readonly shellBackdrop: ShellBackdropBridge;
  readonly telemetry: TelemetryBridge;
  readonly support: SupportBridge;
  readonly updater: UpdaterBridge;
  readonly market: MarketBridge;
  readonly lighterTrading: LighterTradingBridge;
  readonly studio: StudioBridge;
  readonly terminal: TerminalBridge;
  readonly terminalLinks: TerminalLinksBridge;
  readonly files: FilesBridge;
  readonly search: SearchBridge;
}
