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

export type LighterIntegrationEnvironment = z.infer<
  typeof lighterIntegrationEnvironmentSchema
>;
export type LighterIntegrationState = z.infer<typeof lighterIntegrationStateSchema>;
export type GetLighterIntegrationInput = z.infer<typeof getLighterIntegrationInputSchema>;
export type SetLighterIntegrationInput = z.infer<typeof setLighterIntegrationInputSchema>;
