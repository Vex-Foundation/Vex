/** Durable v4 route identity. Pool IDs are hashes, never contract addresses. */
import { z } from "zod";
import type { Address, Hex } from "viem";

const address = z.custom<Address>((v) => typeof v === "string" && /^0x[\da-fA-F]{40}$/.test(v));
const hash = z.custom<Hex>((v) => typeof v === "string" && /^0x[\da-fA-F]{64}$/.test(v));
export const v4PoolKeySchema = z.object({
  currency0: address,
  currency1: address,
  fee: z.number().int().min(0).max(0x800000),
  tickSpacing: z.number().int().min(1).max(32767),
  hooks: address,
}).strict();
export type V4PoolKey = z.infer<typeof v4PoolKeySchema>;
export const v4RouteBindingSchema = z.object({
  poolId: hash,
  poolKey: v4PoolKeySchema,
  zeroForOne: z.boolean(),
  hookPermissions: z.number().int().min(0).max(0x3fff),
  dynamicFee: z.boolean(),
  observedLpFee: z.number().int().min(0).max(1000000),
  universalRouter: address,
  universalRouterVersion: z.enum(["2.0", "2.1.1"]),
  permit2: address,
}).strict();
export type V4RouteBinding = z.infer<typeof v4RouteBindingSchema>;
