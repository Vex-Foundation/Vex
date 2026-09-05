import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import type { ApprovalPreviewScalar } from "../../types.js";

export const LIGHTER_FEE_AUTHORIZATION_CRITICAL_KEYS = [
  "toolId",
  "intentId",
  "summary",
  "perpetualFee",
  "spotFee",
  "recipient",
  "collectorWallet",
  "tradingAccount",
  "walletAddress",
  "authorizationValidUntil",
  "accountChange",
  "exchangeFees",
  "scopeNote",
  "environment",
  "accountIndex",
  "apiKeyIndex",
  "collectorAccountIndex",
  "maxPerpsMakerFee",
  "maxPerpsTakerFee",
  "maxSpotMakerFee",
  "maxSpotTakerFee",
  "authorizationExpiryMs",
  "revoke",
  "publicKey",
] as const;

function fee(tick: number): string {
  if (!Number.isSafeInteger(tick) || tick < 0)
    throw new Error("Invalid fee precision.");
  const remainder = String(tick % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return `${Math.floor(tick / 10_000)}${remainder ? `.${remainder}` : ""}%`;
}

export function buildLighterFeeAuthorizationDisclosure(
  intent: LighterFeeAuthorizationIntentRow,
): Record<string, ApprovalPreviewScalar> {
  const t = intent.terms;
  return {
    toolId: "lighter.fees.approve",
    intentId: intent.intentId,
    summary: t.revoke
      ? "Revoke VEX trading fees"
      : "Authorize VEX trading fees",
    perpetualFee: `${fee(t.maxPerpsMakerFee)} maker / ${fee(t.maxPerpsTakerFee)} taker of executed trade value`,
    spotFee: `${fee(t.maxSpotMakerFee)} maker / ${fee(t.maxSpotTakerFee)} taker of executed trade value`,
    recipient: `VEX · Lighter account ${t.collectorAccountIndex}`,
    collectorWallet: t.collectorL1Address,
    tradingAccount: `${intent.environment === "core" ? "Lighter Core" : "Robinhood Chain"} · account ${intent.accountIndex}`,
    walletAddress: intent.walletAddress,
    authorizationValidUntil: t.revoke
      ? "Revoked"
      : new Date(t.authorizationExpiryMs).toISOString(),
    accountChange: t.targetTier
      ? `Change to ${t.targetTier === "plus" ? "Plus" : "Premium"}; applies to this wallet's Lighter account and subaccounts`
      : `Keep ${t.currentTier} account tier`,
    exchangeFees: `${t.targetTier ? "Up to " : ""}${fee(t.exchangeMakerFeeTick)} maker / ${fee(t.exchangeTakerFeeTick)} taker; separate from VEX fees`,
    scopeNote: t.revoke
      ? "Stop authorizing new VEX fee-bearing orders. Existing submitted orders retain their signed terms."
      : "Covers future VEX fills until expiry or revocation. Each trade still requires your normal approval. Spot fees reduce the asset received.",
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    collectorAccountIndex: t.collectorAccountIndex,
    maxPerpsMakerFee: t.maxPerpsMakerFee,
    maxPerpsTakerFee: t.maxPerpsTakerFee,
    maxSpotMakerFee: t.maxSpotMakerFee,
    maxSpotTakerFee: t.maxSpotTakerFee,
    authorizationExpiryMs: t.authorizationExpiryMs,
    revoke: t.revoke,
    publicKey: t.publicKey,
  };
}

/** Structural prepared-action check; approved dispatch also rebuilds from the durable intent. */
export function validateLighterFeeAuthorizationCriticalArgs(
  value: Record<string, unknown>,
  intentId: string,
): boolean {
  if (
    Object.keys(value).sort().join() !==
      [...LIGHTER_FEE_AUTHORIZATION_CRITICAL_KEYS].sort().join() ||
    value.intentId !== intentId ||
    value.toolId !== "lighter.fees.approve" ||
    (value.environment !== "core" && value.environment !== "rhc") ||
    typeof value.revoke !== "boolean" ||
    typeof value.publicKey !== "string" ||
    !/^[0-9a-f]{80}$/.test(value.publicKey) ||
    typeof value.walletAddress !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.walletAddress) ||
    typeof value.collectorWallet !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.collectorWallet)
  )
    return false;
  for (const key of ["accountIndex", "collectorAccountIndex"] as const) {
    if (
      !Number.isSafeInteger(value[key]) ||
      (value[key] as number) < 1 ||
      (value[key] as number) >= 2 ** 48 - 1
    )
      return false;
  }
  if (
    !Number.isInteger(value.apiKeyIndex) ||
    (value.apiKeyIndex as number) < 4 ||
    (value.apiKeyIndex as number) > 254 ||
    !Number.isSafeInteger(value.authorizationExpiryMs) ||
    (value.authorizationExpiryMs as number) < 0 ||
    (value.authorizationExpiryMs as number) >= 2 ** 48
  )
    return false;
  const perps = value.revoke ? 0 : 1000,
    spot = value.revoke ? 0 : 2500;
  if (
    value.maxPerpsMakerFee !== perps ||
    value.maxPerpsTakerFee !== perps ||
    value.maxSpotMakerFee !== spot ||
    value.maxSpotTakerFee !== spot ||
    (value.revoke
      ? value.authorizationExpiryMs !== 0
      : value.authorizationExpiryMs === 0)
  )
    return false;
  if (
    typeof value.accountChange !== "string" ||
    typeof value.exchangeFees !== "string"
  )
    return false;
  const keep = /^Keep (standard|plus|premium) account tier$/.exec(
    value.accountChange,
  );
  const change =
    /^Change to (Plus|Premium); applies to this wallet's Lighter account and subaccounts$/.exec(
      value.accountChange,
    );
  if (!keep && !change) return false;
  const targetTier = change
    ? change[1] === "Plus"
      ? "plus"
      : "premium"
    : null;
  if (value.revoke && targetTier) return false;
  if (
    targetTier &&
    targetTier !== (value.environment === "core" ? "plus" : "premium")
  )
    return false;
  const fees =
    /^(Up to )?(\d+(?:\.\d{1,4})?)% maker \/ (\d+(?:\.\d{1,4})?)% taker; separate from VEX fees$/.exec(
      value.exchangeFees,
    );
  if (!fees || Boolean(fees[1]) !== Boolean(targetTier)) return false;
  const tick = (text: string): number => {
    const [whole, fraction = ""] = text.split(".");
    return Number(whole) * 10000 + Number(fraction.padEnd(4, "0"));
  };
  const maker = tick(fees[2]!),
    taker = tick(fees[3]!);
  if (
    targetTier &&
    (maker !== (value.environment === "core" ? 50 : 120) ||
      taker !== (value.environment === "core" ? 50 : 350))
  )
    return false;
  try {
    const expected = buildLighterFeeAuthorizationDisclosure({
      intentId,
      sessionId: "",
      environment: value.environment,
      walletAddress: value.walletAddress,
      accountIndex: value.accountIndex as number,
      apiKeyIndex: value.apiKeyIndex as number,
      terms: {
        collectorAccountIndex: value.collectorAccountIndex as number,
        collectorL1Address: value.collectorWallet,
        maxPerpsMakerFee: perps,
        maxPerpsTakerFee: perps,
        maxSpotMakerFee: spot,
        maxSpotTakerFee: spot,
        authorizationExpiryMs: value.authorizationExpiryMs as number,
        revoke: value.revoke,
        publicKey: value.publicKey,
        currentTier: keep?.[1] ?? "standard",
        targetTier,
        exchangeMakerFeeTick: maker,
        exchangeTakerFeeTick: taker,
      },
      approvalId: null,
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
      nonceValue: null,
      txHash: null,
      txExpiryMs: null,
      failureReason: null,
      expiresAt: new Date(0),
      verifiedAt: null,
    });
    return Object.entries(expected).every(
      ([key, expectedValue]) => value[key] === expectedValue,
    );
  } catch {
    return false;
  }
}
