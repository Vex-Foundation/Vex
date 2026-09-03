/**
 * `trench.launch_request_form` - the agent ASKS the user to launch a token.
 *
 * `mutating: false`. This tool DRAFTS and goes PENDING. It never signs, never
 * broadcasts and never spends: it inserts a `token_launch_intents` row at
 * `awaiting_user_form` carrying the ORIGINAL tool-call id, then returns
 * `pendingUserForm` - the §C3b sibling of `pendingApproval`.
 *
 * WHO DOES WHAT. This handler makes the wait DURABLE and nothing else. The turn
 * loop's user-form arm (`turn-loop-tool-batch/user-form-stop.ts`) owns the park,
 * the operator-stop gate and the dialog push, exactly as the approval arm owns
 * the enqueue and the `paused_approval` flip. The split is not cosmetic: a
 * handler that parked would be parking a run the loop is still driving, and a
 * handler that returned a normal result would have the loop record an answer
 * this call has not received yet.
 *
 * WHY IT PARKS ON ITS OWN STATE. Verified in the repo rather than assumed: the
 * approval seam ALWAYS enqueues an approval, flips the run to `paused_approval`
 * and exposes a CARD. This path exists precisely to show a FORM instead, so
 * reusing it would display the very surface it is here to avoid. `user-form-runtime.ts`
 * owns the mechanics; this handler owns the launch-shaped decision to use them.
 *
 * The tool-call id is the load-bearing detail. Without it the eventual result
 * answers no pending call and the turn cannot close - which is why it is
 * persisted on the row rather than held in memory, and why the DB CHECK
 * `token_launch_intents_form_path_has_tool_call` requires it on this path.
 */

import { randomUUID } from "node:crypto";

import { getAddress, type Address } from "viem";

import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import { createWith } from "@vex-agent/db/repos/token-launch-intents.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import type { ToolResult } from "../../../../types.js";
import { ok, fail } from "../../../handler-helpers.js";
import { validateLaunchRequest } from "./validate.js";

const TOOL_ID = "trench.launch_request_form";

/**
 * How long the user has to act before the form expires.
 *
 * ONE timestamp covers both the pre-authorization window and the §C3b
 * continuation's expiry, deliberately: two could only ever disagree, and a
 * continuation that expires at a different moment from the form it resumes is
 * how a turn hangs, or resumes against a form the user can still submit.
 */
const FORM_WINDOW_MS = 15 * 60 * 1000;

export async function trenchLaunchRequestFormHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const validated = validateLaunchRequest(params);
  if (!validated.ok) return fail(validated.reason);

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  // The tool-call id comes from the HOST, never from params - a model-supplied
  // one could park a form that answers a different call. Absent means this
  // dispatch was not a model tool call at all (previews, maintenance, internal
  // resumes), and parking a turn nothing can answer would hang it forever, so
  // the handler refuses instead. Fail-closed, not dead code.
  const toolCallId = readHostToolCallId(context);
  if (!toolCallId) {
    return fail(
      `${TOOL_ID} could not identify the tool call its result must answer, so it refused to park the turn. `
        + "Nothing was created and no funds moved. This is a host wiring gap, not something to retry.",
    );
  }

  // Address-only resolve: this path never signs, so it must never decrypt.
  let walletAddress: Address;
  try {
    walletAddress = getAddress(
      resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
    );
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const intentId = randomUUID();
  const expiresAt = new Date(Date.now() + FORM_WINDOW_MS).toISOString();

  // Creation is precisely the transition a row lock cannot exclude - the row has
  // no identity to lock until it exists - so it happens under the session
  // control lock, or the compaction safe-moment gate can read `clear` a
  // microsecond before this money state comes into existence.
  await withTransaction(async (client) => {
    await acquireSessionControlLock(client, sessionId);
    await createWith(client, {
      intentId,
      sessionId,
      origin: "agent_requested_form",
      status: "awaiting_user_form",
      chainId: TRENCH_CHAIN_ID,
      walletAddress,
      name: validated.value.name,
      symbol: validated.value.symbol,
      description: validated.value.description,
      links: { urls: [...validated.value.links] },
      imageId: validated.value.imageId,
      prebuyRaw: validated.value.prebuyWei.toString(),
      prebuyDecimals: 18,
      toolCallId,
      missionRunId: context.missionRunId ?? null,
      expiresAt,
    });
  });

  // PENDING, not answered. The row above made the wait durable; the turn loop's
  // user-form arm (`turn-loop-tool-batch/user-form-stop.ts`) now owns what
  // happens next - the operator-stop gate, the park, and the dialog push, in
  // one transaction with emit-after-commit.
  //
  // This handler deliberately does NOT park, emit, or produce a tool result.
  // A result recorded here would be a SECOND result for this call once the
  // resume appends the human's actual answer, and the transcript would carry
  // two results for one `tool_call_id`. The output below is diagnostic only: on
  // this path the batch records the call WITHOUT it.
  return {
    ...ok({ intentId, status: "awaiting_user_form", expiresAt, chainId: TRENCH_CHAIN_ID }),
    pendingUserForm: { intentId },
  };
}

/**
 * Read the host-threaded tool-call id, treating blank as absent - a whitespace
 * id answers no call, and the DB CHECK on this path would take it anyway.
 */
function readHostToolCallId(context: ProtocolExecutionContext): string | null {
  const value = context.toolCallId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
