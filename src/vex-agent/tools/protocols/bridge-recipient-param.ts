/**
 * The bridge ALIAS boundary's answer to a caller-supplied `recipient`.
 *
 * The four bridge tools stopped declaring `recipient`: a bridge delivers to the
 * wallet selected for this project on the destination chain, and rule 90 is
 * explicit that a value able to redirect funds never originates from model
 * input. The manifests answer the key from `rejectedParams`
 * (`BRIDGE_DERIVED_RECIPIENT_SENTENCE`) and the handlers answer it again with
 * the address the bridge would have delivered to (`bridgeRecipientRefusal`).
 *
 * The action-named ALIASES are a second entry point into exactly those tools,
 * and they had kept `recipient` as a declared arg that they forwarded. The
 * forward was fail-closed - the manifest boundary refused it one layer down -
 * but the alias schema advertised a parameter that can never succeed, which is
 * dead capability, and the refusal the agent read named the NAMESPACED tool it
 * had not called. So the alias answers the key itself, with the same sentence,
 * naming the alias the agent actually invoked.
 *
 * PRESENCE, not value: the key being there at all is the attempt. The check
 * therefore has to run BEFORE `dropEmptyModelValues` (which would delete
 * `recipient: ""` and leave the attempt unanswered) and before `.strict()`
 * parsing (which would answer it as an anonymous unknown key). `undefined` is
 * the one value treated as absent, because JSON cannot express it and the
 * protocol boundary (`runtime/params.ts`) treats it as an absent key too - the
 * two layers must not disagree about what was supplied.
 *
 * The supplied address is NEVER echoed back: an attacker-chosen string in
 * model-visible output is one the next turn can read as an instruction.
 */

import { BRIDGE_DERIVED_RECIPIENT_SENTENCE } from "./conventions.js";

/**
 * The by-name refusal for a caller-supplied `recipient` at an alias boundary,
 * or `null` when the key was not supplied.
 *
 * `subject` is the agent-facing alias being called (e.g. `BridgeQuote`), so the
 * refusal names the call the agent actually made.
 */
export function bridgeRecipientAliasRefusal(
  subject: string,
  params: Readonly<Record<string, unknown>>,
): string | null {
  if (!Object.hasOwn(params, "recipient") || params.recipient === undefined) return null;
  return `${subject}: recipient is not an accepted parameter - ${BRIDGE_DERIVED_RECIPIENT_SENTENCE} Remove it and retry.`;
}
