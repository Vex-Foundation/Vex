/**
 * The DURABLE PLAN: every leg a Morpho execution will broadcast, described as a
 * complete `agent_activity` row, created before anything is signed (§11.1 step
 * 1).
 *
 * WHY THE OPERATION LEG HAS NO CALLDATA HERE, and why that is not a hole. The
 * approval must LAND before the deposit can be built against state it can
 * actually run in - a deposit built now would be bounded by a share price two
 * transactions in the past. But the intent row must exist before ANY leg is
 * signed, so the row is written from what plan time genuinely knows (the tokens,
 * the amounts, the verified target) and the calldata is built later by phase 2
 * of `@tools/morpho/mutations.js`. What plan time claims and what phase 2 builds
 * are then reconciled: the target is recorded here and re-asserted there, so a
 * transaction cannot be broadcast against a contract the row does not name.
 *
 * EVERY LEG CARRIES ITS TOKEN, SYMBOL, DECIMALS, HUMAN AND RAW AMOUNT. Rules/90:
 * a raw amount without its decimals is off by a factor of a thousand or more,
 * and a share amount and an asset amount live in the same row at DIFFERENT
 * scales (18 against 6 for a USDC vault) - which is precisely the pair that
 * makes a single `decimals` field a money bug.
 *
 * AN ALLOWANCE LEG'S AMOUNT IS NOT A TRANSFER. It is recorded on `tokenIn`
 * because that is where the whole repository records it (kyberswap, pendle,
 * bridge), and the settlement decoder declines those roles by name for exactly
 * this reason: an approval moves nothing, so no net delta could confirm it.
 */

import { formatUnits, getAddress, type Address, type Hex } from "viem";

import type { MorphoAllowancePlan, MorphoVaultState } from "@tools/morpho/mutations.js";
import {
  createAgentActivityIntent,
  settlementDecodeProvenance,
  type AgentActivityEvent,
  type AgentActivityLegInput,
  type CreatePendingActivityEventInput,
} from "@vex-agent/db/repos/agent-activity.js";

import {
  MORPHO_ACTIVITY_CHAIN_FAMILY,
  MORPHO_ACTIVITY_KIND,
  MORPHO_ACTIVITY_PROTOCOL,
  morphoActivityChainSlug,
  type MorphoActivityRole,
} from "./protocol.js";

/** One planned broadcast: its durable row, and its transaction when known. */
export interface MorphoLegPlan {
  readonly eventRole: MorphoActivityRole;
  /**
   * The transaction to sign. `null` on the OPERATION leg alone, whose calldata
   * is built after the approvals land - see the module header.
   */
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value: bigint } | null;
  readonly event: Omit<CreatePendingActivityEventInput, "protocolExecutionId" | "eventIndex">;
}

export interface MorphoIntentInput {
  readonly toolId: string;
  readonly sessionId: string;
  /** Raw handler params - sanitized inside `createExecutionIntent`, not here. */
  readonly intentParams: Record<string, unknown>;
  readonly chainId: number;
  readonly walletAddress: Address;
  readonly direction: "deposit" | "withdraw";
  readonly state: MorphoVaultState;
  /** The ASSET amount the operation moves, in raw base units. */
  readonly amountRaw: bigint;
  /** Shares expected to mint (deposit) or burn (withdrawal), at plan time. */
  readonly expectedSharesRaw: bigint;
  /** `null` on a withdrawal, which pulls nothing and needs no authorisation. */
  readonly allowancePlan: MorphoAllowancePlan | null;
  /**
   * The target the handler's OWN bundle decoder accepted: the pinned Bundler3 on
   * a deposit, the vault itself on a withdrawal. Never a value echoed back from
   * the SDK.
   */
  readonly verifiedTarget: Address;
}

/** The leg every direction ends with, and the role it is filed under. */
export function morphoOperationRole(direction: "deposit" | "withdraw"): MorphoActivityRole {
  return direction === "deposit" ? "lend_deposit" : "lend_withdraw";
}

/** Build the complete leg plan, in send order. */
export function planMorphoLegs(input: MorphoIntentInput): readonly MorphoLegPlan[] {
  const { state, chainId, walletAddress, sessionId } = input;
  const chainSlug = morphoActivityChainSlug(chainId);
  const assetLeg = (raw: bigint): AgentActivityLegInput => ({
    tokenAddress: state.assetAddress.toLowerCase(),
    ...(state.assetSymbol === null ? {} : { tokenSymbol: state.assetSymbol }),
    tokenDecimals: state.assetDecimals,
    amountHuman: formatUnits(raw, state.assetDecimals),
    amountRaw: raw.toString(),
  });
  const shareLeg = (raw: bigint): AgentActivityLegInput => ({
    tokenAddress: state.address.toLowerCase(),
    ...(state.shareSymbol === null ? {} : { tokenSymbol: state.shareSymbol }),
    tokenDecimals: state.shareDecimals,
    amountHuman: formatUnits(raw, state.shareDecimals),
    amountRaw: raw.toString(),
  });
  const common = {
    kind: MORPHO_ACTIVITY_KIND,
    protocol: MORPHO_ACTIVITY_PROTOCOL,
    chainId,
    ...(chainSlug === undefined ? {} : { chainSlug }),
    // Stated, never defaulted. Migration 079 widened the family CHECK to admit
    // `eip155` for `lend`, so the database no longer catches an omission here.
    chainFamily: MORPHO_ACTIVITY_CHAIN_FAMILY,
    walletAddress: walletAddress.toLowerCase(),
    sessionId,
  } as const;

  const legs: MorphoLegPlan[] = [];

  for (const step of input.allowancePlan?.steps ?? []) {
    legs.push({
      eventRole: step.kind,
      txParams: { to: step.to, data: step.data, value: 0n },
      event: {
        ...common,
        eventRole: step.kind,
        tokenIn: assetLeg(step.amountRaw),
        routeProvenance: morphoRouteProvenance(input, step.to),
      },
    });
  }

  const operationRole = morphoOperationRole(input.direction);
  legs.push({
    eventRole: operationRole,
    txParams: null,
    event: {
      ...common,
      eventRole: operationRole,
      // A deposit spends the asset and receives shares; a withdrawal burns
      // shares and receives the asset. The two are mirror images and the row
      // says which way round it is, at both scales.
      tokenIn: input.direction === "deposit" ? assetLeg(input.amountRaw) : shareLeg(input.expectedSharesRaw),
      tokenOut: input.direction === "deposit" ? shareLeg(input.expectedSharesRaw) : assetLeg(input.amountRaw),
      routeProvenance: {
        ...morphoRouteProvenance(input, input.verifiedTarget),
        // R1 Step 5a - the decode inputs, persisted at INTENT time. The router
        // is the target this handler's own bundle decoder accepted and the one
        // the transaction is re-asserted against before it is sent, so the hint
        // cannot name a contract the transaction did not use.
        ...settlementDecodeProvenance({
          decoder: "morpho",
          chainId,
          routerAddress: getAddress(input.verifiedTarget),
        }),
      },
    },
  });

  return legs;
}

/**
 * The venue discriminants a receipt alone does not supply. Small on purpose: the
 * settlement decode is wallet-relative and reads only the row's own columns, so
 * anything more here would be a claim the repair lane never consults.
 */
function morphoRouteProvenance(input: MorphoIntentInput, target: Address): Record<string, unknown> {
  return {
    morpho: {
      vaultAddress: input.state.address.toLowerCase(),
      vaultGeneration: input.state.generation,
      direction: input.direction,
      target: target.toLowerCase(),
    },
  };
}

/**
 * Create the execution intent and every leg row atomically, BEFORE a signature
 * exists. A throw here is pre-signature and must propagate: refusing to
 * transact beats transacting untracked.
 */
export async function createMorphoIntent(
  toolId: string,
  intentParams: Record<string, unknown>,
  legs: readonly MorphoLegPlan[],
): Promise<{ executionId: number; events: AgentActivityEvent[] }> {
  return createAgentActivityIntent({
    toolId,
    namespace: MORPHO_ACTIVITY_PROTOCOL,
    intentParams,
    events: legs.map((leg, index) => ({ ...leg.event, eventIndex: index })),
  });
}
