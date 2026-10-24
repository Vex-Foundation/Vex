import { chainEndpointsSchema, getChainEndpointsInputSchema, setChainEndpointsInputSchema, type ChainEndpoints } from "../../shared/schemas/chain-endpoints.js";
import { z } from "zod";
import {
  addUserMcpServerInputSchema,
  listUserMcpInputSchema,
  recheckUserMcpServerInputSchema,
  removeUserMcpServerInputSchema,
  setUserMcpTokenInputSchema,
  setUserMcpToolAutoRunInputSchema,
  setUserMcpToolEnabledInputSchema,
  userMcpListDtoSchema,
  type AddUserMcpServerInput,
  type RecheckUserMcpServerInput,
  type RemoveUserMcpServerInput,
  type SetUserMcpTokenInput,
  type SetUserMcpToolAutoRunInput,
  type SetUserMcpToolEnabledInput,
  type UserMcpListDto,
} from "../../shared/schemas/user-mcp.js";
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
import {
  cancelLighterLeverageInputSchema,
  confirmLighterLeverageInputSchema,
  getLighterLeverageOverviewInputSchema,
  getLighterTradingLimitsInputSchema,
  prepareLighterLeverageInputSchema,
  reconcileLighterLeverageInputSchema,
  setLighterTradingLimitsInputSchema,
  type CancelLighterLeverageInput,
  type ConfirmLighterLeverageInput,
  type GetLighterLeverageOverviewInput,
  type GetLighterTradingLimitsInput,
  type PrepareLighterLeverageInput,
  type ReconcileLighterLeverageInput,
  type SetLighterTradingLimitsInput,
} from "../../shared/schemas/lighter-trading-limits.js";
import {
  setNotificationPreferencesInputSchema,
  type SetNotificationPreferencesInput,
} from "../../shared/schemas/preferences.js";
import { abortableInvoke, invokeWithSchema } from "../_dispatch.js";

const setTelemetryConsentInputSchema = z
  .object({ enabled: z.boolean() })
  .strict();

export const settings = {
  async getChainEndpoints(input: { chainId: number }) {
    const result = await invokeWithSchema<ChainEndpoints>(CH.settings.getChainEndpoints, input, getChainEndpointsInputSchema);
    return result.ok ? { ...result, data: chainEndpointsSchema.parse(result.data) } : result;
  },
  async setChainEndpoints(input: ChainEndpoints) {
    const result = await invokeWithSchema<ChainEndpoints>(CH.settings.setChainEndpoints, input, setChainEndpointsInputSchema);
    return result.ok ? { ...result, data: chainEndpointsSchema.parse(result.data) } : result;
  },
  async listUserMcp() {
    const result = await invokeWithSchema<UserMcpListDto>(CH.settings.listUserMcp, {}, listUserMcpInputSchema);
    return result.ok ? { ...result, data: userMcpListDtoSchema.parse(result.data) } : result;
  },
  async addUserMcpServer(input: AddUserMcpServerInput) {
    const result = await invokeWithSchema<UserMcpListDto>(CH.settings.addUserMcpServer, input, addUserMcpServerInputSchema);
    return result.ok ? { ...result, data: userMcpListDtoSchema.parse(result.data) } : result;
  },
  async removeUserMcpServer(input: RemoveUserMcpServerInput) {
    const result = await invokeWithSchema<UserMcpListDto>(CH.settings.removeUserMcpServer, input, removeUserMcpServerInputSchema);
    return result.ok ? { ...result, data: userMcpListDtoSchema.parse(result.data) } : result;
  },
  async setUserMcpToken(input: SetUserMcpTokenInput) {
    const result = await invokeWithSchema<UserMcpListDto>(CH.settings.setUserMcpToken, input, setUserMcpTokenInputSchema);
    return result.ok ? { ...result, data: userMcpListDtoSchema.parse(result.data) } : result;
  },
  async setUserMcpToolEnabled(input: SetUserMcpToolEnabledInput) {
    const result = await invokeWithSchema<UserMcpListDto>(CH.settings.setUserMcpToolEnabled, input, setUserMcpToolEnabledInputSchema);
    return result.ok ? { ...result, data: userMcpListDtoSchema.parse(result.data) } : result;
  },
  async setUserMcpToolAutoRun(input: SetUserMcpToolAutoRunInput) {
    const result = await invokeWithSchema<UserMcpListDto>(CH.settings.setUserMcpToolAutoRun, input, setUserMcpToolAutoRunInputSchema);
    return result.ok ? { ...result, data: userMcpListDtoSchema.parse(result.data) } : result;
  },
  async recheckUserMcpServer(input: RecheckUserMcpServerInput) {
    const result = await invokeWithSchema<UserMcpListDto>(CH.settings.recheckUserMcpServer, input, recheckUserMcpServerInputSchema);
    return result.ok ? { ...result, data: userMcpListDtoSchema.parse(result.data) } : result;
  },
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
  setNotificationPreferences(input: SetNotificationPreferencesInput) {
    return invokeWithSchema(
      CH.settings.setNotificationPreferences,
      input,
      setNotificationPreferencesInputSchema,
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
  getLighterTradingLimits(input: GetLighterTradingLimitsInput) {
    return invokeWithSchema(
      CH.settings.getLighterTradingLimits,
      input,
      getLighterTradingLimitsInputSchema,
    );
  },
  setLighterTradingLimits(input: SetLighterTradingLimitsInput) {
    return invokeWithSchema(
      CH.settings.setLighterTradingLimits,
      input,
      setLighterTradingLimitsInputSchema,
    );
  },
  getLighterLeverageOverview(input: GetLighterLeverageOverviewInput) {
    return invokeWithSchema(
      CH.settings.getLighterLeverageOverview,
      input,
      getLighterLeverageOverviewInputSchema,
    );
  },
  prepareLighterLeverage(input: PrepareLighterLeverageInput) {
    return invokeWithSchema(
      CH.settings.prepareLighterLeverage,
      input,
      prepareLighterLeverageInputSchema,
    );
  },
  // Abortable: closing the confirmation modal cancels the in-flight confirm,
  // which reaches main's `ctx.signal` and refuses BEFORE the nonce reservation
  // and BEFORE submission. It cannot recall a transaction already sent.
  confirmLighterLeverage(input: ConfirmLighterLeverageInput) {
    return abortableInvoke(
      CH.settings.confirmLighterLeverage,
      input,
      confirmLighterLeverageInputSchema,
    );
  },
  cancelLighterLeverage(input: CancelLighterLeverageInput) {
    return invokeWithSchema(
      CH.settings.cancelLighterLeverage,
      input,
      cancelLighterLeverageInputSchema,
    );
  },
  reconcileLighterLeverage(input: ReconcileLighterLeverageInput) {
    return invokeWithSchema(
      CH.settings.reconcileLighterLeverage,
      input,
      reconcileLighterLeverageInputSchema,
    );
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
  rotateSuperboardKey() {
    return invokeWithSchema(CH.settings.rotateSuperboardKey, {});
  },
} satisfies SettingsBridge;
