import type { PoolClient } from "pg";

import {
  getById,
  markResumeConsumedWith,
  stampResultMessageWith,
} from "../../db/repos/lighter-setup-interactions.js";
import logger from "@utils/logger.js";
import { createLeaseHandle } from "../runtime/lease-handle.js";
import { releaseLeaseAndEmitControlState } from "../runtime/release-and-emit.js";
import { claimSessionLease } from "../runtime/lease-and-status.js";
import { LEASE_TTL_MS } from "./approval-runtime/helpers.js";
import {
  closeUserFormContinuation,
  commitUserFormToolResult,
  type UserFormContinuationRef,
} from "./user-form-runtime.js";

export type LighterSetupResumeResult =
  | { readonly resumed: true }
  | {
      readonly resumed: false;
      readonly reason: "intent_not_found" | "not_settled" | "already_resolved" | "busy";
    };

const BUSY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
const retrying = new Set<string>();

class ResultAlreadyStampedError extends Error {}

export async function resumeAgentAfterLighterSetup(input: {
  readonly intentId: string;
  readonly sessionId: string;
}): Promise<LighterSetupResumeResult> {
  const intent = await getById(input.intentId, input.sessionId);
  if (intent === null) return { resumed: false, reason: "intent_not_found" };
  if (intent.status === "pending") return { resumed: false, reason: "not_settled" };
  if (intent.resumeConsumedAt !== null) return { resumed: false, reason: "already_resolved" };

  const ref: UserFormContinuationRef = {
    sessionId: intent.sessionId,
    missionRunId: null,
    toolCallId: intent.toolCallId,
  };

  if (intent.resultMessageId === null) {
    try {
      await commitUserFormToolResult({
        ref,
        success: intent.status === "completed",
        output: describeOutcome(intent.status, intent.environment),
        stamp: async (client: PoolClient, resultMessageId: number) => {
          const stamped = await stampResultMessageWith(
            client,
            intent.intentId,
            intent.sessionId,
            resultMessageId,
          );
          if (!stamped) throw new ResultAlreadyStampedError();
        },
      });
    } catch (error) {
      if (!(error instanceof ResultAlreadyStampedError)) throw error;
    }
  }

  const ownerId = `lighter-setup-${intent.intentId}`;
  const claim = await claimSessionLease({
    sessionId: intent.sessionId,
    ownerId,
    processKind: "electron_main",
    ttlMs: LEASE_TTL_MS,
  });
  if (claim.outcome === "lease_busy") {
    armBusyRetry(input);
    return { resumed: false, reason: "busy" };
  }

  const leaseHandle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  let closed = false;
  try {
    const { runStopGatedSessionTurn } = await import("./runner/gated-session-turn.js");
    await runStopGatedSessionTurn({
      sessionId: intent.sessionId,
      runnerOwnerId: ownerId,
      logScope: "lighter_setup_resume",
    });
    await closeUserFormContinuation({
      sessionId: intent.sessionId,
      leaseHandle,
      consume: async (client) => {
        await markResumeConsumedWith(client, intent.intentId, intent.sessionId);
      },
    });
    closed = true;
    return { resumed: true };
  } finally {
    if (!closed) {
      await releaseLeaseAndEmitControlState(leaseHandle, intent.sessionId).catch(() => undefined);
    }
  }
}

function armBusyRetry(input: { readonly intentId: string; readonly sessionId: string }): void {
  if (retrying.has(input.intentId)) return;
  retrying.add(input.intentId);
  void (async () => {
    try {
      for (const delayMs of BUSY_RETRY_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const result = await resumeAgentAfterLighterSetup(input).catch(() => (
          { resumed: false, reason: "busy" } as const
        ));
        if (result.resumed || result.reason !== "busy") return;
      }
      logger.warn("engine.lighter_setup.resume_retry_exhausted", input);
    } finally {
      retrying.delete(input.intentId);
    }
  })();
}

function describeOutcome(
  status: "completed" | "cancelled",
  environment: "core" | "rhc",
): string {
  const label = environment === "core" ? "Lighter Core" : "Lighter RHC";
  if (status === "cancelled") {
    return `The user deliberately cancelled ${label} account setup. Do not continue any Lighter trade from the original request and do not reopen setup unless the user explicitly asks.`;
  }
  return `${label} account setup completed successfully. Continue evaluating the user's original request. This setup is not consent to trade: any trade must still use the normal preview and approval flow.`;
}
