/**
 * Manifest convention linter — freezes the param/description convention.
 *
 * Same shape as `_embedding-lint.ts`: pure functions, no IO, driven by
 * `__tests__/vex-agent/tools/protocols/manifest-lint.test.ts`, which iterates
 * `PROTOCOL_TOOLS` (and, in a second suite, the action-alias + wallet JSON
 * schemas so the alias lane cannot drift away from the protocol lane again).
 *
 * The convention itself lives in `conventions.ts`; this module only measures
 * distance from it. Twelve rules, each with a stable id so a violation can be
 * pointed at, allowlisted, and later deleted:
 *
 *   param-key               every key is canonical; a banned key names its replacement
 *   amount-bps-shape        amount ⇒ string + In/Out/Raw suffix; *Bps ⇒ number + unit "bps"
 *   param-description       ≥25 chars, unit anchor, and a decimals source on raw amounts
 *   tool-description        ≥120 chars, when-to-use + returns anchors, spends on mutating
 *   example-params-required every required key appears in exampleParams
 *   generic-error-literal   no "unexpected error"-class literal in handler/manifest source
 *   slippage-default-home   only slippage-policy.ts declares a slippage default
 *   chain-doc-parity        every chain-valued param carries the canonical sentence
 *   exclusive-param-groups  a prose XOR / "at most one of" / "at least one of" is
 *                           backed by a declared exclusiveParamGroups | atMostOne | atLeastOneOf
 *   enum-declaration        a prose "one of X, Y, Z" is backed by a declared enum
 *   enum-case-uniqueness    no two enum members differ only by case (the later one is
 *                           unreachable under case-insensitive normalization)
 *   param-alias             a declared retired input spelling is banned, unique across the
 *                           tool, and names its removal condition
 *
 * TODAY'S VIOLATIONS ARE ALLOWLISTED, not fixed (see `_manifest-lint/allowlist.ts`).
 * The suite is green on the current tree; every migration wave DELETES the
 * entries it fixes. The allowlist's size is the fleet's convention debt, and it
 * is only allowed to shrink.
 *
 * The group and enum rules read their manifest fields STRUCTURALLY, so a field
 * added later (as `atMostOne`/`atLeastOneOf` were) starts being enforced the
 * moment it ships, with nothing here to revisit.
 */

import type { ProtocolToolManifest } from "./types.js";
import type { LintParam, ManifestLintIssue } from "./_manifest-lint/rules.js";
import {
  lintParamKey,
  lintAmountBpsShape,
  lintParamDescription,
  lintChainDocParity,
  lintEnumDeclaration,
  lintEnumCaseUniqueness,
  lintExclusiveParamGroups,
  lintParamAliases,
  lintToolDescription,
  lintExampleParamsRequired,
  readDeclaredEnum,
  readDeclaredParamGroups,
} from "./_manifest-lint/rules.js";
import type { DeclaredParamGroups } from "./_manifest-lint/rules.js";
import { MANIFEST_LINT_ALLOWLIST, allowlistKey } from "./_manifest-lint/allowlist.js";

export type { ManifestLintIssue, ManifestLintRule, LintParam } from "./_manifest-lint/rules.js";
export { MANIFEST_LINT_ALLOWLIST, allowlistKey } from "./_manifest-lint/allowlist.js";
export type { ManifestLintAllowlistEntry } from "./_manifest-lint/allowlist.js";
export {
  isLinterOwnSource,
  lintGenericErrorLiterals,
  lintSlippageDefaultHome,
  lintStaleOutputCapClaims,
  SLIPPAGE_DEFAULT_OWNER,
} from "./_manifest-lint/source-rules.js";
export type { SourceFile } from "./_manifest-lint/source-rules.js";
export { lintDottedToolIdReferences } from "./_manifest-lint/dotted-toolid-rules.js";
export type { DottedReferenceSubject } from "./_manifest-lint/dotted-toolid-rules.js";

/** A tool surface reduced to what the convention rules actually read. */
export interface LintSubject {
  readonly subject: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly params: readonly LintParam[];
  /** Present for protocol manifests; the JSON-schema lane declares no example. */
  readonly exampleParams?: Record<string, unknown>;
  /** Declared cross-param group rules (exactly-one / at-most-one / at-least-one). */
  readonly paramGroups?: DeclaredParamGroups;
}

/** JSON-schema-shaped tool (`ToolDef`) as the linter reads it. */
export interface SchemaLintInput {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly parameters: unknown;
}

/** Project a protocol manifest onto the shared lint subject. */
export function toLintSubject(manifest: ProtocolToolManifest): LintSubject {
  const groups = readDeclaredParamGroups(manifest);
  return {
    subject: manifest.toolId,
    description: manifest.description,
    mutating: manifest.mutating,
    exampleParams: manifest.exampleParams,
    ...(groups ? { paramGroups: groups } : {}),
    params: manifest.params.map((param) => {
      const declaredEnum = readDeclaredEnum(param);
      return {
        key: param.key,
        type: param.type,
        description: param.description,
        required: param.required === true,
        ...(param.unit ? { unit: param.unit } : {}),
        ...(declaredEnum ? { enum: declaredEnum } : {}),
        ...(param.aliases ? { aliases: param.aliases } : {}),
      };
    }),
  };
}

/**
 * Project a `ToolDef`-style JSON schema onto the shared lint subject.
 *
 * The schema arrives as `unknown` on purpose: it is a hand-written object
 * literal in the registry, and a malformed one must surface as "no params
 * read", never as a cast that pretends the shape held.
 */
export function toSchemaLintSubject(tool: SchemaLintInput): LintSubject {
  return {
    subject: tool.name,
    description: tool.description,
    mutating: tool.mutating,
    params: readSchemaParams(tool.parameters),
  };
}

function readSchemaParams(parameters: unknown): LintParam[] {
  if (typeof parameters !== "object" || parameters === null) return [];
  const properties = (parameters as Record<string, unknown>)["properties"];
  const requiredRaw = (parameters as Record<string, unknown>)["required"];
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((k): k is string => typeof k === "string") : [],
  );
  if (typeof properties !== "object" || properties === null) return [];

  const params: LintParam[] = [];
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const prop = raw as Record<string, unknown>;
    const type = prop["type"];
    const description = prop["description"];
    const declaredEnum = readDeclaredEnum(prop);
    params.push({
      key,
      type: typeof type === "string" ? type : "unknown",
      description: typeof description === "string" ? description : "",
      required: required.has(key),
      ...(declaredEnum ? { enum: declaredEnum } : {}),
    });
  }
  return params;
}

/**
 * Run every per-tool rule. `exampleParams` and the XOR-group rule are skipped
 * for a subject that structurally cannot carry them (the JSON-schema lane has
 * no example and no group field of its own).
 */
export function lintToolSubject(subject: LintSubject): ManifestLintIssue[] {
  const issues: ManifestLintIssue[] = [
    ...lintToolDescription(subject.subject, subject.description, subject.mutating),
    // Tool-level, not per-param: alias uniqueness is a fact about the whole call.
    ...lintParamAliases(subject.subject, subject.params),
  ];
  for (const param of subject.params) {
    issues.push(
      ...lintParamKey(subject.subject, param),
      ...lintAmountBpsShape(subject.subject, param),
      ...lintParamDescription(subject.subject, param),
      ...lintChainDocParity(subject.subject, param),
      ...lintEnumDeclaration(subject.subject, param),
      ...lintEnumCaseUniqueness(subject.subject, param),
    );
  }
  if (subject.exampleParams) {
    issues.push(
      ...lintExampleParamsRequired(subject.subject, subject.params, subject.exampleParams),
      ...lintExclusiveParamGroups(subject.subject, subject.params, subject.paramGroups),
    );
  }
  return issues;
}

/** Drop the issues this tree has explicitly accepted as known debt. */
export function withoutAllowlisted(issues: readonly ManifestLintIssue[]): ManifestLintIssue[] {
  const allowed = new Set(MANIFEST_LINT_ALLOWLIST.map(allowlistKey));
  return issues.filter((issue) => !allowed.has(allowlistKey(issue)));
}

/** Allowlist entries no longer matched by any live violation — delete them. */
export function staleAllowlistKeys(issues: readonly ManifestLintIssue[]): string[] {
  const live = new Set(issues.map(allowlistKey));
  return MANIFEST_LINT_ALLOWLIST.map(allowlistKey).filter((key) => !live.has(key));
}
