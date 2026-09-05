/**
 * `pools.launch_request_form` - park the turn and ask the human.
 *
 * THE FORM IS THE APPROVAL. This tool creates a request, never a transaction:
 * the user's submission is what authorizes the launch, which is why the agent
 * may call this in restricted mode while it may not launch directly. Everything
 * the agent proposes here is EDITABLE by the user - the name, the ticker, the
 * pair, the prebuy, the image, and the fee recipient - so what is stored is a
 * proposal, not a decision.
 *
 * IT DOES NOT PARK THE TURN ITSELF. It returns `pendingUserForm`, and the turn
 * loop's user-form arm owns the parking. That arm keys off the field rather than
 * off a tool id, so pools.fun needed no engine change to join it.
 *
 * THE TOOL CALL ID COMES FROM THE HOST, never from params. The row must name the
 * tool call its result will answer, or the resumed turn has nothing to address
 * its reply to - and a model-supplied id would let one tool call's answer be
 * delivered to another.
 */

import { randomUUID } from "node:crypto";
import { getAddress } from "viem";

import { POOLS_CHAIN_ID, POOLS_CHAIN_SLUG } from "@tools/pools-fun/constants.js";
import { createWith } from "@vex-agent/db/repos/token-launch-intents.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";

import { ok, fail } from "../../../handler-helpers.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { poolsFailureDetail } from "../failure.js";
import { readPoolsLaunchInputs } from "./inputs.js";

const TOOL_ID = "pools.launch_request_form";

/**
 * How long the user has to act. The same 15 minutes Trench's launch form uses -
 * stated here rather than shared, because the window is a per-surface product
 * decision and a single constant would silently couple two of them.
 */
const FORM_WINDOW_MS = 15 * 60 * 1000;

/** The host's id for the tool call this form answers. Blank is treated as absent. */
function hostToolCallId(context: ProtocolExecutionContext): string | null {
  const raw = context.toolCallId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export async function poolsLaunchRequestFormHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const validated = readPoolsLaunchInputs(p, context, { toolName: "pools__launch_request_form" });
  if (!validated.ok) return fail(validated.reason);
  const inputs = validated.value;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  const toolCallId = hostToolCallId(context);
  if (toolCallId === null) {
    return fail(
      `${TOOL_ID} could not identify the tool call its result must answer, so it refused to park the turn. `
        + "Nothing was created and no funds moved. This is a host wiring gap, not something to retry.",
    );
  }

  // Address only. The form path never needs a key here: signing happens later,
  // after the user submits, and under their own authorization.
  let walletAddress: string;
  try {
    walletAddress = getAddress(
      resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
    );
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const intentId = randomUUID();
  const expiresAt = new Date(Date.now() + FORM_WINDOW_MS).toISOString();

  try {
    await withTransaction(async (client) => {
      await acquireSessionControlLock(client, sessionId);
      await createWith(client, {
        intentId,
        sessionId,
        origin: "agent_requested_form",
        status: "awaiting_user_form",
        chainId: POOLS_CHAIN_ID,
        walletAddress,
        name: inputs.name,
        symbol: inputs.symbol,
        // Only a LOCKER id can be proposed on a form: the form is the in-app
        // consent surface, the locker is where its picture comes from, and a
        // Studio project path names a file the desktop form cannot show, let
        // alone lock. `createWith` takes the image's advisory lock and REFUSES a
        // dangling id, so a form cannot be raised against bytes already gone.
        ...(inputs.image?.kind === "locker" ? { imageId: inputs.image.imageId } : {}),
        ...(inputs.prebuyWei === null
          ? {}
          : { prebuyRaw: inputs.prebuyWei.toString(), prebuyDecimals: 18 }),
        toolCallId,
        missionRunId: context.missionRunId ?? null,
        expiresAt,
        protocol: "pools_fun",
        pools: {
          pairedAsset: inputs.pairedAsset,
          ...(inputs.pairedStockAddress === null
            ? {}
            : { pairedAssetAddress: inputs.pairedStockAddress }),
          // Deliberately NO feeRecipientAddress: the user chooses it in the
          // form, and writing a default here would make the proposal look like
          // a decision that had already been taken.
        },
      });
    });
  } catch (err) {
    return fail(
      `${TOOL_ID} could not open the launch form (${poolsFailureDetail(TOOL_ID, err)}). Nothing was created `
        + "and no funds moved.",
    );
  }

  return {
    ...ok({
      intentId,
      status: "awaiting_user_form",
      expiresAt,
      chain: POOLS_CHAIN_SLUG,
      chainId: POOLS_CHAIN_ID,
      proposed: {
        name: inputs.name,
        symbol: inputs.symbol,
        pairedAsset: inputs.pairedAsset,
        ...(inputs.pairedStockAddress === null
          ? {}
          : { pairedStockAddress: inputs.pairedStockAddress }),
        ...(inputs.feeStream.kind === "holders"
          ? { holderRewards: true as const, holderRewardsMode: inputs.feeStream.mode }
          : {}),
        ...(inputs.image?.kind === "locker" ? { imageId: inputs.image.imageId } : {}),
        ...(inputs.prebuyHuman === null ? {} : { prebuyEth: inputs.prebuyHuman }),
      },
      note:
        "The launch form is open and this turn is parked until the user submits or cancels it. Everything "
        + "proposed above is editable by them, including the image and where the creator fee stream goes - a "
        + "fees-to-holders proposal in particular is theirs to accept or drop, and it cannot be undone once "
        + "launched. "
        + "Their submission is what authorizes the launch; nothing has been signed and nothing has been spent.",
    }),
    // The turn loop's user-form arm keys off THIS field, not off the tool id.
    pendingUserForm: { intentId },
  };
}
