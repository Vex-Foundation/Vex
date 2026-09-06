/**
 * The mission run's START BASELINE: what the mission's wallets were worth at
 * the instant the run was created, frozen once and never re-measured.
 *
 * WHY IT EXISTS. On 2026-08-10 a live mission recomputed "deployed capital vs
 * target" by hand every turn, disagreed with itself across turns, and its
 * success criterion was nearly satisfied before the first trade because coins
 * the wallet already held counted toward a portfolio target. Nothing recorded
 * what the portfolio was worth when the run started, so every later turn had to
 * reconstruct it from prose. This module records that number once, with an
 * honest account of how good it is.
 *
 * ONE OWNER. The shape, the builder and the read-side parse live here together,
 * the same way `run-contract.ts` owns the contract snapshot. A second writer of
 * this blob would be a second definition of what "start" means.
 *
 * NEVER THROWS. `buildMissionBaseline` runs at the pre-commit seam of
 * `mission.start`. A rejection there would make a mission the user asked to
 * start newly refusable because a BALANCE READ failed, which is a bad trade:
 * the baseline is measurement, not authorization. Every failure instead becomes
 * an `absent` baseline carrying a NAMED reason, and an absent baseline is still
 * written - a NULL column would be indistinguishable from a run that started
 * before this feature existed.
 *
 * HONEST STATUS, NOT A CONVENIENT NUMBER. The status is a discriminated union:
 * `recorded` carries no caveats AND a portfolio, `partial` carries at least one
 * named caveat AND a portfolio, `absent` carries at least one reason and NO
 * portfolio. A stored blob that violates that (a `recorded` blob with no
 * portfolio, say) fails to parse and reads as no baseline at all, so an
 * unreadable figure can never render as a usable one.
 *
 * A `$0.00` total that only means "nothing had a price" is recorded as
 * `no_usd_prices`, never presented as a clean zero.
 */

import { z } from "zod";

import {
  getAssetHolding,
  getPortfolioValuation,
  type PortfolioValuation,
} from "@vex-agent/db/repos/balances.js";
import {
  listWallets,
  walletAddressesEqual,
  type InventoryFamily,
} from "@tools/wallet/inventory.js";
import { SOLANA_NATIVE_ASSET_IDENTITY } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../constants/solana-chain.js";
import logger from "@utils/logger.js";

import type { DeployedCapital } from "../types.js";

/** Bump only with a migration story: a stored blob of another version reads as absent. */
export const MISSION_BASELINE_VERSION = 1;

/**
 * Why a baseline is qualified or missing. Each code is rendered to the agent in
 * plain words at the point of use; the code itself is the durable fact.
 */
export const MISSION_BASELINE_REASONS = [
  "no_allowed_wallets",
  "wallets_not_in_inventory",
  "no_projection_rows",
  "no_usd_prices",
  "stale_projection",
  "valuation_failed",
  "valuation_timed_out",
  "deployed_capital_asset_ambiguous",
  "deployed_capital_decimals_mismatch",
] as const;

export type MissionBaselineReason = (typeof MISSION_BASELINE_REASONS)[number];

/**
 * Hard CALLER budget for the whole build. A SLOW projection read must not hold
 * the start path any more than a failing one: past the budget the baseline is
 * recorded as absent with `valuation_timed_out` and the mission starts.
 */
const BASELINE_BUDGET_MS = 4_000;

/**
 * SERVER-side bound handed to each valuation read, just inside the caller
 * budget. The race below only abandons the WAIT: without this, an abandoned
 * query keeps running and keeps holding one of the pool's connections, so turn
 * after turn could starve the pool. Postgres cancels the statement itself and
 * the cancellation arrives here as an ordinary failure, which is already named
 * `valuation_failed`.
 */
const BASELINE_STATEMENT_TIMEOUT_MS = 3_500;

/**
 * Three periodic balance-sync intervals (the job runs every 300s). Past this,
 * the figure is still recorded but flagged, because the alternative - hiding
 * that the number predates recent movement - is the dishonest one.
 */
const BASELINE_FRESHNESS_BUDGET_MS = 15 * 60_000;

const reasonSchema = z.enum(MISSION_BASELINE_REASONS);

const portfolioSchema = z.object({
  totalUsdEstimate: z.number(),
  pricedRowCount: z.number().int(),
  unpricedRowCount: z.number().int(),
  oldestSyncedAt: z.string().nullable(),
  newestSyncedAt: z.string().nullable(),
}).strict();

const deployedCapitalAtStartSchema = z.object({
  chainId: z.number().int(),
  assetAddress: z.string(),
  assetKind: z.enum(["native", "token"]).nullable().default(null),
  assetSymbol: z.string(),
  declaredAmountRaw: z.string(),
  declaredDecimals: z.number().int(),
  heldAmountRaw: z.string().nullable(),
  heldDecimals: z.number().int().nullable(),
  heldUsdEstimate: z.number().nullable(),
}).strict();

const commonShape = {
  version: z.literal(MISSION_BASELINE_VERSION),
  capturedAt: z.string(),
  source: z.literal("proj_balances"),
  /** The wallet set the START figure was measured over. The NOW side must reuse it verbatim. */
  scope: z.object({ addresses: z.array(z.string()) }).strict(),
  deployedCapitalAtStart: deployedCapitalAtStartSchema.nullable(),
};

const MissionBaselineSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("recorded"),
    reasons: z.array(reasonSchema).max(0),
    portfolio: portfolioSchema,
    ...commonShape,
  }).strict(),
  z.object({
    status: z.literal("partial"),
    reasons: z.array(reasonSchema).min(1),
    portfolio: portfolioSchema,
    ...commonShape,
  }).strict(),
  z.object({
    status: z.literal("absent"),
    reasons: z.array(reasonSchema).min(1),
    portfolio: z.null(),
    ...commonShape,
  }).strict(),
]);

export type MissionBaseline = z.infer<typeof MissionBaselineSchema>;
export type MissionBaselineDeployedCapital = z.infer<typeof deployedCapitalAtStartSchema>;

export interface BuildMissionBaselineInput {
  readonly missionId: string;
  readonly allowedWallets: readonly string[];
  readonly deployedCapital: DeployedCapital | null;
}

/** An absent baseline with one named reason. The fail-open value everywhere. */
export function absentBaseline(
  reason: MissionBaselineReason,
  addresses: readonly string[] = [],
): MissionBaseline {
  return {
    version: MISSION_BASELINE_VERSION,
    capturedAt: new Date().toISOString(),
    status: "absent",
    reasons: [reason],
    source: "proj_balances",
    scope: { addresses: [...addresses] },
    portfolio: null,
    deployedCapitalAtStart: null,
  };
}

/**
 * Measure the start baseline. NEVER THROWS and never returns a refusal: every
 * failure is an `absent` baseline with a named reason (see the module doc).
 */
export async function buildMissionBaseline(
  input: BuildMissionBaselineInput,
): Promise<MissionBaseline> {
  const work = measure(input).catch((err: unknown) => {
    logger.warn("engine.mission.baseline.valuation_failed", {
      missionId: input.missionId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return absentBaseline("valuation_failed");
  });
  return withBudget(work, input.missionId);
}

/** Parse a stored blob. Unparseable or absent yields `null` (no baseline). */
export function readMissionBaseline(raw: unknown): MissionBaseline | null {
  if (raw === null || raw === undefined) return null;
  const parsed = MissionBaselineSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── Build ───────────────────────────────────────────────────────────

async function measure(input: BuildMissionBaselineInput): Promise<MissionBaseline> {
  if (input.allowedWallets.length === 0) return absentBaseline("no_allowed_wallets");

  const addresses = matchInstalledWallets(input.allowedWallets);
  if (addresses.length === 0) return absentBaseline("wallets_not_in_inventory");

  const portfolio = await getPortfolioValuation(addresses, BASELINE_STATEMENT_TIMEOUT_MS);
  if (portfolio.pricedRowCount === 0 && portfolio.unpricedRowCount === 0) {
    return absentBaseline("no_projection_rows", addresses);
  }

  const reasons: MissionBaselineReason[] = [];
  // A zero total with unpriced rows is "nothing had a price", not "$0.00".
  if (portfolio.totalUsdEstimate === 0 && portfolio.unpricedRowCount > 0) {
    reasons.push("no_usd_prices");
  }
  if (isStale(portfolio.newestSyncedAt)) reasons.push("stale_projection");

  let deployedCapitalAtStart: MissionBaselineDeployedCapital | null = null;
  if (input.deployedCapital !== null) {
    const held = await readDeployedCapitalAtStart(addresses, input.deployedCapital);
    deployedCapitalAtStart = held.entry;
    if (held.assetIdentityAmbiguous) reasons.push("deployed_capital_asset_ambiguous");
    if (held.decimalsMismatch) reasons.push("deployed_capital_decimals_mismatch");
  }

  const common = {
    version: MISSION_BASELINE_VERSION,
    capturedAt: new Date().toISOString(),
    source: "proj_balances",
    scope: { addresses },
    portfolio: { ...portfolio },
    deployedCapitalAtStart,
  } as const;

  if (reasons.length === 0) return { ...common, status: "recorded", reasons: [] };
  return { ...common, status: "partial", reasons };
}

/**
 * Resolve the contract's allowed wallets to the addresses actually installed
 * here, using the SAME family-aware predicate the mission wallet policy
 * enforces. The INSTALLED address is what is returned, because that is the form
 * the balance projection is keyed by.
 */
function matchInstalledWallets(allowedWallets: readonly string[]): string[] {
  const installed: ReadonlyArray<{ family: InventoryFamily; address: string }> = [
    ...listWallets("evm").map((entry) => ({ family: "evm" as const, address: entry.address })),
    ...listWallets("solana").map((entry) => ({ family: "solana" as const, address: entry.address })),
  ];

  const matched: string[] = [];
  for (const entry of installed) {
    const isAllowed = allowedWallets.some((allowed) =>
      walletAddressesEqual(entry.family, entry.address, allowed),
    );
    if (isAllowed && !matched.includes(entry.address)) matched.push(entry.address);
  }
  return matched;
}

/**
 * What the wallets actually held of the declared asset. If the projection's
 * decimals disagree with the declared ones - or it recorded none - the held
 * amount, its decimals AND its USD estimate are left NULL and the caveat is
 * named. A raw amount read at the wrong scale is a thousandfold error, so we
 * decline rather than rescale.
 */
async function readDeployedCapitalAtStart(
  addresses: readonly string[],
  declared: DeployedCapital,
): Promise<{
  entry: MissionBaselineDeployedCapital;
  assetIdentityAmbiguous: boolean;
  decimalsMismatch: boolean;
}> {
  const projectionAddress = deployedCapitalProjectionAddress(declared);
  const declaredParts = {
    chainId: declared.chainId,
    assetAddress: declared.assetAddress,
    assetKind: declared.assetKind,
    assetSymbol: declared.assetSymbol,
    declaredAmountRaw: declared.amountRaw,
    declaredDecimals: declared.decimals,
  };
  if (projectionAddress === null) {
    return {
      entry: { ...declaredParts, heldAmountRaw: null, heldDecimals: null, heldUsdEstimate: null },
      assetIdentityAmbiguous: true,
      decimalsMismatch: false,
    };
  }
  const holding = await getAssetHolding(
    addresses,
    declared.chainId,
    projectionAddress,
    BASELINE_STATEMENT_TIMEOUT_MS,
  );

  // No row for the asset at all is an honest zero holding, not a caveat: the
  // mission may be about to acquire it. Native SOL has one compatibility
  // exception during rollout: before the first successful sync, an old row at
  // SOL_MINT may still contain the former merged native-plus-wSOL amount. It
  // is evidence that identity migration is pending, never an amount we may
  // consume. Report ambiguity until the new zero-or-held native row exists.
  if (holding.rowCount === 0) {
    const legacyMergedSolExists = declared.chainId === SOLANA_SYNTHETIC_CHAIN_ID
      && declared.assetKind === "native"
      && projectionAddress === SOLANA_NATIVE_ASSET_IDENTITY.persistedAddress
      && (await getAssetHolding(
        addresses,
        declared.chainId,
        SOL_MINT,
        BASELINE_STATEMENT_TIMEOUT_MS,
      )).rowCount > 0;
    return {
      entry: { ...declaredParts, heldAmountRaw: null, heldDecimals: null, heldUsdEstimate: null },
      assetIdentityAmbiguous: legacyMergedSolExists,
      decimalsMismatch: false,
    };
  }

  const decimalsMismatch = holding.heldDecimals !== declared.decimals;
  if (decimalsMismatch) {
    return {
      entry: { ...declaredParts, heldAmountRaw: null, heldDecimals: null, heldUsdEstimate: null },
      assetIdentityAmbiguous: false,
      decimalsMismatch: true,
    };
  }

  return {
    entry: {
      ...declaredParts,
      heldAmountRaw: holding.heldAmountRaw,
      heldDecimals: holding.heldDecimals,
      heldUsdEstimate: holding.heldUsdEstimate,
    },
    assetIdentityAmbiguous: false,
    decimalsMismatch: false,
  };
}

/**
 * Translate a structurally native SOL declaration to the distinct key used
 * only inside `proj_balances`.
 *
 * Native SOL and wSOL share SOL_MINT for routing. `assetKind`, never the
 * address or display symbol, selects the persisted row. A legacy declaration
 * with no kind returns null and is reported ambiguous rather than guessed.
 */
function deployedCapitalProjectionAddress(declared: DeployedCapital): string | null {
  if (
    declared.chainId !== SOLANA_SYNTHETIC_CHAIN_ID
    || declared.assetAddress !== SOL_MINT
  ) {
    return declared.assetAddress;
  }
  if (declared.assetKind === "native") {
    return SOLANA_NATIVE_ASSET_IDENTITY.persistedAddress;
  }
  if (declared.assetKind === "token") return declared.assetAddress;
  return null;
}

function isStale(newestSyncedAt: PortfolioValuation["newestSyncedAt"]): boolean {
  if (newestSyncedAt === null) return false;
  const syncedAtMs = Date.parse(newestSyncedAt);
  if (!Number.isFinite(syncedAtMs)) return false;
  return Date.now() - syncedAtMs > BASELINE_FRESHNESS_BUDGET_MS;
}

/** Resolve to a timed-out baseline when `work` exceeds the budget. Never rejects. */
async function withBudget(
  work: Promise<MissionBaseline>,
  missionId: string,
): Promise<MissionBaseline> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<MissionBaseline>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("engine.mission.baseline.timed_out", { missionId });
      resolve(absentBaseline("valuation_timed_out"));
    }, BASELINE_BUDGET_MS);
    // Do not keep the process alive for a baseline timer.
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
