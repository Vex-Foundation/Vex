/**
 * Main-owned Hyperliquid policy boundary.
 *
 * The provider is registered by Electron main in Phase 4. Until then, the
 * absence or invalidity of its data deliberately disables all HL mutations;
 * the agent never guesses a policy from defaults alone.
 */
import { z } from "zod";

export const HYPERLIQUID_POLICY_VERSION = "hyperliquid-policy-v1" as const;

export const hyperliquidBuilderFeeConsentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("approved"), maxFeeRate: z.string().regex(/^\d+(?:\.\d+)?%$/) }).strict(),
]);

/**
 * Mission contracts may only add a narrower, accepted Hyperliquid risk envelope.
 * It deliberately excludes global-only policy choices (stop-loss, egress, fee
 * consent, and slippage/headroom defaults) so an agent cannot widen them.
 */
export const hyperliquidMissionRiskSchema = z.object({
  leverageCap: z.number().int().min(1),
  perOrderNotionalPct: z.number().min(1).max(50),
  totalNotionalPct: z.number().min(10).max(200),
  marketAllowlist: z.array(z.string().trim().min(1).max(64)).min(1).max(100).optional(),
}).strict();
export type HyperliquidMissionRisk = z.infer<typeof hyperliquidMissionRiskSchema>;

export const hyperliquidPolicySchema = z.object({
  requireStopLoss: z.boolean().default(true),
  // The operative hard ceiling is `meta.maxLeverage` for the chosen asset and
  // is enforced by the policy gate, where that market metadata is available.
  leverageCapDefault: z.number().int().min(1).default(3),
  perOrderNotionalPct: z.number().min(1).max(50).default(20),
  totalNotionalPct: z.number().min(10).max(200).default(100),
  maxSlippageEstPct: z.number().min(0.1).max(5).default(1),
  maintenanceHeadroomFloor: z.number().min(1.25).max(4).default(2),
  egressAlwaysApprove: z.boolean().default(true),
  marketMode: z.literal("all-core-perps").default("all-core-perps"),
  /** Optional accepted mission restriction; absent means every Core perp remains eligible. */
  marketAllowlist: z.array(z.string().trim().min(1).max(64)).min(1).max(100).nullable().default(null),
  builderFeeConsent: hyperliquidBuilderFeeConsentSchema.default({ kind: "none" }),
}).strict();

export type HyperliquidPolicy = z.infer<typeof hyperliquidPolicySchema>;

const policyProvenanceSchema = z.union([
  z.literal("defaults"),
  z.literal("preferences"),
  z.string().regex(/^session:[a-zA-Z0-9-]+$/),
  z.string().regex(/^mission:[a-f0-9]{16,}$/),
]);

const providerValueSchema = z.object({
  policy: hyperliquidPolicySchema,
  version: z.string().min(1).default(HYPERLIQUID_POLICY_VERSION),
  provenance: policyProvenanceSchema,
}).strict();

export interface HlPolicyScope {
  readonly sessionId?: string;
  readonly missionId?: string | null;
  /**
   * Session-selected EVM wallet address. Electron main supplies this from the
   * trusted session wallet resolution so a durable session overlay can never
   * be applied to a different wallet merely because it shares a session id.
   */
  readonly walletAddress?: string;
}

export interface HlPolicySnapshot {
  readonly policy: HyperliquidPolicy;
  readonly version: string;
  readonly resolvedAt: string;
  readonly provenance: z.infer<typeof policyProvenanceSchema>;
}

export type HlPolicyResolution =
  | { readonly kind: "available"; readonly snapshot: HlPolicySnapshot }
  | { readonly kind: "unavailable"; readonly reason: "provider_absent" | "provider_invalid" };

export type HlPolicyProvider = (scope: HlPolicyScope) => unknown;

let policyProvider: HlPolicyProvider | null = null;

/** Electron main registers a live preferences-backed closure before engine start. */
export function registerHlPolicyProvider(provider: HlPolicyProvider): void {
  policyProvider = provider;
}

/** Used on preferences teardown/reload and in isolated tests. */
export function clearHlPolicyProvider(): void {
  policyProvider = null;
}

/** Resolves afresh per execution; no stale policy survives an invalid provider response. */
export function resolveHlPolicy(scope: HlPolicyScope = {}): HlPolicyResolution {
  if (policyProvider === null) return { kind: "unavailable", reason: "provider_absent" };
  try {
    const parsed = providerValueSchema.safeParse(policyProvider(scope));
    if (!parsed.success) return { kind: "unavailable", reason: "provider_invalid" };
    return {
      kind: "available",
      snapshot: { ...parsed.data, resolvedAt: new Date().toISOString() },
    };
  } catch {
    return { kind: "unavailable", reason: "provider_invalid" };
  }
}

/** Discovery mirrors execute availability rather than advertising disabled trades. */
export function isHlMutationAvailable(): boolean {
  return resolveHlPolicy().kind === "available";
}
