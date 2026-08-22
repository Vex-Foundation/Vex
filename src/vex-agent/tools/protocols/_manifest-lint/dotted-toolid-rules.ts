/**
 * `dotted-toolid-reference` - no model-visible manifest string may tell the
 * model to call a DOTTED tool id.
 *
 * THE DEFECT THIS CLOSES. A tool has two names and only one of them is
 * callable. `manifest.toolId` (`morpho.market.get`) is the INTERNAL and durable
 * identity: it keys the catalog, the mutation matrix, the approval
 * fingerprints, the allowlist subjects, `agent_activity` rows and telemetry.
 * `manifest.publicName` (`morpho__market_get`) is what
 * `registry/injected-protocol-tools.ts` projects into the provider `tools`
 * array, so it is the ONLY name the model can actually call. Batch 2 introduced
 * the split; the prose did not follow. A description that says "call
 * `morpho.market.get` first" spends a real turn on a name the runtime answers
 * with an unknown-tool refusal, and the model has no way to discover the
 * correction except by failing.
 *
 * WHAT FIRES. Any `<live namespace>.<segment>[.<segment>]` shape found in a
 * scanned PROSE FIELD, where the namespace is one the live catalog actually
 * registers. Deliberately SHAPE-based rather than
 * exact-id-based: a dotted shape that resolves to no live tool is the worse
 * defect, not the safer one, because it names something retired or invented and
 * cannot be fixed by lookup. Those fail with a message that says so instead of
 * proposing a substitution nobody verified.
 *
 * WHAT DOES NOT FIRE, and why it is decided here rather than in the allowlist:
 *
 *  - A token preceded by `.` or a word character is part of a longer dotted
 *    chain, which in practice means a hostname (`app.pendle.finance`). The
 *    lookbehind drops it before any exclusion list is consulted.
 *  - `NON_TOOL_TOKENS` - spellings that are a BRAND or a domain rather than a
 *    tool id, and that legitimately appear in prose describing the venue. These
 *    are not toolId shapes at all, so excusing them as debt would misfile them;
 *    an entry here is a statement about English, not an accepted violation.
 *
 * TWO INPUTS, NEVER ONE. The live catalog (`DottedToolIdentity[]`) supplies the
 * namespace alternation and the `toolId -> publicName` resolution. The scanned
 * text arrives separately as `DottedReferenceSubject[]`, each carrying its own
 * named fields. Keeping them apart is what lets a NAMESPACE NAVIGATION record be
 * scanned without inventing a `toolId`/`publicName` pair for it: navigation prose
 * is model-visible (the protocols prompt layer renders it) but a namespace is not
 * a tool and must never be admitted to the catalog as one.
 *
 * OUT OF SCOPE, stated so the gap is not mistaken for coverage: handler-authored
 * runtime strings (refusals, nextStep, notes) are also model-visible but are not
 * reachable from the catalog, and the source tree they live in is dense with
 * CORRECT dotted usage - telemetry event names, `agent_activity` values,
 * `mutation-matrix.ts` keys and architectural comments that name the durable
 * identity. A source-text rule over that tree could not separate the two without
 * an allowlist longer than the defect, so this rule pins the surface the model
 * reads from the tool definition, and the handler strings were swept by hand.
 *
 * NO ALLOWLIST ENTRIES. Like `stale-output-cap-claim`, this lands at ZERO and
 * the suite asserts no allowlist row for the rule exists, so a future dotted
 * reference cannot be admitted as debt.
 */

import type { ProtocolNamespaceNavigation } from "../navigation/types.js";
import type { ManifestLintIssue } from "./rules.js";

/**
 * A live tool's two names. This input builds the namespace alternation and
 * resolves a flagged token to its callable replacement. It is IDENTITY only:
 * nothing here is scanned.
 */
export interface DottedToolIdentity {
  readonly toolId: string;
  readonly publicName: string;
}

/** One named prose field of a subject, scanned verbatim. */
export interface DottedProseField {
  readonly field: string;
  readonly text: string;
}

/**
 * A model-visible prose surface. `subject` is the reporting key only (a toolId
 * for a manifest, a namespace for a navigation record), so a subject NEED NOT be
 * a tool and is never resolved as one.
 */
export interface DottedReferenceSubject {
  readonly subject: string;
  readonly fields: readonly DottedProseField[];
}

/** The manifest surface this rule reads, projected off the live catalog. */
export interface DottedToolProse extends DottedToolIdentity {
  readonly description: string;
  readonly params: readonly { readonly key: string; readonly description: string }[];
}

/** Project a manifest onto its scanned fields. Field names match the surface. */
export function toolProseSubject(tool: DottedToolProse): DottedReferenceSubject {
  return {
    subject: tool.toolId,
    fields: [
      { field: "description", text: tool.description },
      ...tool.params.map((param) => ({ field: `param:${param.key}`, text: param.description })),
    ],
  };
}

/**
 * Project a namespace navigation record onto its scanned fields.
 *
 * SCANNED, because `engine/prompts/protocols.ts` renders each of these verbatim
 * into the protocols layer the model reads every turn:
 *  - `summary` (:135), `whenToUse` (:136), `preferInstead` (:138);
 *  - `facets[].label` and `facets[].summary` (:155);
 *  - `exampleQueries` (:158, the `Try:` line).
 *
 * NOT SCANNED, each for a stated reason rather than by omission:
 *  - `toolPrefixes` is durable dotted IDENTITY, matched against `toolId` by
 *    `descriptions.ts` and `metadata-compile.ts`. Dotted is correct there and
 *    flagging it would invert the rule.
 *  - `facets[].hints` and `aliases` are retrieval-only: they compile into
 *    `discovery.exampleIntents` / `discovery.aliases` (`metadata-compile.ts`
 *    :62-68) which feed `lexical-score.ts` and the embedding text. The model
 *    never reads them, and D9 freezes them.
 *  - `discoveryHints` has no consumer in the tree at all (only the navigation
 *    entries and one test set it), so it reaches neither the model nor
 *    retrieval.
 *  - `namespace`, `groupId`, `groupLabel`, `advertised` are identifiers and a
 *    flag, not prose.
 */
export function navigationProseSubject(
  navigation: ProtocolNamespaceNavigation,
): DottedReferenceSubject {
  const fields: DottedProseField[] = [
    { field: "summary", text: navigation.summary },
    { field: "whenToUse", text: navigation.whenToUse },
  ];
  if (navigation.preferInstead !== undefined) {
    fields.push({ field: "preferInstead", text: navigation.preferInstead });
  }
  navigation.exampleQueries.forEach((query, index) => {
    fields.push({ field: `exampleQueries[${index}]`, text: query });
  });
  navigation.facets.forEach((facet, index) => {
    fields.push({ field: `facets[${index}].label`, text: facet.label });
    fields.push({ field: `facets[${index}].summary`, text: facet.summary });
  });
  return { subject: navigation.namespace, fields };
}

/**
 * Dotted spellings that name a brand or a hostname, not a tool.
 *
 * `pools.fun` is the launchpad itself: the `pools` tools read and write on
 * pools.fun, and every description that names the venue spells it this way.
 * `dexscreener.com` is the same case one namespace over. Both are listed in
 * full so that a NEW brand-shaped token still fails and gets a human decision
 * rather than being absorbed by a `.com`-style heuristic.
 */
const NON_TOOL_TOKENS: ReadonlySet<string> = new Set(["pools.fun", "dexscreener.com"]);

/**
 * A toolId segment is `[a-z][A-Za-z0-9_]*` across all 134 live ids (camelCase
 * `supplyCollateral`, snake `launch_execute`), so requiring a lowercase first
 * character is free precision: it keeps the rule off ordinary prose where a
 * sentence-final `pools.` meets a capitalised next word.
 */
const SEGMENT = "[a-z][A-Za-z0-9_]*";

function buildTokenPattern(namespaces: readonly string[]): RegExp {
  const alternation = namespaces.map(escapeForPattern).sort((a, b) => b.length - a.length).join("|");
  // The lookbehind rejects a token that continues a longer dotted chain; the
  // lookahead stops a partial match ending mid-segment.
  return new RegExp(`(?<![.\\w-])(?:${alternation})(?:\\.${SEGMENT})+(?![\\w])`, "g");
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The COMPLETE field, whitespace collapsed to one space so a multi-line
 * description reads as one diagnostic line. Nothing is cut: a diagnostic that
 * hides part of the string it is complaining about makes the reader open the
 * file to learn what the rule already knew.
 */
function normalizeField(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a dotted token to the live tool it names, tolerating a trailing
 * non-id suffix (`morpho.markets.discover.loanAssetTags` is a real tool plus a
 * param key). Returns the longest live id that prefixes the token.
 */
function resolveLiveTool(
  token: string,
  names: ReadonlyMap<string, string>,
): { readonly toolId: string; readonly publicName: string; readonly suffix: string } | undefined {
  const segments = token.split(".");
  for (let take = segments.length; take >= 2; take -= 1) {
    const candidate = segments.slice(0, take).join(".");
    const publicName = names.get(candidate);
    if (publicName !== undefined) {
      return { toolId: candidate, publicName, suffix: segments.slice(take).join(".") };
    }
  }
  return undefined;
}

export function lintDottedToolIdReferences(
  catalog: readonly DottedToolIdentity[],
  subjects: readonly DottedReferenceSubject[],
): ManifestLintIssue[] {
  const names = new Map(catalog.map((tool) => [tool.toolId, tool.publicName]));
  const namespaces = [...new Set(catalog.map((tool) => tool.toolId.split(".")[0] ?? ""))]
    .filter((namespace) => namespace.length > 0);
  if (namespaces.length === 0) return [];
  const pattern = buildTokenPattern(namespaces);

  const issues: ManifestLintIssue[] = [];
  for (const subject of subjects) {
    for (const { field, text } of subject.fields) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        const token = match[0];
        if (NON_TOOL_TOKENS.has(token)) continue;
        const resolved = resolveLiveTool(token, names);
        const where = `${field} says: ${normalizeField(text)}`;
        issues.push({
          subject: subject.subject,
          rule: "dotted-toolid-reference",
          // field + token, so the key survives an unrelated edit to the
          // sentence around it and still points at one deletable thing.
          detail: `${field}/${token}`,
          message: resolved === undefined
            ? `model-visible ${field} names \`${token}\`, which is not a live tool id at all: `
              + "it is retired, renamed or invented. Name the surviving tool by its `publicName` "
              + `(plus the parameter that replaced it, if it was merged away). ${where}`
            : `model-visible ${field} tells the model to call \`${token}\`, a dotted tool id. `
              + `Only \`publicName\` is callable: write \`${resolved.publicName}\``
              + `${resolved.suffix ? ` (\`${resolved.suffix}\` is not part of the name, express it as that tool's parameter)` : ""}`
              + `. The dotted id stays the internal and audit identity and must not appear in prose `
              + `the model reads. ${where}`,
        });
      }
    }
  }
  return issues;
}
