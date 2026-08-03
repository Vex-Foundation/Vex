/**
 * The per-tool convention rules. Pure, no IO, one exported function per rule
 * so a wave can find (and a reviewer can read) exactly what it changed.
 *
 * Every message names the FIX, not just the fault: this text ends up in a test
 * failure a later session reads with no conversation context.
 */

import {
  BANNED_PARAM_KEYS,
  CANONICAL_CHAIN_SENTENCE,
  CANONICAL_PARAM_KEYS,
  CHAIN_VALUE_PARAM_KEYS,
} from "../conventions.js";

export type ManifestLintRule =
  | "param-key"
  | "amount-bps-shape"
  | "param-description"
  | "tool-description"
  | "example-params-required"
  | "generic-error-literal"
  | "slippage-default-home"
  | "chain-doc-parity"
  | "exclusive-param-groups"
  | "enum-declaration";

export interface ManifestLintIssue {
  /** Tool id, tool name, or source path — whatever owns the violation. */
  readonly subject: string;
  readonly rule: ManifestLintRule;
  /** The deletable unit inside the subject: a param key, a literal, a symbol. */
  readonly detail: string;
  readonly message: string;
}

/** A param as the rules read it, from either the manifest or a JSON schema. */
export interface LintParam {
  readonly key: string;
  readonly type: string;
  readonly description: string;
  readonly required: boolean;
  readonly unit?: string;
  readonly enum?: readonly string[];
}

const MIN_PARAM_DESCRIPTION = 25;
const MIN_TOOL_DESCRIPTION = 120;

const AMOUNT_KEY = /(^|[a-z])[Aa]mount/;
const BPS_KEY = /Bps$/;
const HUMAN_AMOUNT_SUFFIX = /(In|Out)$/;
const RAW_AMOUNT_SUFFIX = /Raw$/;

const AMOUNT_UNIT_ANCHOR = /human|raw|base unit|atomic|decimal/i;
const BPS_UNIT_ANCHOR = /basis point|1 bps = 0\.01%/i;
const CHAIN_UNIT_ANCHOR = /slug|chain id|chainid/i;
const DECIMALS_SOURCE_ANCHOR = /token_find|decimals/i;

const WHEN_TO_USE_ANCHOR = /Use (this )?when|Call this|before|after/i;
const RETURNS_ANCHOR = /returns|answers with/i;
const SPENDS_ANCHOR = /spend|broadcast|real funds|on-chain transaction|signs/i;

const XOR_PROSE = /mutually exclusive|exactly one of|either .{0,60}\bor\b.{0,60}not both|not both|only one of/i;
// Deliberately narrower than XOR_PROSE: the bare phrases "at most one" / "at
// least one" are ordinary English about DATA ("rows with at least one social
// link"), and only the "… of" form names a param set. A rule that cannot tell
// those apart is a rule that gets allowlisted.
const AT_MOST_ONE_PROSE = /\bat most one of\b/i;
const AT_LEAST_ONE_PROSE = /\bat least one of\b/i;
const VALUE_LIST_PROSE = /\bone of\b/i;

function isChainValueKey(key: string): boolean {
  return CHAIN_VALUE_PARAM_KEYS.includes(key);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ── 1. param-key ─────────────────────────────────────────────────

export function lintParamKey(subject: string, param: LintParam): ManifestLintIssue[] {
  const banned = BANNED_PARAM_KEYS.get(param.key);
  if (banned) {
    return [{
      subject, rule: "param-key", detail: param.key,
      message: `banned param key \`${param.key}\` — ${banned}`,
    }];
  }
  if (!CANONICAL_PARAM_KEYS.has(param.key)) {
    return [{
      subject, rule: "param-key", detail: param.key,
      message:
        `param key \`${param.key}\` is not in CANONICAL_PARAM_KEYS (conventions.ts). `
        + "Rename it to a canonical key, or add it there with a one-line rationale.",
    }];
  }
  return [];
}

// ── 2. amount-bps-shape ──────────────────────────────────────────

export function lintAmountBpsShape(subject: string, param: LintParam): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [];
  if (AMOUNT_KEY.test(param.key)) {
    if (param.type !== "string") {
      issues.push({
        subject, rule: "amount-bps-shape", detail: param.key,
        message:
          `amount param \`${param.key}\` is type "${param.type}" — every amount travels as a STRING `
          + "(an 18-decimal amount through IEEE-754 is a silent loss).",
      });
    }
    if (!HUMAN_AMOUNT_SUFFIX.test(param.key) && !RAW_AMOUNT_SUFFIX.test(param.key)) {
      issues.push({
        subject, rule: "amount-bps-shape", detail: param.key,
        message:
          `amount param \`${param.key}\` must end in \`In\`/\`Out\` (human decimals) or \`Raw\` `
          + "(base units) — the key is the only unit signal a model sees when composing from a sibling call.",
      });
    }
  }
  if (BPS_KEY.test(param.key)) {
    if (param.type !== "number") {
      issues.push({
        subject, rule: "amount-bps-shape", detail: param.key,
        message:
          `bps param \`${param.key}\` is type "${param.type}" — declare \`type: "number"\` so the `
          + "manifest bps gate (runtime/bps-param.ts) actually runs on it.",
      });
    }
    if (param.unit !== "bps") {
      issues.push({
        subject, rule: "amount-bps-shape", detail: param.key,
        message: `bps param \`${param.key}\` must declare \`unit: "bps"\` — without it a fractional value is accepted.`,
      });
    }
  }
  return issues;
}

// ── 3. param-description ─────────────────────────────────────────

export function lintParamDescription(subject: string, param: LintParam): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [];
  const text = normalize(param.description);

  if (text.length < MIN_PARAM_DESCRIPTION) {
    issues.push({
      subject, rule: "param-description", detail: param.key,
      message: `param \`${param.key}\` description is ${text.length} chars (< ${MIN_PARAM_DESCRIPTION}): "${text}"`,
    });
  }
  if (AMOUNT_KEY.test(param.key) && !AMOUNT_UNIT_ANCHOR.test(text)) {
    issues.push({
      subject, rule: "param-description", detail: param.key,
      message: `param \`${param.key}\` description names no unit — say HUMAN decimals or RAW base units.`,
    });
  }
  if (RAW_AMOUNT_SUFFIX.test(param.key) && AMOUNT_KEY.test(param.key) && !DECIMALS_SOURCE_ANCHOR.test(text)) {
    issues.push({
      subject, rule: "param-description", detail: param.key,
      message: `raw amount \`${param.key}\` must name where the decimals come from (token_find).`,
    });
  }
  if (BPS_KEY.test(param.key) && !BPS_UNIT_ANCHOR.test(text)) {
    issues.push({
      subject, rule: "param-description", detail: param.key,
      message: `bps param \`${param.key}\` description must state "basis points (1 bps = 0.01%)".`,
    });
  }
  if (isChainValueKey(param.key) && !CHAIN_UNIT_ANCHOR.test(text)) {
    issues.push({
      subject, rule: "param-description", detail: param.key,
      message: `chain param \`${param.key}\` description must state the accepted value form (slug or chain id).`,
    });
  }
  return issues;
}

// ── 4. tool-description ──────────────────────────────────────────

export function lintToolDescription(
  subject: string,
  description: string,
  mutating: boolean,
): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [];
  const text = normalize(description);

  if (text.length < MIN_TOOL_DESCRIPTION) {
    issues.push({
      subject, rule: "tool-description", detail: "length",
      message: `tool description is ${text.length} chars (< ${MIN_TOOL_DESCRIPTION}).`,
    });
  }
  if (!WHEN_TO_USE_ANCHOR.test(text)) {
    issues.push({
      subject, rule: "tool-description", detail: "when-to-use",
      message: "tool description has no WHEN TO USE anchor (the question this tool answers).",
    });
  }
  if (!RETURNS_ANCHOR.test(text)) {
    issues.push({
      subject, rule: "tool-description", detail: "returns",
      message: "tool description states no RETURNS shape — the agent must not guess the result keys.",
    });
  }
  if (mutating && !SPENDS_ANCHOR.test(text)) {
    issues.push({
      subject, rule: "tool-description", detail: "spends",
      message: "mutating tool description must state that real funds move (SPENDS).",
    });
  }
  return issues;
}

// ── 5. example-params-required ───────────────────────────────────

export function lintExampleParamsRequired(
  subject: string,
  params: readonly LintParam[],
  exampleParams: Record<string, unknown>,
): ManifestLintIssue[] {
  return params
    .filter((param) => param.required && !(param.key in exampleParams))
    .map((param) => ({
      subject, rule: "example-params-required" as const, detail: param.key,
      message: `required param \`${param.key}\` is missing from exampleParams — the worked call must be callable.`,
    }));
}

// ── 8. chain-doc-parity ──────────────────────────────────────────

export function lintChainDocParity(subject: string, param: LintParam): ManifestLintIssue[] {
  if (!isChainValueKey(param.key)) return [];
  const text = normalize(param.description).toLowerCase().replace(/[`"']/g, "");
  const canonical = normalize(CANONICAL_CHAIN_SENTENCE).toLowerCase().replace(/[`"']/g, "");
  if (text.includes(canonical)) return [];
  return [{
    subject, rule: "chain-doc-parity", detail: param.key,
    message:
      `chain param \`${param.key}\` does not carry CANONICAL_CHAIN_SENTENCE — the protocol lane and the `
      + "alias lane must document identical accepted formats.",
  }];
}

// ── 9. exclusive-param-groups ────────────────────────────────────

export function lintExclusiveParamGroups(
  subject: string,
  params: readonly LintParam[],
  declared: DeclaredParamGroups | undefined,
): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [];
  for (const param of params) {
    const text = param.description;
    // An exactly-one prose claim is satisfied by ANY declared group carrying the
    // key: "mutually exclusive" is true of an at-most-one group too, and the
    // manifest — not the sentence — decides which of the two it is.
    if (XOR_PROSE.test(text) && !isInAnyGroup(param.key, declared)) {
      issues.push(groupIssue(subject, param.key, "a mutual exclusion", "exclusiveParamGroups"));
    }
    if (AT_MOST_ONE_PROSE.test(text) && !isInGroups(param.key, declared?.atMostOne)) {
      issues.push(groupIssue(subject, param.key, "an at-most-one rule", "atMostOne"));
    }
    if (AT_LEAST_ONE_PROSE.test(text) && !isInGroups(param.key, declared?.atLeastOneOf)) {
      issues.push(groupIssue(subject, param.key, "an at-least-one rule", "atLeastOneOf"));
    }
  }
  return issues;
}

function groupIssue(
  subject: string,
  key: string,
  claim: string,
  field: string,
): ManifestLintIssue {
  return {
    subject, rule: "exclusive-param-groups", detail: key,
    message:
      `param \`${key}\` states ${claim} in prose only — declare it in \`${field}\` so discovery `
      + "can show it and the runtime can enforce it.",
  };
}

function isInGroups(key: string, groups: readonly (readonly string[])[] | undefined): boolean {
  return (groups ?? []).some((group) => group.includes(key));
}

function isInAnyGroup(key: string, declared: DeclaredParamGroups | undefined): boolean {
  return isInGroups(key, declared?.exclusiveParamGroups)
    || isInGroups(key, declared?.atMostOne)
    || isInGroups(key, declared?.atLeastOneOf);
}

// ── 10. enum-declaration ─────────────────────────────────────────

export function lintEnumDeclaration(subject: string, param: LintParam): ManifestLintIssue[] {
  const text = param.description;
  const listsValues = VALUE_LIST_PROSE.test(text) && text.includes(",");
  if (!listsValues || (param.enum && param.enum.length > 0)) return [];
  return [{
    subject, rule: "enum-declaration", detail: param.key,
    message:
      `param \`${param.key}\` lists its accepted values in prose ("one of …") with no declared \`enum\` — `
      + "an unenforced, uncompiled value list is a burnt call waiting to happen.",
  }];
}

// ── Structural readers for not-yet-existing schema fields ────────

/** The three cross-param group fields, as the rules read them. */
export interface DeclaredParamGroups {
  readonly exclusiveParamGroups?: readonly (readonly string[])[];
  readonly atMostOne?: readonly (readonly string[])[];
  readonly atLeastOneOf?: readonly (readonly string[])[];
}

/** Read all three group fields off a manifest, structurally. */
export function readDeclaredParamGroups(manifest: object): DeclaredParamGroups | undefined {
  const groups: DeclaredParamGroups = {
    ...optionalGroups("exclusiveParamGroups", readDeclaredGroups(manifest, "exclusiveParamGroups")),
    ...optionalGroups("atMostOne", readDeclaredGroups(manifest, "atMostOne")),
    ...optionalGroups("atLeastOneOf", readDeclaredGroups(manifest, "atLeastOneOf")),
  };
  return Object.keys(groups).length > 0 ? groups : undefined;
}

function optionalGroups(
  field: keyof DeclaredParamGroups,
  value: readonly (readonly string[])[] | undefined,
): DeclaredParamGroups {
  return value ? { [field]: value } : {};
}

/**
 * Read one group field off a manifest WITHOUT asserting it exists.
 *
 * Reading it structurally (validate, never cast) means a rule starts enforcing
 * the moment a field ships, and nothing here has to be revisited.
 */
export function readDeclaredGroups(
  manifest: object,
  field: string,
): readonly (readonly string[])[] | undefined {
  const raw = (manifest as Record<string, unknown>)[field];
  if (!Array.isArray(raw)) return undefined;
  const groups: string[][] = [];
  for (const group of raw) {
    if (!Array.isArray(group)) continue;
    groups.push(group.filter((key): key is string => typeof key === "string"));
  }
  return groups;
}

/** Read a declared `enum` off a param def or a JSON-schema property. */
export function readDeclaredEnum(param: object): readonly string[] | undefined {
  const raw = (param as Record<string, unknown>)["enum"];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((value): value is string => typeof value === "string");
}
