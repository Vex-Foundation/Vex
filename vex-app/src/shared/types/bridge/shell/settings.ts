import type { ChainEndpoints } from "../../../schemas/chain-endpoints.js";
import type { Result } from "../../../ipc/result.js";
import type { AbortableInvocation } from "../common.js";
import type { Preferences } from "../../../schemas/preferences.js";
import type { SuperboardKeyStatus } from "../../../schemas/superboard-key.js";
import type { UserProfile } from "../../../schemas/user-profile.js";
import type {
  ForgetLighterCredentialConnectionInput,
  ForgetLighterCredentialConnectionResult,
  GetLighterIntegrationInput,
  InspectLighterCredentialConnectionsInput,
  InspectLighterCredentialConnectionsResult,
  LighterIntegrationState,
  SetLighterIntegrationInput,
} from "../../../schemas/lighter-integration.js";
import type { LighterPointsResult } from "../../../schemas/lighter-points.js";
import type {
  ApplyLighterLeverageResult,
  ConfirmLighterLeverageInput,
  GetLighterLeverageOverviewInput,
  GetLighterTradingLimitsInput,
  LighterLeverageOverview,
  LighterLeverageProposal,
  LighterTradingLimits,
  PrepareLighterLeverageInput,
  ReconcileLighterLeverageInput,
  SetLighterTradingLimitsInput,
} from "../../../schemas/lighter-trading-limits.js";

export interface SettingsBridge {
  readonly getChainEndpoints: (input: { chainId: number }) => Promise<Result<ChainEndpoints>>;
  readonly setChainEndpoints: (input: ChainEndpoints) => Promise<Result<ChainEndpoints>>;
  readonly getPreferences: () => Promise<Result<Preferences>>;
  readonly setTelemetryConsent: (input: {
    readonly enabled: boolean;
  }) => Promise<Result<Preferences>>;
  readonly getLighterIntegration: (
    input: GetLighterIntegrationInput,
  ) => Promise<Result<LighterIntegrationState>>;
  readonly setLighterIntegration: (
    input: SetLighterIntegrationInput,
  ) => Promise<Result<LighterIntegrationState>>;
  readonly inspectLighterCredentialConnections: (
    input?: InspectLighterCredentialConnectionsInput,
  ) => Promise<Result<InspectLighterCredentialConnectionsResult>>;
  readonly forgetLighterCredentialConnection: (
    input: ForgetLighterCredentialConnectionInput,
  ) => Promise<Result<ForgetLighterCredentialConnectionResult>>;
  /**
   * The Lighter points campaign for every registered wallet. Abortable: the
   * renderer cancels it on unmount and before starting a newer read, which is
   * what reaches main's `ctx.signal` and stops the provider reads behind it.
   */
  readonly lighterPoints: () => AbortableInvocation<LighterPointsResult>;
  /**
   * The agent's share of this wallet's Lighter capital. A PREFERENCE the agent
   * reads; the privileged executor is what enforces it. Writes are
   * compare-and-set on `revision`, so a second editor is told rather than
   * silently overwritten.
   */
  readonly getLighterTradingLimits: (
    input: GetLighterTradingLimitsInput,
  ) => Promise<Result<LighterTradingLimits>>;
  readonly setLighterTradingLimits: (
    input: SetLighterTradingLimitsInput,
  ) => Promise<Result<LighterTradingLimits>>;
  /** Live leverage per market for this wallet's Lighter account. */
  readonly getLighterLeverageOverview: (
    input: GetLighterLeverageOverviewInput,
  ) => Promise<Result<LighterLeverageOverview>>;
  /**
   * PREPARE half of the leverage change: the renderer sends a SELECTOR, main
   * resolves and persists the immutable proposal the modal renders.
   */
  readonly prepareLighterLeverage: (
    input: PrepareLighterLeverageInput,
  ) => Promise<Result<LighterLeverageProposal>>;
  /**
   * CONFIRM half: only the proposal id travels, so the renderer can never hand
   * main the terms it wants signed. Abortable, and the cancellation reaches the
   * executor's authority checks BEFORE the nonce reservation and BEFORE
   * submission; it can never recall a transaction already sent.
   */
  readonly confirmLighterLeverage: (
    input: ConfirmLighterLeverageInput,
  ) => AbortableInvocation<ApplyLighterLeverageResult>;
  /** Recover an unresolved change. Never signs or submits again. */
  readonly reconcileLighterLeverage: (
    input: ReconcileLighterLeverageInput,
  ) => Promise<Result<ApplyLighterLeverageResult>>;
  /** "Vex setup" user profile — DB-backed (soul singleton), replaces persona.md. */
  readonly getUserProfile: () => Promise<Result<UserProfile>>;
  readonly setUserProfile: (profile: UserProfile) => Promise<Result<UserProfile>>;
  readonly getSuperboardKey: () => Promise<Result<SuperboardKeyStatus>>;
  readonly generateSuperboardKey: () => Promise<Result<SuperboardKeyStatus>>;
}
