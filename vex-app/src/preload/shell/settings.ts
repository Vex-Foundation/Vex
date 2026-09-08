import { z } from "zod";
import { CH } from "../../shared/ipc/channels.js";
import {
  userProfileSchema,
  type UserProfile,
} from "../../shared/schemas/user-profile.js";
import type { SettingsBridge } from "../../shared/types/bridge/shell/settings.js";
import {
  forgetLighterCredentialConnectionInputSchema,
  getLighterIntegrationInputSchema,
  inspectLighterCredentialConnectionsInputSchema,
  setLighterIntegrationInputSchema,
  type ForgetLighterCredentialConnectionInput,
  type GetLighterIntegrationInput,
  type InspectLighterCredentialConnectionsInput,
  type SetLighterIntegrationInput,
} from "../../shared/schemas/lighter-integration.js";
import { readLighterPointsInputSchema } from "../../shared/schemas/lighter-points.js";
import { abortableInvoke, invokeWithSchema } from "../_dispatch.js";

const setTelemetryConsentInputSchema = z
  .object({ enabled: z.boolean() })
  .strict();

export const settings = {
  getPreferences() {
    return invokeWithSchema(CH.settings.getPreferences, {});
  },
  setTelemetryConsent(input: { enabled: boolean }) {
    return invokeWithSchema(
      CH.settings.setTelemetryConsent,
      input,
      setTelemetryConsentInputSchema
    );
  },
  getLighterIntegration(input: GetLighterIntegrationInput) {
    return invokeWithSchema(
      CH.settings.getLighterIntegration,
      input,
      getLighterIntegrationInputSchema,
    );
  },
  setLighterIntegration(input: SetLighterIntegrationInput) {
    return invokeWithSchema(
      CH.settings.setLighterIntegration,
      input,
      setLighterIntegrationInputSchema,
    );
  },
  inspectLighterCredentialConnections(
    input: InspectLighterCredentialConnectionsInput = {},
  ) {
    return invokeWithSchema(
      CH.settings.inspectLighterCredentialConnections,
      input,
      inspectLighterCredentialConnectionsInputSchema,
    );
  },
  forgetLighterCredentialConnection(
    input: ForgetLighterCredentialConnectionInput,
  ) {
    return invokeWithSchema(
      CH.settings.forgetLighterCredentialConnection,
      input,
      forgetLighterCredentialConnectionInputSchema,
    );
  },
  // Abortable: unmounting the Settings section or pressing Refresh again
  // cancels the in-flight read, which is what reaches main's `ctx.signal`.
  lighterPoints() {
    return abortableInvoke(CH.settings.lighterPoints, {}, readLighterPointsInputSchema);
  },
  getUserProfile() {
    return invokeWithSchema(CH.settings.getUserProfile, {});
  },
  setUserProfile(profile: UserProfile) {
    return invokeWithSchema(CH.settings.setUserProfile, profile, userProfileSchema);
  },
  getSuperboardKey() {
    return invokeWithSchema(CH.settings.getSuperboardKey, {});
  },
  generateSuperboardKey() {
    return invokeWithSchema(CH.settings.generateSuperboardKey, {});
  },
} satisfies SettingsBridge;
