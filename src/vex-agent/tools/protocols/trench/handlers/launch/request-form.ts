/**
 * `trench.launch_request_form` — the agent ASKS the user to launch a token.
 *
 * `mutating: false`. This tool DRAFTS and PARKS. It never signs, never
 * broadcasts and never spends: it inserts a `token_launch_intents` row at
 * `awaiting_user_form`, signals the app to open the dialog, and parks the run on
 * the §C3b `paused_user_form` state carrying the ORIGINAL tool-call id.
 *
 * WHY IT PARKS ON ITS OWN STATE. Verified in the repo rather than assumed: the
 * approval seam ALWAYS enqueues an approval, flips the run to `paused_approval`
 * and exposes a CARD. This path exists precisely to show a FORM instead, so
 * reusing it would display the very surface it is here to avoid. `user-form-runtime.ts`
 * owns the mechanics; this handler owns the launch-shaped decision to use them.
 *
 * The tool-call id is the load-bearing detail. Without it the eventual result
 * answers no pending call and the turn cannot close — which is why it is
 * persisted on the row rather than held in memory, and why the DB CHECK
 * `token_launch_intents_form_path_has_tool_call` requires it on this path.
 */

import { randomUUID } from "node:crypto";

import { getAddress, type Address } from "viem";

import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import { createWith } from "@vex-agent/db/repos/token-launch-intents.js";
import { parkRunForUserForm } from "@vex-agent/engine/core/user-form-runtime.js";
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

  // The tool-call id comes from the HOST, never from params — a model-supplied
  // one could park a form that answers a different call.
  //
  // NOT ON `ProtocolExecutionContext` YET (2026-08-02). §C3b requires the
  // ORIGINAL tool-call id, and the dispatcher does not thread one; Lane F owns
  // adding it beside the mission provenance it already threads. Read through a
  // widening so this compiles today and FAILS CLOSED: with no id there is no
  // pending call to answer, and parking the turn would hang it forever. Refusing
  // is the honest outcome until the seam lands.
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

  // Creation is precisely the transition a row lock cannot exclude — the row has
  // no identity to lock until it exists — so it happens under the session
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

  // Park AFTER the row exists: a run parked with no intent to resume against is
  // a hang. A chat session has no run and parks nothing — the turn simply ends
  // holding the pending call.
  await parkRunForUserForm({
    sessionId,
    missionRunId: context.missionRunId ?? null,
    toolCallId,
  });

  return ok({
    intentId,
    status: "awaiting_user_form",
    expiresAt,
    chainId: TRENCH_CHAIN_ID,
    name: validated.value.name,
    symbol: validated.value.symbol,
    imageId: validated.value.imageId,
    prebuyWei: validated.value.prebuyWei.toString(),
    prebuyDecimals: 18,
    _openLaunchDialog: { intentId },
    note:
      "The launch form is now open for the user. NOTHING has been created and no funds have moved — "
      + "this only drafted the launch and asked. You will receive the outcome as the result of this "
      + "call when the user deploys, dismisses it, or it expires. Do not call this tool again while "
      + "it is open, and do not assume the launch happened.",
  });
}

/**
 * Read the host-threaded tool-call id.
 *
 * DELETE THIS SHIM once `ProtocolExecutionContext.toolCallId` exists (Lane F).
 * It is a widening, not a cast to a lie: the field is genuinely absent today, so
 * the honest type is "may not be there", and the caller refuses when it is not.
 */
function readHostToolCallId(context: ProtocolExecutionContext): string | null {
  const widened = context as ProtocolExecutionContext & { toolCallId?: string | null };
  const value = widened.toolCallId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
