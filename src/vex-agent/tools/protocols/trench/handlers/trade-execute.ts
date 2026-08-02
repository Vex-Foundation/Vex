/**
 * `trench.trade_execute` handler — curve BUY/SELL on Robinhood Chain (4663).
 *
 * This file is the PUBLIC ENTRY POINT and owns only the ordering of the money
 * path; each stage lives in the `trade/` sibling folder:
 *
 *   `trade/shared.ts`          boundary validation (fee/limit/deadline/recipient
 *                              are NEVER accepted from model input)
 *   `trade/plan.ts`            fresh-quote → legs + rows + the native-value gate
 *   `trade/staged-loop.ts`     the sign → persist → broadcast loop
 *   `trade/finalize.ts`        decoding a confirmed swap (declines, never guesses)
 *   `trade/failure-results.ts` both failure paths
 *   `trade/execute-identity.ts` the shared tool/protocol/chain identity
 *
 * The order here is the safety property: address-only wallet resolve → signing
 * wallet → local EVM clients → a FRESH deterministic quote → a Vex-derived
 * minimum output (never zero, never a caller number) + a LOCAL deadline → a
 * durable `agent_activity` intent BEFORE any broadcast → only then the staged
 * loop. Ambiguity never terminalizes and is never re-broadcast.
 */

import { parseUnits, formatEther, getAddress, type Address } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalEvmClients } from "@tools/evm-chains/evm-client.js";
import { readCurveQuote, readTokenDecimals } from "@tools/trench-express/evm/curve-reader.js";
import { curveMinOut, curveTradeDeadline } from "@tools/trench-express/evm/min-out.js";
import { createAgentActivityIntent, type AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult,
} from "../../../internal/wallet/resolve.js";

import type { ProtocolExecutionContext } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { fail } from "../../handler-helpers.js";
import { resolveTradeInputs } from "./trade/shared.js";
import { buildTradePlan, type TradeLegPlan } from "./trade/plan.js";
import { runStagedLoop } from "./trade/staged-loop.js";
import { preBroadcastFailure } from "./trade/failure-results.js";
import { planBuyFeeLeg, planSellFeeLeg } from "./trade/fee.js";
import type { TrenchFeeLegPlan } from "../fee/index.js";
import { ETH_DECIMALS, PROTOCOL, TOOL_ID } from "./trade/execute-identity.js";

export async function trenchTradeExecuteHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  if (params.dryRun === true) return fail(`${TOOL_ID} does not support dryRun — call trench.trade_quote instead.`);

  const resolved = resolveTradeInputs(params);
  if (!resolved.ok) return fail(resolved.reason);
  const { chainId, side, token, nativeAddress, amountInHuman, slippageBps } = resolved.value;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  // Address-only resolve FIRST (never decrypts) — so a later failure still
  // records the real wallet_address.
  let walletAddress: Address;
  try {
    walletAddress = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const chainConfig = getLocalChain(chainId);
  if (!chainConfig) return fail(`Robinhood Chain (${chainId}) is not in the local chain registry.`);

  // Full signing wallet (decrypts) — only now that the call may broadcast.
  let signer;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  const { publicClient, walletClient } = getLocalEvmClients(chainConfig, signer.privateKey);

  // ── Phase A (pre-intent): fresh quote → floor + plan + atomic intent ──
  let executionId: number;
  let events: readonly AgentActivityEvent[];
  let plans: TradeLegPlan[];
  let tokenDecimals: number;
  let curveInRaw: bigint;
  let curveInHuman: string;
  let feePlan: TrenchFeeLegPlan | null;
  let feeBaseWei: bigint;
  try {
    tokenDecimals = await readTokenDecimals(publicClient, token);
    const amountInRaw = parseUnits(amountInHuman, side === "buy" ? ETH_DECIMALS : tokenDecimals);
    const feeIdentity = { chainId, nativeAddress, walletAddress, sessionId };

    // ── The Vex fee's charge base, per side ──
    // BUY: the ETH the user spends is known now, so the fee comes OFF the input
    // and the curve is quoted for the remainder — the disclosed output is then
    // post-fee and is what actually arrives.
    // SELL: the base is the ETH RECEIVED, which does not exist yet. The row is
    // planned from the quote so it exists before broadcast; the leg that is
    // signed is re-planned from the DECODED proceeds (see `staged-loop.ts`).
    const buyFee = side === "buy" ? planBuyFeeLeg(feeIdentity, amountInRaw) : null;
    curveInRaw = side === "buy" ? (buyFee?.netWei ?? amountInRaw) : amountInRaw;
    curveInHuman = side === "buy" ? formatEther(curveInRaw) : amountInHuman;

    // FRESH, deterministic curve quote taken immediately before building the
    // floor — the ONLY input to `min`, never a caller number, never zero. On a
    // buy this is the POST-fee amount.
    const expectedOutRaw = await readCurveQuote(publicClient, { token, side, amountInRaw: curveInRaw });
    const minOut = curveMinOut(expectedOutRaw, slippageBps);
    const deadline = curveTradeDeadline();

    feePlan = side === "buy" ? buyFee : planSellFeeLeg(feeIdentity, expectedOutRaw);
    feeBaseWei = side === "buy" ? amountInRaw : expectedOutRaw;

    plans = buildTradePlan({
      side, chainId, token, nativeAddress, walletAddress, sessionId,
      amountInRaw: curveInRaw, amountInHuman: curveInHuman, tokenDecimals,
      expectedOutRaw, minOut, deadline,
    });

    // The fee row is APPENDED LAST and is NOT a leg of the loop below: a leg
    // there can be aborted or can fail the trade, and the fee must be able to do
    // neither.
    const created = await createAgentActivityIntent({
      toolId: TOOL_ID,
      namespace: PROTOCOL,
      intentParams: params,
      events: [
        ...plans.map((plan, i) => ({ ...plan.event, eventIndex: i })),
        ...(feePlan ? [{ ...feePlan.event, eventIndex: plans.length }] : []),
      ],
    });
    executionId = created.executionId;
    events = created.events;
  } catch (err) {
    return preBroadcastFailure({ params, sessionId, walletAddress, chainId, side, token, nativeAddress, error: err });
  }

  // ── Phase B (post-intent): staged broadcast loop, then the fee leg ──
  return runStagedLoop({
    side, token, walletAddress, chainId, tokenDecimals,
    amountInHuman: curveInHuman, amountInRaw: curveInRaw,
    slippageBps, sessionId, executionId, events, plans, publicClient, walletClient,
    fee: { plan: feePlan, rowId: feePlan ? events[plans.length]?.id ?? null : null, baseWei: feeBaseWei, identity: { chainId, nativeAddress, walletAddress, sessionId } },
  });
}
