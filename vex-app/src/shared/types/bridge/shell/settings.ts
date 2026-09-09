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
  /** "Vex setup" user profile — DB-backed (soul singleton), replaces persona.md. */
  readonly getUserProfile: () => Promise<Result<UserProfile>>;
  readonly setUserProfile: (profile: UserProfile) => Promise<Result<UserProfile>>;
  readonly getSuperboardKey: () => Promise<Result<SuperboardKeyStatus>>;
  readonly generateSuperboardKey: () => Promise<Result<SuperboardKeyStatus>>;
}
