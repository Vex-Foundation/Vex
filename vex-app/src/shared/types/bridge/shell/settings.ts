import type { Result } from "../../../ipc/result.js";
import type { Preferences } from "../../../schemas/preferences.js";
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

export interface SettingsBridge {
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
  /** "Vex setup" user profile — DB-backed (soul singleton), replaces persona.md. */
  readonly getUserProfile: () => Promise<Result<UserProfile>>;
  readonly setUserProfile: (profile: UserProfile) => Promise<Result<UserProfile>>;
}
