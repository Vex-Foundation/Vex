/**
 * publicName gate - pure checkers for the Batch 1 mapping artifacts.
 *
 * The artifacts under `src/vex-agent/tools/tool-surface-spec/mappings/*.json`
 * are the authoritative `toolId -> publicName` map produced by the naming spec.
 * `publicName` does not exist on live manifests yet (it lands in Batch 2), so
 * this gate validates the ARTIFACTS against each other and against the live
 * protocol catalog. When Batch 2 adds a tool, its missing mapping row fails
 * here with the toolId and the artifact file to edit.
 *
 * Everything here is pure and IO-free: the test module reads the files and the
 * catalog, these functions decide. That is what makes the failure modes
 * (unknown id, missing id, duplicate name, bad grammar) unit-testable in memory
 * without touching a spec artifact.
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
  | "namespace-mismatch";

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
  artifact: PublicNameArtifact,
  entry: PublicNameEntry,
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

export function formatPublicNameIssues(issues: readonly PublicNameIssue[]): string {
  return issues.map((i) => `  - ${i.subject} [${i.rule}/${i.detail}] ${i.message}`).join("\n");
}
