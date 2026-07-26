/**
 * Legacy entrypoint for the `VexBridge` typed surface.
 *
 * Renderer (`vex.d.ts`) and preload (`index.ts` composer) import the
 * full `VexBridge` interface through this barrel — leaving the path
 * stable across the shell/agent split refactor. The interface
 * declarations themselves live under `bridge/`:
 *
 *   - `bridge/common.ts`               — `AbortableInvocation`, `TelemetryReportInput`
 *   - `bridge/shell/*.ts`              — vex-app desktop integration interfaces
 *   - `bridge/agent/*.ts`              — vex-agent runtime integration interfaces
 *   - `bridge/shell/index.ts`          — `VexShellBridge` composer
 *   - `bridge/agent/index.ts`          — `VexAgentBridge` composer
 *   - `bridge/index.ts`                — `VexBridge extends Vex*Bridge`
 *
 * Per-domain implementations (preload + bridge surface tests) import
 * their narrow interface directly from `bridge/<group>/<domain>.js` —
 * only this module and renderer-side type augmentation refer to the
 * root `VexBridge` alias.
 */

export type {
  AbortableInvocation,
  ApprovalsBridge,
  CapabilitiesBridge,
  ChatBridge,
  DatabaseBridge,
  DockerBridge,
  MarketBridge,
  MessagesBridge,
  MissionBridge,
  ModelsBridge,
  OnboardingBridge,
  RuntimeBridge,
  SecretsBridge,
  SessionsBridge,
  SettingsBridge,
  SupportBridge,
  SystemBridge,
  TelemetryBridge,
  TelemetryReportInput,
  UsageBridge,
  VexAgentBridge,
  VexBridge,
  VexShellBridge,
  WalletBridge,
  WalletsBridge,
} from "./bridge/index.js";
