import { z } from "zod";

export const lighterIntegrationEnvironmentSchema = z.enum(["core", "rhc"]);

export const lighterIntegrationStateSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    enabled: z.boolean(),
    enabledAt: z.string().datetime().nullable(),
    disabledAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

export const getLighterIntegrationInputSchema = z
  .object({ environment: lighterIntegrationEnvironmentSchema })
  .strict();

export const setLighterIntegrationInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    enabled: z.boolean(),
  })
  .strict();

const lighterCredentialWalletAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/);

export const lighterCredentialScopeSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    accountIndex: z.number().int().nonnegative(),
    apiKeyIndex: z.number().int().min(4).max(254),
    managed: z.boolean(),
  })
  .strict();

export const lighterCredentialConnectionSchema = z
  .object({
    walletAddress: lighterCredentialWalletAddressSchema,
    protected: z.boolean(),
    scopes: z.array(lighterCredentialScopeSchema).min(1).max(512).readonly(),
  })
  .strict();

export const inspectLighterCredentialConnectionsInputSchema = z
  .object({})
  .strict();

export const inspectLighterCredentialConnectionsResultSchema = z
  .object({
    connections: z
      .array(lighterCredentialConnectionSchema)
      .max(512)
      .readonly(),
  })
  .strict();

export const forgetLighterCredentialConnectionInputSchema = z
  .object({
    walletAddress: lighterCredentialWalletAddressSchema,
    scopes: z.array(lighterCredentialScopeSchema).min(1).max(512).readonly(),
  })
  .strict();

export const forgetLighterCredentialConnectionResultSchema = z
  .object({
    walletAddress: lighterCredentialWalletAddressSchema,
    removedScopes: z.array(lighterCredentialScopeSchema).min(1).max(512).readonly(),
  })
  .strict();

export type LighterIntegrationEnvironment = z.infer<
  typeof lighterIntegrationEnvironmentSchema
>;
export type LighterIntegrationState = z.infer<typeof lighterIntegrationStateSchema>;
export type GetLighterIntegrationInput = z.infer<typeof getLighterIntegrationInputSchema>;
export type SetLighterIntegrationInput = z.infer<typeof setLighterIntegrationInputSchema>;
export type LighterCredentialScope = z.infer<typeof lighterCredentialScopeSchema>;
export type LighterCredentialConnection = z.infer<
  typeof lighterCredentialConnectionSchema
>;
export type InspectLighterCredentialConnectionsInput = z.infer<
  typeof inspectLighterCredentialConnectionsInputSchema
>;
export type InspectLighterCredentialConnectionsResult = z.infer<
  typeof inspectLighterCredentialConnectionsResultSchema
>;
export type ForgetLighterCredentialConnectionInput = z.infer<
  typeof forgetLighterCredentialConnectionInputSchema
>;
export type ForgetLighterCredentialConnectionResult = z.infer<
  typeof forgetLighterCredentialConnectionResultSchema
>;
