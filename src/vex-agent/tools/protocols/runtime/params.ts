/**
 * Strict param-boundary validation (B-002) for protocol tool execution.
 *
 * Extracted verbatim from `../runtime.ts` as part of a façade-preserving
 * structural split. The runtime owns `executeProtocolTool`; this module owns
 * the untrusted-param boundary so the boundary stays in exactly one place.
 */

import { z } from "zod";

import type { ProtocolParamDef, ProtocolToolManifest } from "../types.js";
import { BANNED_PARAM_KEYS, CHAIN_VALUE_PARAM_KEYS } from "../conventions.js";
import { checkBpsParam } from "./bps-param.js";

// ── Strict param-boundary validation (B-002) ─────────────────────
//
// The protocol param surface is an UNTRUSTED boundary: protocol call params
// come straight from the LLM. Pre-B-002 the runtime only checked declared
// params for `required` presence + `typeof`; it let UNKNOWN/extra keys flow
// into handlers untouched and never rejected nested shape drift. This closes
// the boundary with manifest-derived Zod schemas (rule 20 §2): every declared
// key is type-validated by `primitiveSchema(...).safeParse`, and an explicit
// strict-key pass REJECTS any undeclared key with a defined value (the
// `.strict()` equivalent)
// before the handler is invoked. We keep the strict-key + required checks
// separate from Zod's per-field parse so the exact pre-B-002 messages and the
// "empty-string/null = missing" semantics are preserved byte-for-byte.
//
// Manifest params are primitive-only today (`string | number | boolean`), so
// the generated schemas are flat. `primitiveSchema` is deliberately written
// with an exhaustiveness guard so a future manifest declaring a nested
// `object`/`array` param must map to a recursive Zod schema HERE rather than
// fall through - the boundary stays at runtime.ts and never silently passes
// nested/extra keys.

/** Runtime-owned control keys recognised regardless of manifest declaration. */
//
// `dryRun` is read by the runtime ITSELF (`isPreviewExecution`) before the
// handler runs, so it is part of the runtime contract, not a per-handler param.
// Every production tool that supports preview ALSO declares `dryRun` in its
// manifest; this set only guarantees the runtime's own control key is never
// rejected as "unknown" even for a manifest that omits the declaration.
export const RESERVED_RUNTIME_PARAM_KEYS: ReadonlySet<string> = new Set(["dryRun"]);

/** Map a primitive `ProtocolParamDef.type` to its base Zod schema. */
export function primitiveSchema(type: ProtocolParamDef["type"]): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      // Exhaustiveness guard - a new param `type` must extend this mapping
      // (e.g. nested object/array → recursive schema) rather than fall through.
      return assertNeverParamType(type);
  }
}

export function assertNeverParamType(value: never): never {
  throw new Error(`Unhandled protocol param type: ${String(value)}`);
}

/**
 * The name every model-facing refusal in this module addresses the tool by.
 *
 * `publicName` is the identity the model was OFFERED and the one it wrote in
 * its call; `toolId` is the durable internal dotted id it has never seen.
 * Measured 2026-08-27: seven refusals naming `dexscreener.pairs.new` for a call
 * the model made as `dexscreener__pairs_new_list`, which is a rejection it
 * cannot match to anything it did. The HUMAN-facing dotted-id contract (tool
 * labels, the approval card) is a different surface and is unchanged.
 */
function modelFacingName(manifest: Pick<ProtocolToolManifest, "publicName">): string {
  return manifest.publicName;
}

/**
 * The `acceptsStringArray` branch of the type gate - VALIDATION ONLY.
 *
 * Returns a rejection reason, or `null` when the value is an acceptable array.
 * It deliberately does NOT transform: the handler keeps receiving the params
 * object exactly as the model sent it, so a downstream reader (and anything that
 * hashes or captures the call) sees one untouched input rather than a shape this
 * gate silently rewrote.
 *
 * An empty array refuses only on a REQUIRED param. On an OPTIONAL one it means
 * the parameter is absent and never reaches here at all: the runtime drops the
 * key first (`./empty-array-params.ts`), and the caller below treats a
 * surviving optional `[]` the same way, so a direct caller of this gate cannot
 * observe a stricter rule than the runtime enforces. A required param has no
 * absent state to fall back to, so "give me a list" and "give me nothing" stay
 * distinct there.
 *
 * A non-string member is named BY POSITION. "chainIds must be strings" leaves an
 * agent re-sending the same 12-element array with the same mistake in it.
 */
function checkStringArrayParam(
  toolName: string,
  key: string,
  value: readonly unknown[],
): string | null {
  if (value.length === 0) {
    return `Parameter "${key}" for ${toolName} is required and was an empty array. `
      + "Supply at least one value - on a required parameter an empty list cannot mean 'no filter'.";
  }
  for (const [index, member] of value.entries()) {
    if (typeof member !== "string") {
      return `Parameter "${key}" for ${toolName} accepts a string or an array of strings, but the `
        + `item at index ${index} is ${member === null ? "null" : typeof member}.`;
    }
  }
  return null;
}

/**
 * Outcome of strict param validation. `ok` carries no payload - the runtime
 * keeps operating on the already-validated `params` object; this is a boundary
 * gate, not a transform.
 */
export type ParamValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The missing-required rejection, in the shape the model can act on in ONE
 * retry (SPEC §1.5; `reports/model-research.md` §4.4).
 *
 * `Missing required parameter "query" for dexscreener.search` was true and
 * unusable: a model that had just sent `query` at the TOP level of the
 * envelope, not inside `params`, reads it as false and repeats the same call -
 * observed six times in a row. Naming the required keys, the optional keys, the
 * keys WE actually received, and a corrected minimal call ends the loop by
 * SHOWING the envelope instead of describing it.
 *
 * The example is built from the manifest's own authored `exampleParams`, so it
 * is a call that genuinely works; a required key the manifest forgot to
 * exemplify degrades to a typed placeholder rather than an invented value.
 *
 * The example is shown in the CURRENT calling convention: the tool is a
 * function named by its `publicName` and its arguments are the params, flat.
 * The `{"toolId": ..., "params": {...}}` envelope it used to print is retired
 * and showing it taught the model a call shape that no longer exists.
 *
 * KEYS ONLY, never values, on the "you sent" lane (rule 06): a param value can
 * carry untrusted or secret-adjacent content, a key name cannot.
 */
function describeMissingRequired(
  manifest: ProtocolToolManifest,
  param: ProtocolParamDef,
  params: Record<string, unknown>,
): string {
  const name = modelFacingName(manifest);
  const requiredParams = manifest.params.filter((p) => p.required === true);
  const optional = manifest.params.filter((p) => p.required !== true).map((p) => p.key);
  const sent = Object.keys(params).filter((key) => params[key] !== undefined);
  const example = `${name}(${JSON.stringify(
    Object.fromEntries(
      requiredParams.map((p) => [
        p.key,
        manifest.exampleParams[p.key] ?? `<${p.type}>`,
      ] as const),
    ),
  )})`;
  return `Missing required parameter "${param.key}" (${param.type}) for ${name}. `
    + `Required: ${requiredParams.map((p) => p.key).join(", ")}. `
    + `Optional: ${optional.join(", ") || "(none)"}. `
    + `Send: ${example}. `
    + `You sent parameter keys: [${sent.join(", ")}]. `
    + `Do not repeat the previous call - add "${param.key}" and call once.`;
}

/**
 * The one sentence a mutually exclusive param group is stated in - authored
 * HERE so the rule the model reads on the injected tool schema and the
 * rule it is rejected by are word-for-word the same rule.
 */
export function describeExclusiveParamGroup(group: readonly string[]): string {
  return `Provide exactly one of: ${group.join(", ")}.`;
}

/** The `atMostOne` sentence - zero members is legal, two is not. */
export function describeAtMostOneGroup(group: readonly string[]): string {
  return `Provide at most one of: ${group.join(", ")}.`;
}

/** The `atLeastOneOf` sentence - two members are legal, none is not. */
export function describeAtLeastOneOfGroup(group: readonly string[]): string {
  return `Provide at least one of: ${group.join(", ")}.`;
}

/**
 * Every cross-param group rule of `manifest`, rendered, in enforcement order.
 * Empty when none are declared - a tool without groups pays nothing on the
 * discovery row or in its injected description.
 */
export function describeParamGroupConstraints(manifest: ProtocolToolManifest): string[] {
  return [
    ...(manifest.exclusiveParamGroups ?? []).map(describeExclusiveParamGroup),
    ...(manifest.atMostOne ?? []).map(describeAtMostOneGroup),
    ...(manifest.atLeastOneOf ?? []).map(describeAtLeastOneOfGroup),
  ];
}

/**
 * Closed-value-set check. Names the ALLOWED values - a rejection that withholds
 * them costs the agent another call - and never echoes what was sent, which is
 * untrusted string content (rule 06). Arrays are checked member-wise, by
 * position, for the same reason `checkStringArrayParam` names the index.
 */
function checkEnumParam(
  toolName: string,
  param: ProtocolParamDef,
  value: unknown,
): string | null {
  const allowed = param.enum;
  if (!allowed || allowed.length === 0) return null;
  const matching = CHAIN_VALUE_PARAM_KEYS.includes(param.key)
    ? "(a chain value matches in any case)"
    : "(exact match, case-sensitive)";
  const suffix = `Allowed values for "${param.key}" on ${toolName}: ${allowed.join(", ")} `
    + `${matching}.`;

  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      if (typeof member === "string" && allowed.includes(member)) continue;
      return `Parameter "${param.key}" for ${toolName} has an unsupported value at index ${index}. ${suffix}`;
    }
    return null;
  }
  if (typeof value === "string" && allowed.includes(value)) return null;
  return `Parameter "${param.key}" for ${toolName} has an unsupported value. ${suffix}`;
}

/**
 * A group member counts as PRESENT under the same "empty means absent" rule the
 * required gate uses, so one call cannot be missing a param for one check and
 * carrying it for another.
 */
function presentGroupMembers(
  group: readonly string[],
  params: Record<string, unknown>,
): string[] {
  return group.filter((key) => {
    const value = params[key];
    return value !== undefined && value !== null && value !== "";
  });
}

/** The group's keys, quoted, as every group rejection names them. */
function nameGroup(group: readonly string[]): string {
  return group.map((key) => `"${key}"`).join(", ");
}

/**
 * Mutual exclusion, enforced once for the whole manifest instead of in each
 * handler that remembered to. Names the GROUP, not the offending key: an agent
 * told only that `tokenAddress` is unexpected cannot tell that `pairAddress`
 * was the alternative it should have kept.
 *
 * KEYS ONLY on the "you sent" lane (rule 06) - and the same is true of the two
 * weaker group gates below.
 */
function checkExclusiveParamGroups(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): string | null {
  const groups = manifest.exclusiveParamGroups;
  if (!groups || groups.length === 0) return null;

  for (const group of groups) {
    const present = presentGroupMembers(group, params);
    if (present.length === 1) continue;
    const problem = present.length === 0
      ? `none of them is set`
      : `you sent ${present.length}: [${present.join(", ")}]`;
    return `Parameters ${nameGroup(group)} for ${modelFacingName(manifest)} `
      + `are mutually exclusive and ${problem}. ${describeExclusiveParamGroup(group)}`;
  }
  return null;
}

/**
 * `atMostOne`: zero members is a legal call, two is not. Same "name the GROUP,
 * not the offending key" contract as the exactly-one gate - the alternative the
 * agent should have kept is only visible when the whole group is named.
 */
function checkAtMostOneGroups(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): string | null {
  for (const group of manifest.atMostOne ?? []) {
    const present = presentGroupMembers(group, params);
    if (present.length <= 1) continue;
    return `Parameters ${nameGroup(group)} for ${modelFacingName(manifest)} cannot be combined, `
      + `and you sent ${present.length}: [${present.join(", ")}]. ${describeAtMostOneGroup(group)}`;
  }
  return null;
}

/**
 * `atLeastOneOf`: the empty call is the only failure, so the message's whole job
 * is listing what WOULD have worked. "Nothing to do" without that list is the
 * handler-side refusal this field replaces.
 */
function checkAtLeastOneOfGroups(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): string | null {
  for (const group of manifest.atLeastOneOf ?? []) {
    if (presentGroupMembers(group, params).length > 0) continue;
    return `Parameters ${nameGroup(group)} for ${modelFacingName(manifest)} are all absent - `
      + `this call would do nothing. ${describeAtLeastOneOfGroup(group)}`;
  }
  return null;
}

/**
 * W6f - a chain param that arrived as a JSON NUMBER becomes its decimal string.
 *
 * The ONLY normalization this gate performs, and deliberately the narrowest one
 * that closes a real failure: every chain-valued param advertises
 * "slug or the numeric chain id `TokenFind` returns" (see
 * `conventions.ts::CANONICAL_CHAIN_SENTENCE`), so a model that read the
 * description and sent `{chain: 8453}` wrote a legal value in the wrong JSON
 * type and was rejected for it.
 *
 * Bounded by the {@link CHAIN_VALUE_PARAM_KEYS} allowlist AND by the manifest's
 * own `type: "string"` declaration: every other param keeps strict typing, so a
 * number for a non-chain string param is still rejected. Amounts can never be
 * reached - they are not chain keys.
 *
 * It MUTATES the caller's params object on purpose: the handler, the capture
 * row, and this gate must all see one identical value.
 *
 * The SECOND normalization on the same allowlist, in the same mutating pattern
 * and for the same reason: a chain param that declares an `enum` matches its
 * value CASE-INSENSITIVELY and is rewritten to the declared spelling. Only
 * chain keys fold - case is not a distinction a chain value carries, while on
 * an ordinary enum (a market name, a stats window) it can be, so every other
 * param keeps exact matching. `virtuals.list.chain` is the live case: an
 * UPPERCASE list every other manifest in the tree spells lowercase.
 */
function normalizeChainValueParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): void {
  for (const param of manifest.params) {
    if (param.type !== "string") continue;
    if (!CHAIN_VALUE_PARAM_KEYS.includes(param.key)) continue;
    const value = params[param.key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      params[param.key] = String(value);
      continue;
    }
    if (typeof value !== "string") continue;
    const declared = matchEnumIgnoringCase(param, value);
    if (declared !== undefined) params[param.key] = declared;
  }
}

/**
 * The declared enum member equal to `value` ignoring case, or `undefined` when
 * the param declares no enum or nothing matches (an off-list value is left
 * untouched for `checkEnumParam` to reject and name the allowed values).
 *
 * Returns the DECLARED spelling, not the lowercased input: the provider adapter
 * downstream reads the manifest's own vocabulary, and an enum may legitimately
 * be uppercase.
 */
function matchEnumIgnoringCase(param: ProtocolParamDef, value: string): string | undefined {
  const folded = value.toLowerCase();
  return param.enum?.find((member) => member.toLowerCase() === folded);
}

/**
 * Validate `params` against `manifest.params` at the trust boundary.
 *
 * Order (each fails closed BEFORE the handler runs):
 *  0. CHAIN normalization - the only transforms in this gate (number→string and
 *     enum case-folding, chain keys only); see `normalizeChainValueParams`.
 *  1. UNKNOWN keys - any key with a DEFINED value that is neither declared nor
 *     runtime-reserved is rejected, NAMING the replacement when the key is a
 *     retired spelling (`BANNED_PARAM_KEYS`). A key whose value is `undefined`
 *     is treated as absent (JSON/storage semantics) and skipped, not rejected.
 *  2. REQUIRED presence - `undefined | null | ""` for a required param is
 *     "missing" (preserves the pre-B-002 empty-string-as-absent semantics so
 *     an empty optional is allowed and an empty required is rejected).
 *  3. TYPE - a PRESENT param whose value fails its declared primitive schema is
 *     rejected. Missing optionals are not type-checked, and an EMPTY array on
 *     an optional `acceptsStringArray` param IS absent (`./empty-array-params.ts`
 *     drops the key upstream; this gate agrees so a direct caller cannot see a
 *     stricter rule than the runtime enforces). A REQUIRED list param still
 *     refuses an empty array.
 *  4. ENUM - a param declaring a closed value set rejects anything off it,
 *     naming the allowed values.
 *  5. UNIT - a param declaring a domain unit (`unit: "bps"`) must additionally
 *     satisfy that unit's contract. `z.number()` accepts `0.5`, but a
 *     fractional basis-point value is meaningless at every venue and is
 *     actively dangerous at Jupiter (see `./bps-param.ts`). Runs after the type
 *     gate so the value is already proven to be a number.
 *  6. GROUPS - each declared `exclusiveParamGroups` group must have exactly one
 *     member present, each `atMostOne` group at most one, each `atLeastOneOf`
 *     group at least one. Runs LAST, and only when steps 1-5 collected nothing:
 *     a group is about the CALL, not a value.
 *
 * Steps 1-5 COLLECT. Every offending parameter is named in one refusal, at most
 * one error each, in the order above, bounded by `RefusalAccumulator` (which
 * reports what it did not list). Aborting at the first key cost one round trip
 * per key; see the accumulator's doc for the loop that measured it.
 *
 * Every refusal addresses the tool by its `publicName` (see `modelFacingName`).
 *
 * Messages are agent-actionable and contain only the offending KEY + declared
 * type - never a string value (which could carry untrusted/secret-adjacent
 * content). The `unit` rejection additionally echoes the offending NUMBER,
 * which is inert by construction; see `checkBpsParam`.
 */
/**
 * The ONE way a `rejectedParams` explanation is looked up.
 *
 * `Object.hasOwn`, never a bare index. The key comes from the MODEL (it is the
 * unknown parameter it just sent) and the table is an ordinary object literal,
 * so `rejectedParams["constructor"]` resolves up the prototype chain to
 * `function Object() { [native code] }` - which the caller then splices into
 * the sentence it hands the agent. Reproduced through the real boundary with
 * `constructor` and `toString`.
 *
 * Exported so the fleet-wide manifest suite can assert this exact accessor over
 * every registered table, rather than re-deriving the rule and testing a copy
 * of it.
 */
export function readRejectedParamReason(
  manifest: Pick<ProtocolToolManifest, "rejectedParams">,
  key: string,
): string | undefined {
  const table = manifest.rejectedParams;
  if (table === undefined || !Object.hasOwn(table, key)) return undefined;
  const reason = table[key];
  return typeof reason === "string" && reason.trim().length > 0 ? reason : undefined;
}

/**
 * The most parameter-level errors one refusal renders, and the most unknown
 * keys inside that budget.
 *
 * A refusal exists to be ACTED ON. Twenty sentences is a wall the agent skims;
 * eight is a checklist it can work through in one retry. Unknown keys get the
 * smaller share because each one repeats the same allowed-parameter list.
 */
const MAX_REPORTED_PARAM_ERRORS = 8;
const MAX_REPORTED_UNKNOWN_KEYS = 5;

/** Longest model-authored key rendered verbatim inside a refusal. */
const MAX_RENDERED_KEY_CHARS = 64;

/**
 * A key the MODEL invented, rendered for the refusal that names it.
 *
 * The key is untrusted in LENGTH: a malformed tool call can carry a
 * multi-kilobyte property name, and splicing it whole into model-visible output
 * spends the agent's context on its own typo. The bound REPORTS itself - the
 * agent is told the rendering was shortened and by how much - so nothing is
 * silently dropped (CLAUDE.md: a bound that names what it left out is a bound,
 * not a cut).
 */
function renderModelKey(key: string): string {
  if (key.length <= MAX_RENDERED_KEY_CHARS) return key;
  return `${key.slice(0, MAX_RENDERED_KEY_CHARS)}[... key shortened for display, `
    + `${key.length} characters total]`;
}

/**
 * Every parameter-level problem in ONE refusal instead of one round trip each.
 *
 * Measured 2026-08-27: a strict-mode gateway filled every list filter of
 * `dexscreener__pairs_new_list` and the gate answered the FIRST offending key
 * only, so no single refusal could tell the agent what the whole call had to
 * become. The accumulator preserves the enforcement ORDER (unknown keys, then
 * required, then type, then enum/unit) and holds at most one error per
 * parameter. It is BOUNDED in both directions - it stops after
 * {@link MAX_REPORTED_PARAM_ERRORS} errors and after
 * {@link MAX_REPORTED_UNKNOWN_KEYS} unknown keys - and it STATES how many
 * problems it did not list, so the agent knows another pass is coming.
 */
class RefusalAccumulator {
  private readonly reasons: string[] = [];
  private unknownKeysSeen = 0;
  private suppressed = 0;

  /**
   * Reserve the unknown-key budget BEFORE the caller builds a sentence, so a
   * key past the cap costs neither a rendered message nor a table lookup.
   * Returns false when this unknown key will not be listed.
   */
  admitUnknownKey(): boolean {
    this.unknownKeysSeen += 1;
    if (this.unknownKeysSeen > MAX_REPORTED_UNKNOWN_KEYS) {
      this.suppressed += 1;
      return false;
    }
    return true;
  }

  add(reason: string): void {
    if (this.reasons.length >= MAX_REPORTED_PARAM_ERRORS) {
      this.suppressed += 1;
      return;
    }
    this.reasons.push(reason);
  }

  /** The refusal text, or `null` when nothing was collected. */
  render(): string | null {
    if (this.reasons.length === 0) return null;
    const tail = this.suppressed > 0
      ? [`${this.suppressed} further parameter problem`
        + `${this.suppressed === 1 ? " was" : "s were"} not listed. `
        + `Fix the ones above and call again to see the rest.`]
      : [];
    return [...this.reasons, ...tail].join("\n");
  }
}

export function validateProtocolParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): ParamValidation {
  const declared = new Map(manifest.params.map((p) => [p.key, p] as const));
  const name = modelFacingName(manifest);
  const errors = new RefusalAccumulator();

  // 0. Chain-key number->string normalization (W6f) - see the function's doc for
  // why this one transform lives inside an otherwise pure gate.
  normalizeChainValueParams(manifest, params);

  // 1. Strict unknown-key rejection.
  for (const key of Object.keys(params)) {
    // A key whose value is `undefined` is equivalent to an absent key: JSON
    // drops it, LLM tool-call params arrive via JSON.parse and never carry
    // `undefined`, and capture/storage already normalises `undefined` away.
    // Treat it as absent rather than an "unknown key"; a real unknown VALUE is
    // still rejected here, and a wrong-typed declared value is still rejected below.
    if (params[key] === undefined) continue;
    if (!declared.has(key) && !RESERVED_RUNTIME_PARAM_KEYS.has(key)) {
      if (!errors.admitUnknownKey()) continue;
      // A key the convention RETIRED is answered with its replacement. The
      // banned spellings are exactly the ones a model reaches for from memory
      // of the pre-convention tree (`chainId`, `amount`, `inputToken`), and
      // "unknown parameter" alone leaves it guessing which of eleven allowed
      // keys was meant. See BANNED_PARAM_KEYS in `conventions.ts`.
      /*
       * S10-11. A HINT MUST NOT NAME A KEY THIS TOOL ALSO REFUSES.
       *
       * The retired-spelling table is fleet-wide, so its replacement is the
       * canonical key across the tree and not necessarily a key THIS manifest
       * declares. Measured: dexscreener__pairs_batch_get answered "chains" with
       * "Instead use `chainIds`" while `chainIds` is not a parameter of that
       * tool either, sending the agent straight into a second refusal. The
       * replacement text is prose, so the keys it recommends are read out of it
       * by their backticks and checked against what is actually declared.
       */
      const rawReplacement = BANNED_PARAM_KEYS.get(key);
      const recommends = [
        ...(rawReplacement ?? "").matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g),
      ].map((match) => match[1] ?? "");
      const replacement =
        rawReplacement === undefined
          ? undefined
          : recommends.length === 0 || recommends.some((one) => declared.has(one))
            ? rawReplacement
            : undefined;
      // A per-tool explanation for a key the TOOL cannot support, as opposed to
      // a spelling the convention retired. Same purpose as the banned-key hint
      // above and the same place in the message: the agent is about to pick
      // another name off the allowed list, and a filter that is structurally
      // impossible here needs to say WHY or it gets retried under a synonym.
      const rejected = readRejectedParamReason(manifest, key);
      errors.add(
        `Unknown parameter "${renderModelKey(key)}" for ${name}. `
        + (rejected ? `${rejected} ` : "")
        + (replacement ? `Instead ${replacement}. ` : "")
        + `Allowed parameters: ${manifest.params.map((p) => p.key).join(", ") || "(none)"}.`,
      );
    }
  }

  // 2 + 3 + 4 + 5. Per-declared-param checks, at most ONE error per parameter:
  // the first gate a key fails is the one that answers it, and no enum or unit
  // verdict is rendered for a value whose TYPE is already wrong.
  for (const param of manifest.params) {
    const value = params[param.key];
    const missing = value === undefined || value === null || value === "";
    if (param.required && missing) {
      errors.add(describeMissingRequired(manifest, param, params));
      continue;
    }
    if (missing) continue; // optional + absent - not type-checked

    if (Array.isArray(value)) {
      // `typeof [] === "object"`, so the generic message below would tell an
      // agent that sent a list that we expected a string and got an "object" -
      // true, unhelpful, and the exact wording that cost a call in the persona
      // gate. Both branches name the array explicitly.
      if (param.acceptsStringArray !== true) {
        errors.add(
          `Parameter "${param.key}" for ${name} has invalid type: `
          + `expected ${param.type}, got array - this parameter takes a single value, not a list.`,
        );
        continue;
      }
      // An EMPTY array on an OPTIONAL list param IS the absent parameter (see
      // `./empty-array-params.ts`, which removes the key upstream). Nothing is
      // filtered on and nothing is refused; a required param falls through to
      // the empty-array refusal below.
      if (value.length === 0 && param.required !== true) continue;
      const violation = checkStringArrayParam(name, param.key, value);
      if (violation) {
        errors.add(violation);
        continue;
      }
      const offList = checkEnumParam(name, param, value);
      if (offList) errors.add(offList);
      continue; // validated as a list; the primitive schema does not apply
    }

    const parsed = primitiveSchema(param.type).safeParse(value);
    if (!parsed.success) {
      errors.add(
        `Parameter "${param.key}" for ${name} has invalid type: `
        + `expected ${param.type}, got ${typeof value}`,
      );
      continue;
    }

    // 4. Closed value set. Runs after the type gate so the value is already
    // proven to be a string.
    const offList = checkEnumParam(name, param, value);
    if (offList) {
      errors.add(offList);
      continue;
    }

    // 5. Domain-unit contract. `unit` is only meaningful on a numeric param;
    // the `typeof` guard keeps a mis-declared manifest from crashing the gate
    // (`protocol-manifest-bps-units.test.ts` fails the build for that case).
    if (param.unit === "bps" && typeof value === "number") {
      const violation = checkBpsParam(name, param.key, value);
      if (violation) errors.add(violation);
    }
  }

  const collected = errors.render();
  if (collected !== null) return { ok: false, reason: collected };

  // 6. Cross-param group rules, once for the manifest, strongest first. Runs
  // AFTER the collected per-parameter errors and only when there are none: a
  // group verdict is about the SHAPE of a call whose individual values are
  // already known good, and rendering it over a call that also has an unknown
  // key or a wrong type sends the agent after the wrong correction first.
  const exclusivityViolation = checkExclusiveParamGroups(manifest, params);
  if (exclusivityViolation) return { ok: false, reason: exclusivityViolation };
  const atMostOneViolation = checkAtMostOneGroups(manifest, params);
  if (atMostOneViolation) return { ok: false, reason: atMostOneViolation };
  const atLeastOneViolation = checkAtLeastOneOfGroups(manifest, params);
  if (atLeastOneViolation) return { ok: false, reason: atLeastOneViolation };

  return { ok: true };
}
