/**
 * publicName gate - the ONE owner of the model-visible name grammar.
 *
 * Production code, not a test helper, because the grammar has two consumers
 * that must never disagree: `registry/injected-protocol-tools.ts` PROJECTS
 * `manifest.publicName` into the provider `tools` array and builds its reverse
 * lookup on the promise that the name is unique catalog-wide and shaped
 * `<namespace>__<resource_action>`, and the G2 suite PROVES that promise over
 * the live catalog. A grammar owned by the test could drift from the projection
 * that depends on it.
 *
 * Three surfaces are validated, all load-bearing:
 *
 * 1. LIVE MANIFESTS - every `publicName` obeys the grammar and is unique
 *    catalog-wide. That is exactly what makes the projection's reverse map a
 *    bijection rather than a lossy guess.
 * 2. MAPPING ARTIFACTS - `tool-surface-spec/mappings/<namespace>.json`, the
 *    authored naming decision the manifests were populated from, checked
 *    against each other and against the catalog's registered ids.
 * 3. AGREEMENT - artifact `publicName` equals manifest `publicName` for every
 *    tool, in both directions. The artifacts are the reviewed decision; a
 *    manifest renamed without its artifact row (or the reverse) is a rename
 *    that escaped review, and it fails here by toolId.
 *
 * Everything here is pure and IO-free: the test module reads the files and the
 * catalog, these functions decide. That is what makes the failure modes
 * (unknown id, missing id, duplicate name, bad grammar, disagreement)
 * unit-testable in memory without touching a spec artifact.
 *
 * Grammar validated here is MECHANICAL only: charset, structure, uniqueness,
 * completeness. Verb choice is style-guide policy and deliberately NOT pinned
 * to a hardcoded verb list, so a justified extension verb does not need a code
 * change.
 */

/** One `toolId -> publicName` row as the artifacts declare it. */
export interface PublicNameEntry {
  readonly toolId: string;
  readonly publicName: string;
  readonly rationale: string;
}

/** One namespace artifact file, parsed. */
export interface PublicNameArtifact {
  /** Repo-relative path, used in every failure message. */
  readonly file: string;
  readonly namespace: string;
  readonly entries: readonly PublicNameEntry[];
}

export type PublicNameRule =
  | "artifact-schema"
  | "grammar"
  | "duplicate-public-name"
  | "duplicate-tool-id"
  | "unknown-tool-id"
  | "missing-tool-id"
  | "namespace-mismatch"
  | "artifact-manifest-mismatch";

/**
 * The context a grammar check needs: where to report the fault, and which
 * namespace the name's first half must equal.
 *
 * Structurally satisfied by {@link PublicNameArtifact} and by a live manifest
 * adapted through {@link manifestNameSource}, so ONE grammar implementation
 * serves the authored artifacts and the shipped catalog.
 */
export interface PublicNameSource {
  /** Repo-relative artifact path, or the toolId when the subject is a manifest. */
  readonly file: string;
  readonly namespace: string;
}

/** One `toolId -> publicName` pair, whatever declared it. */
export interface PublicNameBinding {
  readonly toolId: string;
  readonly publicName: string;
}

/** The minimum a live manifest must expose to be gated. */
export interface PublicNameManifest extends PublicNameBinding {
  readonly namespace: string;
}

/** Adapt a live manifest into the grammar checker's two inputs. */
export function manifestNameSource(manifest: PublicNameManifest): PublicNameSource {
  return { file: manifest.toolId, namespace: manifest.namespace };
}

export interface PublicNameIssue {
  /** The artifact file, or the toolId when the fault is catalog-wide. */
  readonly subject: string;
  readonly rule: PublicNameRule;
  readonly detail: string;
  readonly message: string;
}

/** Vex policy bound, mirroring the callable-name budget in the naming spec. */
export const MAX_PUBLIC_NAME_LENGTH = 64;

const PUBLIC_NAME_CHARSET = /^[a-z0-9_]+$/;

/**
 * Parse one artifact file's JSON.
 *
 * Strict about the three load-bearing fields, tolerant about extras: the spec
 * may add per-entry metadata (lifecycle notes, wave markers) without this gate
 * having to be revisited. `raw` is `unknown` on purpose - a malformed artifact
 * must surface as a schema issue, never as a cast that pretends the shape held.
 */
export function parsePublicNameArtifact(
  file: string,
  raw: unknown,
): { artifact?: PublicNameArtifact; issues: PublicNameIssue[] } {
  const issues: PublicNameIssue[] = [];
  const fail = (detail: string, message: string): { issues: PublicNameIssue[] } => {
    issues.push({ subject: file, rule: "artifact-schema", detail, message });
    return { issues };
  };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("root", "artifact root must be a JSON object.");
  }
  const root = raw as Record<string, unknown>;
  const namespace = root["namespace"];
  if (typeof namespace !== "string" || namespace.length === 0) {
    return fail("namespace", "artifact must declare a non-empty `namespace` string.");
  }
  const rawEntries = root["entries"];
  if (!Array.isArray(rawEntries)) {
    return fail("entries", "artifact must declare an `entries` array.");
  }

  const entries: PublicNameEntry[] = [];
  rawEntries.forEach((rawEntry, index) => {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      issues.push({
        subject: file, rule: "artifact-schema", detail: `entries[${index}]`,
        message: "entry must be a JSON object.",
      });
      return;
    }
    const entry = rawEntry as Record<string, unknown>;
    const missing = (["toolId", "publicName", "rationale"] as const).filter(
      (field) => typeof entry[field] !== "string" || (entry[field] as string).length === 0,
    );
    if (missing.length > 0) {
      issues.push({
        subject: file, rule: "artifact-schema", detail: `entries[${index}]`,
        message:
          `entry is missing non-empty string field(s) ${missing.map((f) => `\`${f}\``).join(", ")} - `
          + "every mapping row states the durable toolId, the model-visible publicName, and why.",
      });
      return;
    }
    entries.push({
      toolId: entry["toolId"] as string,
      publicName: entry["publicName"] as string,
      rationale: entry["rationale"] as string,
    });
  });

  return { artifact: { file, namespace, entries }, issues };
}

/**
 * Mechanical grammar: `<namespace>__<resource_action>`.
 *
 * Lowercase snake_case, exactly one double underscore at the namespace
 * boundary, namespace half carries no underscore, action half carries no double
 * underscore and no leading or trailing underscore.
 */
export function lintPublicNameGrammar(
  artifact: PublicNameSource,
  entry: PublicNameBinding,
): PublicNameIssue[] {
  const issues: PublicNameIssue[] = [];
  const name = entry.publicName;
  const issue = (message: string): void => {
    issues.push({ subject: artifact.file, rule: "grammar", detail: entry.toolId, message });
  };

  if (!PUBLIC_NAME_CHARSET.test(name)) {
    issue(
      `publicName \`${name}\` uses characters outside [a-z0-9_] - the callable name must survive `
      + "every consumer charset unchanged (no dots, no case, no dashes).",
    );
  }
  if (name.length > MAX_PUBLIC_NAME_LENGTH) {
    issue(`publicName \`${name}\` is ${name.length} chars (> ${MAX_PUBLIC_NAME_LENGTH}).`);
  }

  const halves = name.split("__");
  if (halves.length !== 2) {
    issue(
      `publicName \`${name}\` must contain EXACTLY ONE double underscore (found ${halves.length - 1}) - `
      + "it marks the namespace boundary and nothing else.",
    );
    return issues;
  }
  const [prefix, action] = halves as [string, string];

  if (prefix !== artifact.namespace) {
    issue(
      `publicName \`${name}\` starts with \`${prefix}\` but the artifact declares namespace `
      + `\`${artifact.namespace}\` - the half before \`__\` IS the namespace.`,
    );
  }
  if (prefix.includes("_")) {
    issue(`publicName \`${name}\` has an underscore inside its namespace half \`${prefix}\`.`);
  }
  if (action.length === 0) {
    issue(`publicName \`${name}\` has an empty resource_action half.`);
    return issues;
  }
  if (action.startsWith("_") || action.endsWith("_")) {
    issue(`publicName \`${name}\` has a leading or trailing underscore in its resource_action half.`);
  }
  return issues;
}

/** Catalog-wide uniqueness of publicName and of toolId across all artifacts. */
export function lintPublicNameUniqueness(
  artifacts: readonly PublicNameArtifact[],
): PublicNameIssue[] {
  const issues: PublicNameIssue[] = [];
  const nameOwner = new Map<string, string>();
  const idOwner = new Map<string, string>();

  for (const artifact of artifacts) {
    for (const entry of artifact.entries) {
      const priorName = nameOwner.get(entry.publicName);
      if (priorName !== undefined) {
        issues.push({
          subject: artifact.file, rule: "duplicate-public-name", detail: entry.publicName,
          message:
            `publicName \`${entry.publicName}\` is already claimed by \`${priorName}\` - a callable name `
            + "must resolve to exactly one tool across the whole catalog.",
        });
      } else {
        nameOwner.set(entry.publicName, `${entry.toolId} (${artifact.file})`);
      }

      const priorId = idOwner.get(entry.toolId);
      if (priorId !== undefined) {
        issues.push({
          subject: artifact.file, rule: "duplicate-tool-id", detail: entry.toolId,
          message: `toolId \`${entry.toolId}\` is mapped twice - also in ${priorId}.`,
        });
      } else {
        idOwner.set(entry.toolId, artifact.file);
      }
    }
  }
  return issues;
}

/**
 * Exact completeness against the live catalog: every registered toolId is
 * mapped exactly once, and no artifact row names a toolId the catalog does not
 * register. `liveNamespaceById` is the catalog's own registration, so the
 * namespace check cannot drift from it.
 */
export function lintPublicNameCompleteness(
  artifacts: readonly PublicNameArtifact[],
  liveNamespaceById: ReadonlyMap<string, string>,
): PublicNameIssue[] {
  const issues: PublicNameIssue[] = [];
  const mapped = new Set<string>();

  for (const artifact of artifacts) {
    for (const entry of artifact.entries) {
      const liveNamespace = liveNamespaceById.get(entry.toolId);
      if (liveNamespace === undefined) {
        issues.push({
          subject: artifact.file, rule: "unknown-tool-id", detail: entry.toolId,
          message:
            `toolId \`${entry.toolId}\` is not registered in the protocol catalog - delete the row, or `
            + "fix the id it was meant to name.",
        });
        continue;
      }
      mapped.add(entry.toolId);
      if (liveNamespace !== artifact.namespace) {
        issues.push({
          subject: artifact.file, rule: "namespace-mismatch", detail: entry.toolId,
          message:
            `toolId \`${entry.toolId}\` is registered under namespace \`${liveNamespace}\` but is mapped in `
            + `the \`${artifact.namespace}\` artifact - move the row to \`${liveNamespace}.json\`.`,
        });
      }
    }
  }

  for (const [toolId, namespace] of liveNamespaceById) {
    if (mapped.has(toolId)) continue;
    issues.push({
      subject: toolId, rule: "missing-tool-id", detail: toolId,
      message:
        `registered tool \`${toolId}\` has no publicName mapping - add a row to `
        + `src/vex-agent/tools/tool-surface-spec/mappings/${namespace}.json with its publicName and rationale.`,
    });
  }
  return issues;
}

/** Run every artifact-level rule. Parsing issues short-circuit the rest. */
export function lintPublicNameArtifacts(
  artifacts: readonly PublicNameArtifact[],
  liveNamespaceById: ReadonlyMap<string, string>,
): PublicNameIssue[] {
  const grammar = artifacts.flatMap((artifact) =>
    artifact.entries.flatMap((entry) => lintPublicNameGrammar(artifact, entry)),
  );
  return [
    ...grammar,
    ...lintPublicNameUniqueness(artifacts),
    ...lintPublicNameCompleteness(artifacts, liveNamespaceById),
  ];
}

/**
 * Grammar plus catalog-wide uniqueness over the LIVE manifests.
 *
 * This is the check the projection actually depends on: `toInjectedToolName` /
 * `fromInjectedToolName` are a bijection only while every shipped `publicName`
 * is well-formed and claimed by exactly one tool. A duplicate here would make
 * the reverse map silently resolve a fund-moving call onto the wrong manifest,
 * so it fails naming BOTH owners rather than reporting a count.
 */
export function lintManifestPublicNames(
  manifests: readonly PublicNameManifest[],
): PublicNameIssue[] {
  const issues: PublicNameIssue[] = [];
  const owner = new Map<string, string>();

  for (const manifest of manifests) {
    issues.push(...lintPublicNameGrammar(manifestNameSource(manifest), manifest));

    const prior = owner.get(manifest.publicName);
    if (prior !== undefined) {
      issues.push({
        subject: manifest.toolId, rule: "duplicate-public-name", detail: manifest.publicName,
        message:
          `manifest publicName \`${manifest.publicName}\` is already claimed by \`${prior}\` - the `
          + "injected-name reverse map resolves a callable name to exactly one manifest, so a "
          + "duplicate would route a call onto the wrong tool.",
      });
    } else {
      owner.set(manifest.publicName, manifest.toolId);
    }
  }
  return issues;
}

/**
 * The artifacts and the manifests state the SAME name for every tool.
 *
 * Exact in both directions, keyed on the immutable toolId: an artifact row with
 * no live manifest and a live manifest with no artifact row are already caught
 * by {@link lintPublicNameCompleteness}, so what this adds is the disagreement
 * case - the same tool named two different things by the reviewed decision and
 * by the shipped code.
 */
export function lintArtifactManifestAgreement(
  artifacts: readonly PublicNameArtifact[],
  manifestPublicNameById: ReadonlyMap<string, string>,
): PublicNameIssue[] {
  const issues: PublicNameIssue[] = [];

  for (const artifact of artifacts) {
    for (const entry of artifact.entries) {
      const live = manifestPublicNameById.get(entry.toolId);
      if (live === undefined) continue;
      if (live === entry.publicName) continue;
      issues.push({
        subject: artifact.file, rule: "artifact-manifest-mismatch", detail: entry.toolId,
        message:
          `\`${entry.toolId}\` is named \`${entry.publicName}\` by the mapping artifact but `
          + `\`${live}\` by its live manifest - a rename edits BOTH in the same change, because the `
          + "artifact is the reviewed naming decision and the manifest is what the model sees.",
      });
    }
  }
  return issues;
}

export function formatPublicNameIssues(issues: readonly PublicNameIssue[]): string {
  return issues.map((i) => `  - ${i.subject} [${i.rule}/${i.detail}] ${i.message}`).join("\n");
}
