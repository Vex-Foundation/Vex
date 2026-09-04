/**
 * A deterministic auditor for the derivations a tool payload must REFUSE.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT MORE PROSE. Live agent session
 * 2026-08-30: `dexscreener__top_traders_list` already carried "share of token
 * supply held" in `unknowns.cannotDetermine` and stated verbatim in
 * `traderSemantics` that its retained percentage is never a share of supply.
 * The agent divided the per-row amount by the token's total supply anyway, told
 * the user "the top wallet holds about 90 percent of total supply", hit the
 * falsifying evidence (the top 20 amounts summing to about 110 percent of
 * supply), reasoned about it at length, and rationalized it away. In the same
 * session it read `liquidityUsd` rising 210K to 223K as "someone added to the
 * pool", where nothing anywhere said that figure is a price mark.
 *
 * The lesson is that a field name that invites a division, sitting next to a
 * number, beats a paragraph that forbids it. So the remedy is a SHAPE
 * obligation and this module is the machine that checks it: for each
 * derivation an agent was measured performing, it walks the real payload and
 * asks whether the refusal is present as a FIELD, adjacent to the number that
 * invites the derivation. A payload that carries the number and not the
 * refusal returns `unrefused`, which is a failing verdict.
 *
 * It is pure and takes a payload object: it neither fetches nor interprets
 * prose, and it never reads a note or a description. Deleting a refusal field
 * or renaming the amount back to a balance-shaped name turns a verdict red.
 */

/** The four derivations under audit. Three must be refused; one must be supported. */
export type DerivationKind =
  | "supply_share"
  | "entity_control"
  | "liquidity_flow"
  | "position_value";

export interface CandidateDerivation {
  readonly id: string;
  /** The tool whose payload the agent read. */
  readonly tool: string;
  readonly kind: DerivationKind;
  /** The payload key the agent read the number out of. */
  readonly readsField: string;
  /**
   * The key that must sit BESIDE `readsField` and refuse this derivation.
   *
   * Named explicitly rather than derived from `readsField` by string surgery:
   * the refusal key is a contract of its own, and a spec that spells it out is
   * the thing a reviewer can compare against the payload.
   */
  readonly refusalField?: string;
  /**
   * The claim the agent made, verbatim from the session when this row records
   * a measured failure. Evidence, never matched against.
   */
  readonly claim: string;
  /** True when the claim reached a user in the recorded session. */
  readonly measuredFailure: boolean;
}

export type AuditVerdict =
  /** The payload carries an explicit, machine-readable refusal at every site. */
  | { readonly verdict: "refused"; readonly refusals: readonly string[] }
  /** The payload carries the derivation's own basis, so it is a supported read. */
  | { readonly verdict: "supported"; readonly basis: readonly string[] }
  /** The number is present and nothing in the shape refuses the derivation. */
  | { readonly verdict: "unrefused"; readonly sites: readonly string[] }
  /** The payload does not carry the field at all, so there is nothing to audit. */
  | { readonly verdict: "field_absent" };

interface Site {
  readonly path: string;
  readonly parent: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every place `key` appears in the payload, with the object that holds it. */
export function findSites(
  payload: unknown,
  key: string,
  path = "$"
): readonly Site[] {
  const found: Site[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => {
      found.push(...findSites(entry, key, `${path}[${index}]`));
    });
    return found;
  }
  if (!isObject(payload)) return found;
  if (Object.hasOwn(payload, key)) {
    found.push({ path: `${path}.${key}`, parent: payload });
  }
  for (const [name, value] of Object.entries(payload)) {
    found.push(...findSites(value, key, `${path}.${name}`));
  }
  return found;
}

/**
 * The refusal each kind requires, as a predicate over the object that HOLDS
 * the number. Adjacency is the point: an envelope-level paragraph is not a
 * substitute and is deliberately not accepted here.
 */
const SIBLING_REFUSAL: Readonly<
  Record<
    Exclude<DerivationKind, "liquidity_flow" | "position_value">,
    (key: string, parent: Record<string, unknown>) => boolean
  >
> = {
  supply_share: (key, parent) => {
    const block = parent[key];
    return isObject(block) && block["status"] === "not_determinable";
  },
  entity_control: (key, parent) => parent[key] === "unknown",
};

/**
 * Audit one derivation against one real payload.
 *
 * `liquidity_flow` is the one kind whose refusal is not a sibling: the USD
 * figure is a single pool-level number, so its qualifier is a single
 * pool-level block. The check is still structural, and it is total: EVERY
 * occurrence of the figure in the payload must be covered by a block that
 * carries the same value and declares the flow claim underivable.
 */
export function auditDerivation(
  payload: Record<string, unknown>,
  derivation: CandidateDerivation
): AuditVerdict {
  const sites = findSites(payload, derivation.readsField);
  if (sites.length === 0) return { verdict: "field_absent" };

  if (derivation.kind === "liquidity_flow") {
    const block = payload["liquidityInterpretation"];
    if (!isObject(block)) {
      return { verdict: "unrefused", sites: sites.map((site) => site.path) };
    }
    /*
     * TWO SCOPES, ONE OBLIGATION. A single-pool answer echoes the figure, so
     * coverage means the block and the number are demonstrably about the same
     * pool. A many-row ranking has no single figure to echo: the block is
     * about what the FIELD means, which does not vary per row, so it declares
     * that scope and covers every row at once. Anything else is unrefused.
     */
    const scope = block["appliesTo"];
    const scoped =
      scope === "every_row_in_this_answer"
      || sites.every((site) => site.parent[derivation.readsField] === block["liquidityUsd"]);
    const covered =
      block["establishesLiquidityAddedOrRemoved"] === false
      && block["basis"] === "mark_to_market_usd"
      && scoped;
    return covered
      ? { verdict: "refused", refusals: ["$.liquidityInterpretation"] }
      : { verdict: "unrefused", sites: sites.map((site) => site.path) };
  }

  if (derivation.kind === "position_value") {
    const basis: string[] = [];
    for (const site of sites) {
      const block = site.parent["currentHoldingValueBasis"];
      if (!isObject(block)) continue;
      if (block[derivation.readsField] === site.parent[derivation.readsField]) {
        basis.push(`${site.path} -> currentHoldingValueBasis`);
      }
    }
    /*
     * At least one site, not every site: the amount appears both on the row
     * and inside the derivation's own basis block, and the basis block does
     * not nest a second copy of itself. What this verdict has to establish is
     * that the supported derivation is still AVAILABLE, which one site proves.
     */
    return basis.length > 0
      ? { verdict: "supported", basis }
      : { verdict: "unrefused", sites: sites.map((site) => site.path) };
  }

  const check = SIBLING_REFUSAL[derivation.kind];
  const key = derivation.refusalField;
  if (key === undefined) {
    throw new Error(`${derivation.id}: ${derivation.kind} needs a refusalField`);
  }
  const refusals: string[] = [];
  const unrefused: string[] = [];
  for (const site of sites) {
    if (check(key, site.parent)) refusals.push(`${site.path} -> ${key}`);
    else unrefused.push(site.path);
  }
  return unrefused.length === 0
    ? { verdict: "refused", refusals }
    : { verdict: "unrefused", sites: unrefused };
}

/**
 * Names a payload must never use for a venue-observed retained amount.
 *
 * The rename is the mechanism, so a revert of it is a defect this eval has to
 * see. `balanceAmount` is the provider's own wire spelling and stays that in
 * `src/tools/dexscreener/endpoints/`, where it is a codec fact; what is
 * forbidden is emitting it to the MODEL, where it reads as an on-chain
 * holding and was measured being divided by supply.
 */
export const FORBIDDEN_MODEL_VISIBLE_KEYS: readonly string[] = [
  "balanceAmount",
  "balance",
  "tokenBalance",
  "holdings",
];
