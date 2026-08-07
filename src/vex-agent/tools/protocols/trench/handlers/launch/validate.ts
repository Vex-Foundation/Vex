/**
 * Launch boundary validation — the first gate every launch request passes.
 *
 * Three responsibilities, all rule-90:
 *
 * 1. **Forbidden params are rejected BY NAME.** `min`, `minOut`, `deadline`,
 *    `recipient`, `fee` and `value` may never originate from model input. A
 *    silent drop would hide an attempted overcharge instead of surfacing it, so
 *    the refusal names every offending key. The set is WIDER than the trade
 *    path's because a launch composes its own `msg.value`: `value` and `fee`
 *    would let a model set the spend directly.
 * 2. **Raw amounts travel with their decimals.** The prebuy is parsed once, here,
 *    into wei at 18 decimals, and every later stage handles bigint wei only.
 *    `"1047061"` next to a bare mint is 1.05 at 6 decimals and 0.00105 at 9 — a
 *    thousandfold error for whoever guesses, so nothing downstream is allowed to.
 * 3. **Metadata that create() writes forever is rejected, never repaired.** A
 *    control character or a double quote in name, symbol, description or a link
 *    breaks the token's on-chain metadata permanently, so `lib/token-metadata-text-policy.ts`
 *    refuses it by field name instead of rewriting text the user never reviewed.
 *
 * The IMAGE is required. That is a Vex product rule, not a contract rule (the
 * Diamond accepts empty image bytes and `launch_preview` proves it), and the
 * refusal names the locker so the user knows where to fix it.
 */

import { parseUnits } from "viem";

import { readStringList } from "../../../runtime/list-params.js";
import { rejectForbiddenTokenMetadataText } from "../../../../../../lib/token-metadata-text-policy.js";
import {
  TOKEN_METADATA_NAME_MAX as NAME_MAX,
  TOKEN_METADATA_SYMBOL_MAX as SYMBOL_MAX,
  TOKEN_METADATA_DESCRIPTION_MAX as DESCRIPTION_MAX,
  TOKEN_METADATA_LINKS_MAX as LINKS_MAX,
  TOKEN_METADATA_LINK_LENGTH_MAX as LINK_LEN_MAX,
} from "../../../../../../lib/token-metadata-limits.js";

/**
 * Params that must NEVER come from model input. Rejected by name, never dropped.
 *
 * `fee-params-never-from-model.test.ts` is the repo-wide tripwire that no
 * manifest gains a fee-shaped param; this is the runtime half of the same rule.
 */
export const FORBIDDEN_LAUNCH_PARAMS = [
  "min",
  "minOut",
  "deadline",
  "recipient",
  "fee",
  "value",
] as const;

// The length caps are the MEASURED chain limits and live in ONE place,
// `lib/token-metadata-limits.ts`, shared with `trench.launch_preview` and the
// IPC form schema. A looser cap on any surface turns a chain revert into a
// vague "gas_unestimable" instead of a refusal that names the field.

const ETH_DECIMALS = 18;

/**
 * Fat-finger ceiling on the prebuy, in ETH. NOT the spend gate — the mission
 * ceiling (§C6) is — but a magnitude this far outside any plausible launch is a
 * mistake worth refusing before the rest of the machinery runs.
 */
const PREBUY_SANITY_MAX_ETH = 1_000n;

export interface ValidatedLaunchRequest {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly links: readonly string[];
  readonly imageId: string;
  /** Wei. Zero means "no prebuy", which is a legitimate launch. */
  readonly prebuyWei: bigint;
}

export type LaunchValidation =
  | { readonly ok: true; readonly value: ValidatedLaunchRequest }
  | { readonly ok: false; readonly reason: string };

function refuse(reason: string): LaunchValidation {
  return { ok: false, reason };
}

/**
 * Validate a launch request from tool params or an IPC payload.
 *
 * Forbidden params are checked FIRST, before anything else is even read: a
 * request that tried to set the spend is refused on that ground, not on some
 * incidental later failure that would obscure what it attempted.
 */
export function validateLaunchRequest(p: Record<string, unknown>): LaunchValidation {
  // 1. Forbidden params — presence is the offence, whatever the value.
  //    `null`, `0`, `""` and `false` all count: a falsy forbidden param is still
  //    an attempt to reach the money path.
  const supplied = FORBIDDEN_LAUNCH_PARAMS.filter((key) => key in p);
  if (supplied.length > 0) {
    return refuse(
      `Refusing the launch: ${supplied.join(", ")} ${supplied.length === 1 ? "is" : "are"} not accepted from a tool call. `
        + "Vex composes the launch's value from the creation fee it reads on-chain and the prebuy you name as `prebuy`; "
        + "a caller-supplied fee, value, limit, deadline or recipient is rejected rather than ignored.",
    );
  }

  // 1b. On-chain metadata text — checked on the RAW values, before any trim and
  //     before the link scheme check, because create() writes these fields
  //     immutably and a repaired string is not the string the user reviewed.
  for (const field of ["name", "symbol", "description", "links"] as const) {
    const refusal = rejectForbiddenTokenMetadataText(field, p[field]);
    if (refusal) return refuse(refusal);
  }

  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) return refuse("Missing required: name.");
  if (name.length > NAME_MAX) return refuse(`name must be at most ${NAME_MAX} characters.`);

  const symbol = typeof p.symbol === "string" ? p.symbol.trim() : "";
  if (!symbol) return refuse("Missing required: symbol.");
  if (symbol.length > SYMBOL_MAX) return refuse(`symbol must be at most ${SYMBOL_MAX} characters.`);

  const description = typeof p.description === "string" ? p.description.trim() : "";
  if (description.length > DESCRIPTION_MAX) {
    return refuse(`description must be at most ${DESCRIPTION_MAX} characters.`);
  }

  const linksRead = readStringList(p, "links", { lowercase: false, acceptsArray: true });
  if (!linksRead.ok) return refuse(linksRead.reason);
  const links = linksRead.value ?? [];
  if (links.length > LINKS_MAX) return refuse(`links accepts at most ${LINKS_MAX} URLs.`);
  for (const link of links) {
    if (link.length > LINK_LEN_MAX) {
      return refuse(`each link must be at most ${LINK_LEN_MAX} characters.`);
    }
    if (!/^https:\/\//i.test(link)) {
      return refuse(`each link must be an https URL — received "${link.slice(0, 48)}".`);
    }
  }

  const imageId = typeof p.imageId === "string" ? p.imageId.trim() : "";
  if (!imageId) {
    return refuse(
      "A Trench launch requires an image. The token's image is written on-chain by create() and "
        + "can never be added afterwards, so Vex refuses to launch without one — upload an image to "
        + "the Trench Photos locker on the right, then name its imageId.",
    );
  }

  const prebuy = parsePrebuy(p.prebuy);
  if (typeof prebuy === "string") return refuse(prebuy);

  return { ok: true, value: { name, symbol, description, links, imageId, prebuyWei: prebuy } };
}

/**
 * Parse the prebuy to wei, or return the refusal message.
 *
 * THE ONE PREBUY PARSER. `trench.launch_preview` prices a prebuy through this
 * exact function, so a prebuy the preview accepts is a prebuy the launch
 * accepts, and an invalid one is refused with the SAME words on both surfaces.
 * A second parser would be a second opinion about how much ETH to spend.
 */
export function parsePrebuy(raw: unknown): bigint | string {
  if (raw === undefined || raw === null) return 0n;

  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!text) return "prebuy must be a decimal amount of ETH, for example \"0.0003\".";
  // Plain decimal only: no sign, no exponent, no separators. `parseUnits` would
  // accept shapes a human never means, and a mis-parsed prebuy is a mis-spend.
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return `prebuy ("${text.slice(0, 32)}") must be a plain decimal amount of ETH with no sign, exponent or separators.`;
  }

  let wei: bigint;
  try {
    wei = parseUnits(text, ETH_DECIMALS);
  } catch {
    return `prebuy ("${text.slice(0, 32)}") could not be read as an ETH amount.`;
  }
  if (wei < 0n) return "prebuy must not be negative.";
  if (wei > PREBUY_SANITY_MAX_ETH * 10n ** BigInt(ETH_DECIMALS)) {
    return `prebuy of ${text} ETH is far outside any plausible launch and was refused rather than signed.`;
  }
  return wei;
}
