/**
 * The user dismissed the launch dialog.
 *
 * TWO THINGS HAPPEN, AND THE ORDER MATTERS. The intent is moved to `cancelled`
 * FIRST, then the agent's parked turn is woken. A wake that ran first could
 * resume an agent which immediately re-reads a still-live intent and concludes
 * the form is still open.
 *
 * `cancelIfAwaitingWith` only fires from `awaiting_user_form`, which is what
 * makes a cancel unable to race a signature: once a launch is `authorized` the
 * only exits are terminal, so there is no state in which "cancel" and "sign"
 * are both live. A CAS miss is therefore NOT an error — it means there was
 * nothing live to cancel (already deployed, already cancelled, or expired) — and
 * it is reported as `cancelled: false` rather than dressed up as a failure.
 */

import type { TokenLaunchCancelResult } from "@shared/schemas/token-launch.js";
import { log } from "../logger/index.js";
import type { TokenLaunchRefusal } from "./plan-context.js";
import { wakeParkedAgent } from "./execute-seam.js";

export type TokenLaunchCancelOutcome =
  | { readonly ok: true; readonly result: TokenLaunchCancelResult }
  | { readonly ok: false; readonly refusal: TokenLaunchRefusal };

export async function cancelLaunch(input: {
  readonly sessionId: string;
  readonly intentId: string;
}): Promise<TokenLaunchCancelOutcome> {
  let cancelled: unknown;
  try {
    const { cancelIfAwaitingWith } = await import("@vex-agent/db/repos/token-launch-intents.js");
    const { withSessionControlLock } = await import(
      "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js"
    );
    // Cancellation moves the intent OUT of the live set the compaction gate and
    // the image-locker deletion check both read, so it takes the same session
    // control lock every other money-state writer does. DB-only and short.
    cancelled = await withSessionControlLock(input.sessionId, (client) =>
      cancelIfAwaitingWith(client, input.intentId, input.sessionId),
    );
  } catch (cause) {
    log.warn(
      `[token-launch:cancel] failed intentId=${input.intentId} type=${
        cause instanceof Error ? cause.name : typeof cause
      }`,
    );
    return {
      ok: false,
      refusal: {
        kind: "unpriceable",
        detail:
          "Vex could not cancel this launch request. Check that Vex services are running and "
          + "try again.",
      },
    };
  }

  if (cancelled === null) {
    // Nothing live to cancel. Deliberately NOT an error, and deliberately NOT a
    // wake: an intent that already reached a terminal state had its outcome
    // reported by whoever terminalised it, and a second "dismissed" result would
    // try to answer one parked call twice.
    log.info(`[token-launch:cancel] nothing live intentId=${input.intentId}`);
    return { ok: true, result: { cancelled: false, resumedAgentTurn: false } };
  }

  const resumed = await wakeParkedAgent(input.intentId, input.sessionId, { kind: "dismissed" });

  log.info(
    `[token-launch:cancel] cancelled intentId=${input.intentId} resumed=${String(resumed)}`,
  );
  return { ok: true, result: { cancelled: true, resumedAgentTurn: resumed } };
}
