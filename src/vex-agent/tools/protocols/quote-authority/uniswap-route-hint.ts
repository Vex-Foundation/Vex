import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Bound routing work that can be reused while the prequote remains valid. Output is still refreshed. */
export const uniswapRouteHintSchema = z.object({
  version: z.enum(["v2", "v3"]),
  path: z.array(address).min(2).max(3),
  fees: z.array(z.number().int().min(0).max(0xffffff)).max(2).optional(),
}).refine((route) => route.version === "v2"
  ? route.fees === undefined
  : route.fees?.length === route.path.length - 1);

export type UniswapRouteHint = z.infer<typeof uniswapRouteHintSchema>;

export function canonicalizeUniswapRouteHint(route: UniswapRouteHint): string {
  return `${route.version}|${route.path.map((address) => address.toLowerCase()).join(",")}|${route.fees?.join(",") ?? ""}`;
}
