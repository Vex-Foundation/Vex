/**
 * PriceAlert - set or cancel an alert that notifies once (F01).
 *
 * A thin parser over `@vex-agent/alerts/service`, the same service the
 * Watchlist page calls. An alert never trades, so this is a local write with
 * no approval card (`actionKind: local_write`). A chat-set alert records
 * `origin: 'chat'` and the session it came from.
 */

import { z } from "zod";

import { PRICE_ALERT_CONDITIONS } from "@vex-agent/alerts/condition.js";
import { cancelPriceAlert, setPriceAlert } from "@vex-agent/alerts/service.js";
import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import { formatZodIssueForModel } from "../arg-validation.js";
import { refusalText } from "./watchlist.js";

const PriceAlertArgs = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    chain: z.string().trim().min(1, { message: "chain is required for set (e.g. 'base' or 'solana')" }),
    tokenAddress: z.string().trim().min(1, { message: "tokenAddress is required for set" }),
    condition: z.enum(PRICE_ALERT_CONDITIONS),
    value: z.string().trim().min(1, { message: "value is required for set (a decimal string)" }),
    note: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    alertId: z.string().trim().min(1, { message: "alertId is required for cancel (from Watchlist list)" }),
  }).strict(),
]);

export async function handlePriceAlert(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = PriceAlertArgs.safeParse(params);
  if (!parsed.success) {
    return fail(`PriceAlert: ${formatZodIssueForModel(parsed.error.issues[0], params)}`);
  }
  const args = parsed.data;

  if (args.action === "cancel") {
    const cancelled = await cancelPriceAlert({ alertId: args.alertId });
    return cancelled.ok ? ok({ alert: cancelled.alert }) : fail(refusalText("PriceAlert", cancelled));
  }

  const result = await setPriceAlert({
    chain: args.chain,
    tokenAddress: args.tokenAddress,
    condition: args.condition,
    value: args.value,
    ...(args.note === undefined ? {} : { note: args.note }),
    origin: "chat",
    sessionId: context.sessionId,
  });
  return result.ok
    ? ok({ status: result.status, alert: result.alert, priceUsd: result.priceUsd })
    : fail(refusalText("PriceAlert", result));
}
