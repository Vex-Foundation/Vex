import { z } from "zod";

import { resolveHyperliquidNetwork } from "@tools/hyperliquid/constants.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { hyperliquidPolicySchema } from "@vex-lib/hyperliquid-policy.js";
import { CH, EV } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  hyperliquidRiskAcknowledgementInputSchema,
  hyperliquidRiskProposalConfirmInputSchema,
  hyperliquidRiskProposalDtoSchema,
  hyperliquidRiskProposalsDtoSchema,
  hyperliquidRiskProposalsReadInputSchema,
  hyperliquidSessionRiskPolicyDtoSchema,
  hyperliquidSessionRiskPolicyReadInputSchema,
  hyperliquidSessionRiskPolicySetInputSchema,
  type HyperliquidRiskProposalDto,
  type HyperliquidRiskProposalsDto,
  type HyperliquidSessionRiskPolicyDto,
} from "@shared/schemas/hyperliquid.js";
import { preferencesSchema, type Preferences } from "@shared/schemas/preferences.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import {
  activateHyperliquidRiskProposal,
  createAdjustedHyperliquidRiskProposal,
  getHyperliquidSessionRiskPolicy,
  listHyperliquidRiskProposals,
  setHyperliquidSessionRiskPolicy,
} from "../../database/hyperliquid-db.js";
import { getSessionWalletScope } from "../../database/sessions-db.js";
import { setActiveHyperliquidPolicyOverlay } from "../../hyperliquid/policy-provider.js";
import { log } from "../../logger/index.js";
import { preferencesStore } from "../../preferences/store.js";
import { registerHandler } from "../register-handler.js";
import { unavailable } from "./support.js";

const hyperliquidMetaSchema = z.object({
  universe: z.array(z.object({
    name: z.string(),
    maxLeverage: z.union([z.number(), z.string()]),
  }).passthrough()),
}).passthrough();

async function withUpdatedHyperliquidPreferences(
  update: (preferences: Preferences["hyperliquid"]) => Preferences["hyperliquid"],
): Promise<Preferences> {
  const current = await preferencesStore.load();
  return preferencesStore.update({ hyperliquid: update(current.hyperliquid) });
}

async function maxLeverageForCoin(coin: string): Promise<number | null> {
  const raw = await new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }).meta();
  const meta = hyperliquidMetaSchema.safeParse(raw);
  if (!meta.success) return null;
  for (const entry of meta.data.universe) {
    if (entry.name !== coin) continue;
    const max = typeof entry.maxLeverage === "number"
      ? entry.maxLeverage
      : Number(entry.maxLeverage);
    return Number.isSafeInteger(max) && max >= 1 ? max : null;
  }
  return null;
}

async function validateProposalLeverage(
  proposal: HyperliquidRiskProposalDto,
  correlationId: string,
) {
  try {
    const maxLeverage = await maxLeverageForCoin(proposal.coin);
    if (maxLeverage === null) {
      return unavailable(
        "Unable to verify this market's maximum leverage. Retry when Hyperliquid market data is available.",
        correlationId,
      );
    }
    if (proposal.policy.leverageCapDefault > maxLeverage) {
      return err({
        code: "validation.invalid_input",
        domain: "hyperliquid",
        message: `The selected leverage exceeds ${proposal.coin}'s current maximum of ${maxLeverage}x.`,
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
      });
    }
    return null;
  } catch (cause) {
    log.warn("[ipc:hyperliquid] max leverage validation failed", cause);
    return unavailable(
      "Unable to verify this market's maximum leverage. Retry when Hyperliquid market data is available.",
      correlationId,
    );
  }
}

/** An all-core-perps session cap must be valid for every currently listed core perp. */
async function validateSessionPolicyLeverage(
  leverageCapDefault: number,
  correlationId: string,
): Promise<Result<never> | null> {
  try {
    const raw = await new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }).meta();
    const meta = hyperliquidMetaSchema.safeParse(raw);
    if (!meta.success) {
      return unavailable(
        "Unable to verify the current Hyperliquid leverage limit. Retry when market data is available.",
        correlationId,
      );
    }
    const bounds = meta.data.universe.flatMap((entry) => {
      const value = typeof entry.maxLeverage === "number" ? entry.maxLeverage : Number(entry.maxLeverage);
      return Number.isSafeInteger(value) && value >= 1 ? [value] : [];
    });
    // The session cap is asset-AGNOSTIC: the protection gate always clamps
    // per order to min(cap, that asset's maxLeverage), so the only honest
    // venue bound here is the HIGHEST max across the universe. (Math.min
    // would let one 3x micro-cap forbid a 10x cap on 40x BTC.)
    const assetAgnosticMax = bounds.length === 0 ? null : Math.max(...bounds);
    if (assetAgnosticMax === null) {
      return unavailable(
        "Unable to verify the current Hyperliquid leverage limit. Retry when market data is available.",
        correlationId,
      );
    }
    if (leverageCapDefault > assetAgnosticMax) {
      return err({
        code: "validation.invalid_input",
        domain: "hyperliquid",
        message: `The selected leverage exceeds the current all-market maximum of ${assetAgnosticMax}x.`,
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
      });
    }
    return null;
  } catch (cause) {
    log.warn("[ipc:hyperliquid] session policy leverage validation failed", cause);
    return unavailable(
      "Unable to verify the current Hyperliquid leverage limit. Retry when market data is available.",
      correlationId,
    );
  }
}

function registerRiskProposalsReadHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.listRiskProposals,
    domain: "hyperliquid",
    inputSchema: hyperliquidRiskProposalsReadInputSchema,
    outputSchema: hyperliquidRiskProposalsDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidRiskProposalsDto>> => {
      const proposals = await listHyperliquidRiskProposals(input.sessionId, ctx.requestId);
      return proposals.ok
        ? ok({ sessionId: input.sessionId, proposals: [...proposals.data] })
        : proposals;
    },
  });
}

function registerAcknowledgeRiskHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.acknowledgeRisk,
    domain: "hyperliquid",
    inputSchema: hyperliquidRiskAcknowledgementInputSchema,
    outputSchema: preferencesSchema,
    handle: async (): Promise<Result<Preferences>> => {
      const preferences = await withUpdatedHyperliquidPreferences((hyperliquid) => ({
        ...hyperliquid,
        riskAcknowledgedAt: new Date().toISOString(),
      }));
      return ok(preferencesSchema.parse(preferences));
    },
  });
}


function registerConfirmRiskProposalHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.confirmRiskProposal,
    domain: "hyperliquid",
    inputSchema: hyperliquidRiskProposalConfirmInputSchema,
    outputSchema: hyperliquidRiskProposalDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidRiskProposalDto>> => {
      const proposals = await listHyperliquidRiskProposals(input.sessionId, ctx.requestId);
      if (!proposals.ok) return proposals;
      const source = proposals.data.find((proposal) => proposal.proposalId === input.proposalId);
      if (source === undefined || source.status !== "proposed") {
        return err({
          code: "validation.invalid_input",
          domain: "hyperliquid",
          message: "That Hyperliquid risk proposal is no longer available.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }

      const adjusted = input.adjustments === null
        ? ok(source)
        : await createAdjustedHyperliquidRiskProposal(
          input.sessionId,
          source.proposalId,
          input.adjustments,
          ctx.requestId,
        );
      if (!adjusted.ok) return adjusted;

      const leverageError = await validateProposalLeverage(adjusted.data, ctx.requestId);
      if (leverageError !== null) return leverageError;

      const activated = await activateHyperliquidRiskProposal(
        input.sessionId,
        adjusted.data.proposalId,
        ctx.requestId,
      );
      if (!activated.ok) return activated;

      const scope = await getSessionWalletScope(input.sessionId);
      if (!scope.ok || scope.data.evm === null) {
        return unavailable(
          "Unable to resolve the selected wallet for this Hyperliquid risk policy.",
          ctx.requestId,
        );
      }
      await setActiveHyperliquidPolicyOverlay({
        sessionId: input.sessionId,
        walletAddress: scope.data.evm.address,
        proposalId: activated.data.proposalId,
        policy: activated.data.policy,
        expiresAt: activated.data.expiresAt,
      });
      broadcastToAllWindows(EV.hyperliquid.riskProposalUpdate, activated.data);
      return activated;
    },
  });
}

function registerSetSessionRiskPolicyHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.setSessionRiskPolicy,
    domain: "hyperliquid",
    inputSchema: hyperliquidSessionRiskPolicySetInputSchema,
    outputSchema: hyperliquidRiskProposalDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidRiskProposalDto>> => {
      // Resolve the trusted wallet before touching exchange metadata or the
      // policy table. The renderer cannot create a policy for another wallet.
      const scope = await getSessionWalletScope(input.sessionId);
      if (!scope.ok) return scope;
      if (scope.data.evm === null) {
        return err({
          code: "validation.invalid_input",
          domain: "hyperliquid",
          message: "Select an EVM wallet for this session before setting Hyperliquid risk.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
      const leverageError = await validateSessionPolicyLeverage(input.leverageCapDefault, ctx.requestId);
      if (leverageError !== null) return leverageError;
      const activated = await setHyperliquidSessionRiskPolicy(input.sessionId, {
        leverageCapDefault: input.leverageCapDefault,
        perOrderNotionalPct: input.perOrderNotionalPct,
        totalNotionalPct: input.totalNotionalPct,
      }, ctx.requestId);
      if (!activated.ok) return activated;
      await setActiveHyperliquidPolicyOverlay({
        sessionId: input.sessionId,
        walletAddress: scope.data.evm.address,
        proposalId: activated.data.proposalId,
        policy: activated.data.policy,
        expiresAt: activated.data.expiresAt,
      });
      broadcastToAllWindows(EV.hyperliquid.riskProposalUpdate, activated.data);
      return activated;
    },
  });
}

function registerGetSessionRiskPolicyHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.getSessionRiskPolicy,
    domain: "hyperliquid",
    inputSchema: hyperliquidSessionRiskPolicyReadInputSchema,
    outputSchema: hyperliquidSessionRiskPolicyDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidSessionRiskPolicyDto>> => {
      const preferences = await preferencesStore.load();
      return getHyperliquidSessionRiskPolicy(
        input.sessionId,
        hyperliquidPolicySchema.parse(preferences.hyperliquid.policy),
        ctx.requestId,
      );
    },
  });
}

export function registerHyperliquidRiskPolicyHandlers(): Array<() => void> {
  return [
    registerRiskProposalsReadHandler(),
    registerAcknowledgeRiskHandler(),
    registerConfirmRiskProposalHandler(),
    registerSetSessionRiskPolicyHandler(),
    registerGetSessionRiskPolicyHandler(),
  ];
}

