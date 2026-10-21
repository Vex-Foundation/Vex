/**
 * Vex Inference tools: the user's paid inference account (VEX on Robinhood
 * Chain), offered ONLY when the inference provider is Vex Inference and a
 * session is held (`visibility.requiresVexInference`, evaluated per request by
 * `vexInferenceToolAvailability`). Otherwise they are absent from the tool
 * list and from the Tool Map, and a direct call refuses by name with the
 * typed reason.
 *
 * Not exported over MCP (`mcp/export-scope.ts`): the account, its bearer and
 * the auto top-up rule belong to the desktop app's signed-in session.
 */

import type { ToolDef } from "../types.js";
import { STATUS_DEFAULT_LIMIT, STATUS_MAX_LIMIT } from "../internal/vex-inference/params.js";

const NO_VEX_FEE = {
  none: true,
  reason:
    "Vex charges no fee of its own on a Vex Inference deposit: the whole amount is credited to the user's Vex Inference balance. Inference prices already include the Vex Inference markup.",
} as const;

export const VEX_INFERENCE_TOOLS: readonly ToolDef[] = [
  {
    name: "VexInferenceStatus",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    visibility: { requiresVexInference: true },
    description:
      "Read the user's Vex Inference account: the VEX balance that pays for this agent's own inference, what the "
      + "current model costs, recent usage, and the funding state. Use this before suggesting a top-up, when the user "
      + "asks what they have left or what a model costs, or after a deposit to see it credited. It spends nothing "
      + "and signs nothing. Every amount carries its unit: `wei` is raw VEX at 18 decimals, `vex` the exact decimal, "
      + "`usdMicroEstimate` millionths of a dollar at the Vex Inference rate (null when no rate is valid). Prices are "
      + "per one million tokens, markup included, in USD and in VEX at the current rate. Usage is the newest "
      + `requests first, \`limit\` rows (default ${STATUS_DEFAULT_LIMIT}, max ${STATUS_MAX_LIMIT}, refused above, never clamped); `
      + "when `usage.hasMore` is true pass `usage.nextCursor` back verbatim as `cursor` for the next page. RETURNS "
      + "summary, account, balances (available, provisional, reserved, claimable, cashbackPending, pendingWithdrawal), "
      + "rate (with ageSeconds), alert (percent, reference, threshold, balance, belowAlert), model (id, effort, "
      + "inputPerMillion, outputPerMillion, reasoningPerMillion), usage, deposits (open and why not), autoTopUp (the "
      + "user's standing rule and its state). It does not prove a deposit landed: only `balances` after the backend "
      + "has seen the transfer does.",
    returns:
      "RETURNS summary, account, balances (available, provisional, reserved, claimable, cashbackPending, pendingWithdrawal), "
      + "rate (with ageSeconds), alert (percent, reference, threshold, balance, belowAlert), model (id, effort, "
      + "inputPerMillion, outputPerMillion, reasoningPerMillion), usage, deposits (open and why not), autoTopUp (the "
      + "user's standing rule and its state).",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: `How many recent usage rows to return, a whole number from 1 to ${STATUS_MAX_LIMIT} (default ${STATUS_DEFAULT_LIMIT}). Above the maximum is refused by name, never clamped.`,
        },
        cursor: {
          type: "string",
          description: "The usage page to continue from: exactly the `usage.nextCursor` the previous reply returned. Never compute or edit one.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "VexInferenceDepositPrepare",
    kind: "internal",
    mutating: false,
    pressureSafety: "mutating",
    actionKind: "approval_prepare",
    visibility: { requiresVexInference: true },
    description:
      "Prepare a deposit of VEX from the user's wallet into their Vex Inference balance, which pays for this agent's "
      + "inference. It SPENDS NOTHING and signs nothing: it checks the amount, the wallet and the deposit address and "
      + "records one intent for VexInferenceDepositConfirm, which is the call that moves funds. Use this when the user "
      + "asks to top up Vex Inference or VexInferenceStatus shows the balance below the alert. You supply ONLY the "
      + "amount: `amountIn` as a decimal STRING in `denomination` VEX (default) or USD, converted to VEX at the Vex "
      + "Inference rate and rounded up to whole wei. The source is the EVM wallet selected for this session, which "
      + "must be linked to the Vex Inference account; `walletAddress` is optional and must equal it. THERE IS NO "
      + "destination, token or chain parameter: the destination is the deposit address pinned in this Vex build and "
      + "checked against the backend, the token is VEX (18 decimals) and the chain Robinhood Chain (4663); any such "
      + "field is REFUSED BY NAME. Refused also below the $5 minimum at the current rate, above the wallet's VEX, "
      + "without ETH for the network fee, or while deposits are not open. The intent is scoped to this session and "
      + "expires in 10 minutes. In the app Vex dispatches the confirm itself. RETURNS summary, intentId, status "
      + "'prepared', amount (wei, vex, usdEstimate), requested, from, depositAddress, chainId, token, minimum, "
      + "networkFee, walletVex, expiresAt and autoTopUp (whether a rule covers it).",
    returns:
      "RETURNS summary, intentId, status 'prepared', amount (wei, vex, usdEstimate), requested, from, depositAddress, "
      + "chainId, token, minimum, networkFee, walletVex, expiresAt and autoTopUp (whether a rule covers it).",
    vexFee: NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        amountIn: {
          type: "string",
          description:
            "The amount as a decimal STRING in `denomination`, never a JSON number: VEX with at most 18 decimals (\"125.5\"), "
            + "or USD with at most 6 decimals and no currency sign (\"20\"). At least the $5 minimum at the current rate.",
        },
        denomination: {
          type: "string",
          enum: ["VEX", "USD"],
          description: "The unit of `amountIn`: VEX (default) or USD, which is converted to VEX at the Vex Inference rate, rounded up to whole wei.",
        },
        walletAddress: {
          type: "string",
          description: "Optional. The 0x address of the EVM wallet selected for this session; any other address is refused by name.",
        },
      },
      required: ["amountIn"],
      additionalProperties: false,
    },
  },
  {
    name: "VexInferenceDepositConfirm",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    actionKind: "user_wallet_broadcast",
    visibility: { requiresVexInference: true },
    description:
      "Send the Vex Inference deposit that VexInferenceDepositPrepare prepared. This SPENDS REAL FUNDS: it signs with "
      + "the user's wallet and broadcasts an IRREVERSIBLE VEX transfer on Robinhood Chain to the pinned deposit "
      + "address. In the app Vex calls it for you right after the prepare, so do not call it yourself. AUTHORITY: in a "
      + "restricted session the user approves a card showing every line (amount, wallet, deposit address, fee bound, "
      + "expiry); a full-permission session executes directly; during a mission the same rules apply under the "
      + "mission's wallet scope. Without a card it runs only when the user's own auto top-up rule covers it (same "
      + "wallet, at most the rule's amount, within its daily count and 30-day cap); otherwise it answers "
      + "needs_user_approval. You cannot create, widen or reuse authority. BEFORE IT SIGNS it re-checks the session "
      + "wallet, the inventory, the account link, the pinned address against the backend, the minimum, the balances, "
      + "the fee bound, the expiry and the vault; any drift REFUSES BY NAME with nothing signed. RETURNS a DISTINCT "
      + "outcome: confirmed (txHash, transferProven, authority), reverted on chain, broadcast with the outcome "
      + "UNKNOWN, or refused before broadcast; only the last is safe to prepare again. An unknown one is recorded "
      + "and counted against any rule cap and is NEVER re-sent; neither should you.",
    returns:
      "RETURNS a DISTINCT outcome: confirmed (txHash, transferProven, authority), reverted on chain, broadcast with the outcome "
      + "UNKNOWN, or refused before broadcast; only the last is safe to prepare again.",
    vexFee: NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        intentId: {
          type: "string",
          description: "The intentId VexInferenceDepositPrepare returned (starts with `vxdep-`). Scoped to this session and single use.",
        },
      },
      required: ["intentId"],
      additionalProperties: false,
    },
  },
];
