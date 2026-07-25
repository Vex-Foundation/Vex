/**
 * `VexBridge` — full public surface exposed to the renderer as
 * `window.vex`.
 *
 * Composes `VexShellBridge` (vex-app desktop integration) with
 * `VexAgentBridge` (vex-agent runtime integration). The two halves
 * declare disjoint top-level namespaces, so `extends` gives a clean
 * compile-time guard — adding a colliding key would surface as a
 * `Type 'X' is not assignable to type 'Y'` error rather than silently
 * shadowing.
 *
 * Source-of-truth interface for both preload (which `satisfies` the
 * type) and renderer (which dereferences it via `window.vex.*`).
 *
 * Re-exports are explicit (no `export type *`) so a stray declaration
 * cannot grow the public type by accident, and so call-sites stay
 * grep-friendly.
 */

import type { VexAgentBridge } from "./agent/index.js";
import type { VexShellBridge } from "./shell/index.js";

export type { AbortableInvocation, TelemetryReportInput } from "./common.js";

export type {
  CapabilitiesBridge,
  DatabaseBridge,
  DockerBridge,
  MarketBridge,
  OnboardingBridge,
  SecretsBridge,
  SettingsBridge,
  SupportBridge,
  SystemBridge,
  TelemetryBridge,
  WalletBridge,
} from "./shell/index.js";
export type { VexShellBridge } from "./shell/index.js";

export type {
  ApprovalsBridge,
  ChatBridge,
  MessagesBridge,
  MissionBridge,
  ModelsBridge,
  PortfolioBridge,
  RuntimeBridge,
  SessionsBridge,
  UsageBridge,
  WalletsBridge,
} from "./agent/index.js";
export type { VexAgentBridge } from "./agent/index.js";

export interface VexBridge extends VexShellBridge, VexAgentBridge {}
