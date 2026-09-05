/**
 * Trench Express LAUNCH manifests - the two tools that create a token.
 *
 * NOTE WHAT IS ABSENT FROM BOTH PARAM LISTS, deliberately: there is no `fee`,
 * `value`, `min`, `minOut`, `deadline` or `recipient` param, and there never may
 * be. Vex composes a launch's `msg.value` from the creation fee it reads on-chain
 * plus the prebuy; a fee-shaped param here would let model output set a spend.
 * `fee-params-never-from-model.test.ts` fails automatically if one appears, and
 * `validate.ts` refuses one BY NAME at runtime if it arrives anyway.
 *
 * `prebuy` IS a legitimate model-set param - it is the user's own principal, the
 * thing the agent is being asked to decide, and it is bounded by the mission's
 * launch-value ceiling before anything is signed. That is the same distinction
 * `slippageBps` gets on the trade path: a trading decision, not a fee.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_LAUNCH_DISCOVERY } from "../../embeddings/trench/launch.js";

const LAUNCH_FIELD_PARAMS = [
  { key: "name", type: "string" as const, required: true, description: "Token name (1-18 chars) - the chain reverts a longer one." },
  { key: "symbol", type: "string" as const, required: true, description: "Token symbol/ticker (1-16 chars)." },
  { key: "description", type: "string" as const, description: "Optional token description (max 512 chars)." },
  {
    key: "links",
    type: "string" as const,
    required: false,
    acceptsStringArray: true as const,
    description: "Optional 0-4 social links, each an https URL (comma-separated or array).",
  },
  {
    key: "imageId",
    type: "string" as const,
    required: true,
    description:
      "REQUIRED. The id of an image already uploaded to the Trench Photos locker (list them with trench__images_list). "
      + "A token's image is written on-chain at creation and can never be added later, so a launch without one is refused.",
  },
  {
    key: "prebuy",
    type: "string" as const,
    description:
      "Optional amount of ETH to spend buying the new token on its own curve in the SAME transaction, "
      + "as a plain decimal (for example \"0.0003\"). Omit or \"0\" for no prebuy.",
  },
];

export const TRENCH_LAUNCH_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.launch_request_form",
    publicName: "trench__launch_request_form",
    namespace: "trench",
    lifecycle: "active",
    // HONESTY GATE (Fala B, 2026-08-02): park/resume is WIRED - the tool-call id
    // threads through the dispatcher, the handler drafts the intent and parks
    // the run, and `resumeAgentAfterUserForm` answers this call with the
    // outcome. The round-3 wording ("fails closed rather than parking") was
    // honest then and is stale now; a manifest that denies a capability the
    // runtime has teaches the model to work around it. The refusal sentence
    // survives ONLY for the genuine fail-closed edge: a call arriving with no
    // tool-call id (a non-tool-call invocation) has nothing to resume against,
    // so the handler refuses rather than parking a turn nobody can answer.
    description:
      "Hand the launch DECISION to the user: asks them to create the token themselves through the app's launch form, "
      + "pre-filled with the details you propose. DRAFTS AND ASKS ONLY - it does NOT sign, does NOT spend and does NOT "
      + "create anything; the user reviews the exact cost and clicks Deploy. Your turn PARKS while the form is open and "
      + "the runtime resumes it with the outcome when the user deploys, dismisses the form, or it expires - so do not "
      + "call it again while the form is open, and never assume the launch happened without that resumed outcome. Use "
      + "this whenever a human should decide the launch. It returns the parked request itself - its intentId, a status of "
      + "awaiting_user_form, when it expires, and the chain - and then the runtime answers this same call with the human's "
      + "real outcome. If it is ever invoked outside a tool call there is nothing to "
      + "resume, and it refuses instead of parking: report that and stop, never improvise a launch by another route.",
    // FALSE, deliberately: preparing a form is not a mutation. It writes a draft
    // intent row and parks the turn; nothing on-chain happens.
    // It drafts a durable intent row and parks the turn, so it is NOT a read -
    // but it must NOT raise an approval card either: opening a form is not a
    // spend, and the consent happens later at Deploy. `local_write` is exactly
    // that combination, and the approval gate exempts it by name
    // (`protocols/runtime/gates.ts`). `approval_prepare` is the internal-tool
    // spelling and breaks the protocol invariant that a non-mutating protocol
    // tool must be a `read` (`protocol-taxonomy.test.ts`).
    mutating: true,
    actionKind: "local_write",
    params: LAUNCH_FIELD_PARAMS,
    exampleParams: { name: "My Token", symbol: "MYT", imageId: "img_01" },
    discovery: TRENCH_LAUNCH_DISCOVERY["trench.launch_request_form"],
  },
  {
    toolId: "trench.launch_execute",
    publicName: "trench__launch_execute",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Create a token on Trench Express (Robinhood Chain 4663) FOR REAL - signs and broadcasts the on-chain create with "
      + "the user's wallet. SPENDS REAL FUNDS AND IS IRREVERSIBLE: it pays the launchpad's creation fee (read on-chain at "
      + "signing time) and, if you set a prebuy, buys that much of the new token on its curve in the same transaction. "
      + "Vex also charges 25 bps of that whole ETH amount (creation fee + prebuy) as a SEPARATE transfer that runs only "
      + "after the launch confirms - price a launch with trench__launch_preview, which shows it and the fee-inclusive total. "
      + "An image is REQUIRED and must already be in the locker. It runs ONLY under explicit authority, and which one "
      + "depends on where you are: in a FULL-permission chat session the user's permission is the authority and this "
      + "executes directly; in a RESTRICTED session it refuses BY NAME and you must call trench__launch_request_form "
      + "instead - that form is this tool's consent surface, and the user's Deploy click is what launches; in a MISSION "
      + "run the authority is the contract's HOST-authored launch ceilings (max launch value, max launch count), which "
      + "you cannot write, and while a contract carries none this tool REFUSES BY NAME - report that refusal and tell "
      + "the user to set them on the contract card rather than launching some other way. It also REFUSES BY NAME before "
      + "anything is signed when the image store is unavailable, the imageId is unknown or too large for the on-chain "
      + "budget, the creation fee cannot be read, a mission ceiling on launch value or launch count would be exceeded, "
      + "gas cannot be estimated, or the wallet's balance is short or unreadable; and the whole authorization is "
      + "re-derived and compared field by field immediately before signing, so any drift refuses rather than launching. "
      + "Returns a status of confirmed, reverted, pending, or confirmed_pending_identity. A confirmed launch names the "
      + "new tokenAddress, the transaction hash, msgValueWei with its creationFeeWei and prebuyWei legs as raw amounts, "
      + "the tokens the prebuy actually bought, the Vex fee's own outcome, and that the token is on its bonding curve. "
      + "`reverted` means no token was created and no Vex fee was charged. `pending` means the outcome is UNKNOWN and "
      + "already recorded, and `confirmed_pending_identity` means it settled but the token could not be PROVEN from the "
      + "receipt - in both of those the address is never guessed and you must NOT launch again.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: LAUNCH_FIELD_PARAMS,
    exampleParams: { name: "My Token", symbol: "MYT", imageId: "img_01", prebuy: "0.0003" },
    discovery: TRENCH_LAUNCH_DISCOVERY["trench.launch_execute"],
  },
];
