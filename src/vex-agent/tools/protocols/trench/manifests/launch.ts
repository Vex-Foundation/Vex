/**
 * Trench Express LAUNCH manifests — the two tools that create a token.
 *
 * NOTE WHAT IS ABSENT FROM BOTH PARAM LISTS, deliberately: there is no `fee`,
 * `value`, `min`, `minOut`, `deadline` or `recipient` param, and there never may
 * be. Vex composes a launch's `msg.value` from the creation fee it reads on-chain
 * plus the prebuy; a fee-shaped param here would let model output set a spend.
 * `fee-params-never-from-model.test.ts` fails automatically if one appears, and
 * `validate.ts` refuses one BY NAME at runtime if it arrives anyway.
 *
 * `prebuy` IS a legitimate model-set param — it is the user's own principal, the
 * thing the agent is being asked to decide, and it is bounded by the mission's
 * launch-value ceiling before anything is signed. That is the same distinction
 * `slippageBps` gets on the trade path: a trading decision, not a fee.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_LAUNCH_DISCOVERY } from "../../embeddings/trench/launch.js";

const LAUNCH_FIELD_PARAMS = [
  { key: "name", type: "string" as const, required: true, description: "Token name (1-64 chars)." },
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
      "REQUIRED. The id of an image already uploaded to the Trench Photos locker (list them with trench.images). "
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
    namespace: "trench",
    lifecycle: "active",
    description:
      "Ask the user to launch a token on Trench Express (Robinhood Chain 4663) by opening the launch form in the app, "
      + "pre-filled with the details you propose. DRAFTS AND ASKS ONLY — it does NOT sign, does NOT spend and does NOT "
      + "create anything; the user reviews the exact cost and clicks Deploy. Your turn pauses while the form is open and "
      + "resumes with the outcome when the user deploys, dismisses it, or it expires. Use this whenever a human should "
      + "decide the launch.",
    // FALSE, deliberately: preparing a form is not a mutation. It writes a draft
    // intent row and parks the turn; nothing on-chain happens.
    // It drafts a durable intent row and parks the turn, so it is NOT a read —
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
    namespace: "trench",
    lifecycle: "active",
    description:
      "Create a token on Trench Express (Robinhood Chain 4663) FOR REAL — signs and broadcasts the on-chain create with "
      + "the user's wallet. SPENDS REAL FUNDS AND IS IRREVERSIBLE: it pays the launchpad's creation fee (read on-chain at "
      + "signing time) and, if you set a prebuy, buys that much of the new token on its curve in the same transaction. "
      + "An image is REQUIRED and must already be in the locker. Under full autonomy in a mission it executes directly, "
      + "bounded by the mission's launch value and launch count ceilings; otherwise the user must approve it first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: LAUNCH_FIELD_PARAMS,
    exampleParams: { name: "My Token", symbol: "MYT", imageId: "img_01", prebuy: "0.0003" },
    discovery: TRENCH_LAUNCH_DISCOVERY["trench.launch_execute"],
  },
];
