import { z } from "zod";

const chainId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const getChainEndpointsInputSchema = z.object({ chainId }).strict();
export const chainEndpointsSchema = z.object({
  chainId,
  rpcUrl: z.string().nullable(),
  blockscoutBaseUrl: z.string().nullable(),
}).strict();
export const setChainEndpointsInputSchema = chainEndpointsSchema;
export type ChainEndpoints = z.infer<typeof chainEndpointsSchema>;
