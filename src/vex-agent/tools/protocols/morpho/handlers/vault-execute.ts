/**
 * `morpho.vault.deposit` and `morpho.vault.withdraw` - the two agent-facing
 * tools that actually move money on Morpho.
 *
 * ONE SPINE, TWO TOOLS. The direction is the only thing that differs between
 * them at this layer, and it is passed as an argument rather than duplicated:
 * two near-identical handlers is the shape `signed-broadcast.ts` refuses at the
 * layer below, for the same reason. Everything direction-specific below is
 * either a param key (owned by `./vault-execute/params.ts`) or a sentence.
 *
 * ── WHAT THIS HANDLER OWNS, AND WHAT IT REFUSES TO OWN ──────────────────────
 *
 * It owns exactly four things:
 *
 *   1. VALIDATION. Model input is untrusted until parsed. There is no fee, no
 *      limit, no destination and no recipient param, and the wrong direction's
 *      amount key is refused BY NAME rather than dropped.
 *   2. THE CHAIN ID, resolved from Vex's own registry, never from model input.
 *   3. THE CLIENTS. The signing wallet comes from the session's wallet
 *      resolution; the public and wallet clients are built together from one
 *      chain definition so the estimate is read from the chain the transaction
 *      is sent to.
 *   4. THE DISCLOSURE, and the outcome wording the agent reads.
 *
 * It owns NOTHING about the transaction itself. The plan, the exact-amount
 * approval, the leg ordering, the durable rows, the receipts and the proven
 * amounts all belong to `./signed-broadcast.ts`, which is the one owner of
 * sign+broadcast+record for this namespace.
 *
 * ── THE DISCLOSURE, AND WHERE IT FAILS CLOSED ───────────────────────────────
 *
 * Rules/90's ruling is DISCLOSE, DO NOT BLOCK: a gated vault, a queued curator
 * change or a RED warning is a hazard the user must be TOLD about, not an
 * operation Vex silently refuses on their behalf. So a vault that reports a
 * withdrawal gate is still executable and the gate rides on the output.
 *
 * The one thing that is NOT disclosure-and-proceed is a disclosure that cannot
 * be produced at all. On the LIVE path, if Morpho's governance read does not
 * answer, Vex cannot tell the user whether this vault can refuse their exit, and
 * spending real funds on an unanswerable question is the opposite of the
 * conservative reading a money path owes. That case REFUSES, before anything is
 * signed, and says the read failed rather than implying the vault is unsafe. A
 * `dryRun` does not refuse: nothing is at stake in a preview, so it degrades to
 * an explicit "gating UNKNOWN" exactly as `morpho.vault.quote` does.
 *
 * ── WHY THERE IS NO GENERIC ERROR IN THIS FILE ──────────────────────────────
 *
 * Rules/04's owner decree: an agent- or UI-facing tool error surfaces the REAL
 * cause in agent-friendly words, sanitized, never silenced into "unexpected
 * error". Every failure path below names what happened and what to do about it,
 * and the four execution endings are reported as themselves rather than
 * collapsed into success-or-failure.
 */

import { getAddress, type Address, type Hex } from "viem";

import { getMorphoClient } from "@tools/morpho/client.js";
import { getMorphoEvmClients } from "@tools/morpho/evm-client.js";
import {
  morphoActionsExtension,
  previewMorphoVaultOperation,
  type MorphoVaultDirection,
} from "@tools/morpho/mutations.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  projectQuoteGovernance,
  type MorphoQuoteGovernance,
  type ProjectedQuoteGovernance,
} from "../projectors.js";
import {
  executeMorphoVaultDeposit,
  executeMorphoVaultWithdraw,
  recordMorphoRefusal,
  type MorphoExecutionOutcome,
} from "./signed-broadcast.js";
import { morphoFailureDetail } from "./shared.js";
import {
  parseMorphoVaultExecuteParams,
  type MorphoVaultExecuteQuery,
} from "./vault-execute/params.js";

const TOOL_ID: Record<MorphoVaultDirection, string> = {
  deposit: "morpho.vault.deposit",
  withdraw: "morpho.vault.withdraw",
};

/** The consent model, restated in the OUTPUT so it is not only in the manifest. */
const PLAN_NOTE: Record<MorphoVaultDirection, string> = {
  deposit:
    "This deposit is up to TWO transactions behind one consent: an ERC-20 approve() for exactly this amount to the "
    + "chain's pinned GeneralAdapter1, then the deposit. They are not atomic, so a failure after the approval lands "
    + "leaves a standing allowance capped at this amount, which the failure output names.",
  withdraw:
    "This withdrawal is ONE transaction: a direct withdraw() call on the vault, which burns the caller's own shares. "
    + "There is no approval, no bundle and no standing allowance.",
};

export async function morphoVaultDeposit(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoVaultExecute("deposit", params, context);
}

export async function morphoVaultWithdraw(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoVaultExecute("withdraw", params, context);
}

async function runMorphoVaultExecute(
  direction: MorphoVaultDirection,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = TOOL_ID[direction];
  const parsed = parseMorphoVaultExecuteParams(toolId, direction, params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const query = parsed.value;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${toolId} requires an active session, because every attempt is recorded against one.`);

  if (query.dryRun) return previewOnly(toolId, query, context);

  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") {
    return fail(`${toolId} needs an EVM wallet; the session resolved a ${signer.family} one.`);
  }
  const walletAddress = getAddress(signer.address);

  // DISCLOSURE BEFORE SIGNATURE. Fail-closed on the live path only: see header.
  const governance = await readGovernance(query.vaultAddress, query.chainId);
  const disclosure = projectQuoteGovernance(governance);
  if (disclosure.status !== "read") {
    const message =
      `${toolId} refused: Morpho's governance read did not answer for this vault, so Vex cannot tell you whether a `
      + "gate can block this operation on chain, what is queued against the vault, or whether it carries a RED "
      + `warning. NOTHING was signed and no gas was spent. This is a gap in the check rather than a verdict on the `
      + `vault: retry, and if the read keeps failing, report Morpho's API rather than the vault. Cause: `
      + `${governance.status === "unavailable" ? governance.reason : "unknown"}.`;
    await recordMorphoRefusal(
      {
        toolId,
        sessionId,
        intentParams: query.echo,
        chainId: query.chainId,
        walletAddress,
        direction,
      },
      "unknown",
      message,
    );
    return fail(message);
  }

  const { publicClient, walletClient } = getMorphoEvmClients(query.chainId, signer.privateKey as Hex);
  const clients = {
    publicClient,
    walletClient,
    actionClient: publicClient.extend(morphoActionsExtension()),
  };
  const request = {
    toolId,
    sessionId,
    intentParams: query.echo,
    chainId: query.chainId,
    vaultAddress: getAddress(query.vaultAddress) as Address,
    walletAddress,
    amountRaw: query.amountRaw,
    slippageBps: query.slippageBps,
  };

  let outcome: MorphoExecutionOutcome;
  try {
    outcome = direction === "deposit"
      ? await executeMorphoVaultDeposit(clients, request)
      : await executeMorphoVaultWithdraw(clients, request);
  } catch (err) {
    // A PLAN-time refusal: no durable row exists and nothing was signed, so the
    // refusal is recorded here and reported with its real cause.
    const message =
      `${toolId} refused before signing anything: ${morphoFailureDetail(err)}. No transaction was sent and no gas `
      + "was spent.";
    await recordMorphoRefusal(
      { toolId, sessionId, intentParams: query.echo, chainId: query.chainId, walletAddress, direction },
      "unknown",
      message,
    );
    return fail(message);
  }

  return renderOutcome(toolId, direction, query, disclosure, outcome);
}

/**
 * `dryRun` - the full preview, signing nothing.
 *
 * It runs the SAME preview `morpho.vault.quote` runs, against the session's
 * selected wallet rather than a stand-in, so the allowance plan it reports is
 * the real one this wallet would face rather than a fresh wallet's. It does not
 * resolve a signing wallet and never touches key material.
 */
async function previewOnly(
  toolId: string,
  query: MorphoVaultExecuteQuery,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  let walletAddress: string | undefined;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch {
    // A preview with no selected wallet is still useful: it becomes the
    // fresh-wallet view, and the reply says which one it is rather than
    // implying the allowance shown belongs to somebody.
    walletAddress = undefined;
  }

  let quote;
  try {
    quote = await previewMorphoVaultOperation({
      chainId: query.chainId,
      vaultAddress: getAddress(query.vaultAddress) as Address,
      direction: query.direction,
      amountRaw: query.amountRaw,
      slippageBps: query.slippageBps,
      ...(walletAddress === undefined ? {} : { walletAddress: getAddress(walletAddress) as Address }),
    });
  } catch (err) {
    return fail(`${toolId} could not build the preview: ${morphoFailureDetail(err)}. Nothing was signed or sent.`);
  }

  const disclosure = projectQuoteGovernance(await readGovernance(query.vaultAddress, query.chainId));

  return ok({
    dryRun: true,
    toolId,
    chain: query.chainSlug,
    filtersApplied: query.echo,
    quote,
    allowancePlan: quote.allowance,
    requirements: quote.requirements,
    governance: disclosure,
    plan: PLAN_NOTE[query.direction],
    notes: {
      committed:
        "NOTHING WAS SIGNED, SENT, APPROVED OR RECORDED AS EXECUTED. This is a preview of what this exact call would "
        + "do, not a promise about what it will do: the share price accrues and the vault's state can change before "
        + "any real transaction.",
      wallet: walletAddress === undefined
        ? "No wallet is selected for this chain in the session, so the allowance plan is what a FRESH wallet would "
          + "face. A wallet with an existing allowance would face fewer steps."
        : "The allowance plan reflects the session's selected wallet and its CURRENT allowance, so a step it has "
          + "already satisfied is absent rather than repeated.",
      gating: disclosure.status === "read"
        ? disclosure.note
        : "Morpho's governance read did not answer, so gating is UNKNOWN rather than absent. A real call would REFUSE "
          + "rather than proceed without this.",
    },
  });
}

/**
 * Morpho's own vault read, for the governance facts the on-chain preview cannot
 * see. Its failure is carried as a cause rather than thrown, and the caller
 * decides what that costs.
 */
async function readGovernance(vaultAddress: string, chainId: number): Promise<MorphoQuoteGovernance> {
  try {
    const detail = await getMorphoClient().getVault(
      { vaultAddress, chainId, includeAllocations: false, includeHistory: false },
      undefined,
    );
    return { status: "read", detail };
  } catch (err) {
    return { status: "unavailable", reason: morphoFailureDetail(err) };
  }
}

/**
 * Turn one of the four execution endings into the tool's own result.
 *
 * FOUR ENDINGS, FOUR ANSWERS. Only `confirmed` is a success. `refused` and
 * `reverted` are failures whose real cause and remediation the execution layer
 * already worded, and they are passed through rather than reworded into
 * something vaguer. `unproven` is the one that must never read as either: it
 * carries an explicit do-not-retry, because the transaction may already have
 * moved real funds.
 */
function renderOutcome(
  toolId: string,
  direction: MorphoVaultDirection,
  query: MorphoVaultExecuteQuery,
  governance: ProjectedQuoteGovernance,
  outcome: MorphoExecutionOutcome,
): ToolResult {
  const shared = {
    toolId,
    direction,
    chain: query.chainSlug,
    vaultAddress: query.vaultAddress,
    executionId: outcome.executionId,
    governance,
    plan: PLAN_NOTE[direction],
  };

  if (outcome.kind === "confirmed") {
    logger.info("morpho.vault.execute.confirmed", { toolId, chainId: query.chainId });
    return ok({
      ...shared,
      status: "confirmed",
      txHash: outcome.txHash,
      executed: outcome.executed,
      shares: outcome.shares,
      summary: outcome.message,
      notes: {
        proven:
          "The amounts above are PROVEN from the receipt's own logs, not copied from the quote. `executed` carries "
          + "the asset and the shares at their own decimals; the two scales are different and must not be compared.",
        accrualDrift:
          "`shares.accrualDriftRaw` is the plain difference between the quoted and the settled share count. It is "
          + "the interest the vault earned between the two blocks, it grows with delay and size, and on its own it "
          + "is normal. `shares.withinApprovedBound` is the verdict that matters.",
      },
    });
  }

  if (outcome.kind === "unproven") {
    // Not a success and not a clean failure. The wording refuses a retry and
    // promises the automatic resolution this lane can actually keep.
    return {
      success: false,
      output: outcome.message,
      data: { ...shared, status: "unproven", reason: outcome.reason, txHash: outcome.txHash },
    };
  }

  return {
    success: false,
    output: outcome.message,
    data: {
      ...shared,
      status: outcome.kind,
      role: outcome.role,
      ...(outcome.kind === "reverted" ? { txHash: outcome.txHash } : {}),
    },
  };
}
