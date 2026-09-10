/** Public route metadata only. Wallet, approval and settlement internals stay local. */
import { z } from "zod";
import { v4PoolKeySchema, v4RouteBindingSchema } from "@tools/uniswap/v4-types.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
export const agentscanV4RouteSchema = z.object({
  version: z.literal("v4"),
  path: z.array(z.string().regex(/^0x[\da-fA-F]{40}$/)).length(2),
  poolId: z.string().regex(/^0x[\da-fA-F]{64}$/),
  poolKey: v4PoolKeySchema,
}).strict();
export type AgentscanV4Route = z.infer<typeof agentscanV4RouteSchema>;
export function activityV4Route(activity: Record<string, unknown>): AgentscanV4Route | undefined {
  if (activity.protocol !== "uniswap" || activity.event_role !== "swap") return undefined;
  const provenance = z.object({ version: z.literal("v4"), path: z.array(z.string()), v4: v4RouteBindingSchema }).safeParse(activity.route_provenance);
  if (!provenance.success) return undefined;
  const bound = provenance.data.v4;
  if (v4PoolId(bound.poolKey).toLowerCase() !== bound.poolId.toLowerCase()) return undefined;
  const parsed = agentscanV4RouteSchema.safeParse({ version: "v4", path: provenance.data.path, poolId: bound.poolId, poolKey: bound.poolKey });
  return parsed.success ? parsed.data : undefined;
}
