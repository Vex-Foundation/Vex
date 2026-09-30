import {
  PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST,
  PROTOCOL_TOOLS,
  isProtocolToolAvailable,
} from "@vex-agent/tools/protocols/catalog.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";
import { getToolDef } from "@vex-agent/tools/registry/lookup.js";
import type { ProtocolNamespace, ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import { getProtocolNamespaceCoverage } from "./chain-coverage.js";
import { buildTaskShapesPrompt } from "./task-shapes.js";

interface NamespaceAvailability {
  readonly availableCount: number;
  readonly hasMutating: boolean;
  readonly requiredEnvironmentNames: readonly string[];
}

/**
 * Kairos P-5 switch: the `# Protocols` layer as a compact index.
 *
 * ON (the default) renders each namespace as its identity, its Act line, its
 * characteristics and limits, its coverage and its availability, which carry
 * every money-path, approval, chain and identity rule the layer states. The
 * Read, Quote and When-it-applies lines are capability catalogue: the tools
 * ToolSearch returns describe the same reads and quotes in full, so the
 * index keeps only the sentences in `LEAN_KEPT_SENTENCES`, verbatim. The task
 * shapes drop their Trigger lines, which restate the shape heading.
 *
 * OFF restores the full declaration render byte for byte; the prompt tests
 * prove it against `__promptsnaps__/protocols-legacy.*.md`.
 */
export const PROTOCOLS_PROMPT_LEAN = true;

type LeanDeclarationField = "read" | "quote" | "whenItApplies";

/**
 * Sentences of the catalogue fields the lean index still renders, verbatim.
 * "all" keeps the whole field. Each entry is a rule (approval scope, token
 * identity, "not an executable price", settings the agent cannot change) or a
 * sentence an existing prompt test pins. A kept sentence that no longer
 * appears in its declaration fails the render loudly, so the index can never
 * drift from the declaration it abbreviates.
 */
const LEAN_KEPT_SENTENCES: Partial<Record<
  ProtocolNamespace,
  Partial<Record<LeanDeclarationField, readonly string[] | "all">>
>> = {
  uniswap: {
    read: ["Resolve exact token addresses first; no symbol search."],
  },
  morpho: {
    quote: ["A quote signs nothing and authorizes only the same direction."],
  },
  solana: {
    read: "all",
    quote: [
      "Lending and prediction actions have no separate generic quote surface, so read their market and position state before acting.",
    ],
  },
  pendle: {
    quote: ["Some actions quote internally through a dry run before broadcast."],
  },
  dexscreener: {
    read: [
      "Resolve a name or ticker symbol to an exact chain and contract address, screen the population server-side, list one token's pools, read a pool address live, refresh known addresses, aggregate narratives per chain, read paid boosts, and list the chain and dex catalog.",
    ],
    quote: "all",
  },
  lighter: {
    read: "all",
    quote: [
      "Preview exact Lighter orders from live market and account data before any approval; a Lighter order preview reviews exact terms.",
    ],
    whenItApplies: "all",
  },
  virtuals: {
    quote: ["Research alone still establishes no executable price."],
  },
  pools: {
    read: "all",
    quote: [
      "The preview is advisory and cannot predict the final token address.",
      "This namespace has no trading quote; acquiring a token requires a separate trading quote on a swap venue.",
    ],
  },
};

const LEAN_FIELD_LABELS: Readonly<Record<LeanDeclarationField, string>> = {
  read: "Read",
  quote: "Quote",
  whenItApplies: "When it applies",
};

let cached: {
  readonly fingerprint: string;
  readonly lean: boolean;
  readonly text: string;
} | null = null;

function advertisedTools(): readonly ProtocolToolManifest[] {
  return PROTOCOL_TOOLS.filter((tool) =>
    PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(tool.namespace),
  );
}

function namespaceAvailability(namespace: ProtocolNamespace): NamespaceAvailability {
  const tools = advertisedTools().filter((tool) => tool.namespace === namespace);
  // Several core envelope tests replace the catalog with an empty structural
  // stub. Do not touch the mocked availability export when no tools exist.
  const available = tools.length === 0 ? [] : tools.filter(isProtocolToolAvailable);
  const requiredEnvironmentNames = [...new Set(
    tools.flatMap((tool) => tool.requiresEnv ? [tool.requiresEnv] : []),
  )].sort();
  return {
    availableCount: available.length,
    hasMutating: available.some((tool) => tool.mutating),
    requiredEnvironmentNames,
  };
}

function requiredEnvironmentNames(): readonly string[] {
  const names = new Set<string>();
  for (const tool of advertisedTools()) {
    if (tool.lifecycle === "active" && tool.requiresEnv) names.add(tool.requiresEnv);
  }
  const webResearchEnv = getToolDef("WebResearch")?.requiresEnv;
  if (webResearchEnv) names.add(webResearchEnv);
  return [...names].sort();
}

export function protocolAvailabilityFingerprint(): string {
  return requiredEnvironmentNames()
    .filter((name) => Boolean(process.env[name]?.trim()))
    .join(",");
}

function leanKeptLine(
  namespace: ProtocolNamespace,
  field: LeanDeclarationField,
  prose: string,
): string[] {
  const kept = LEAN_KEPT_SENTENCES[namespace]?.[field];
  if (kept === undefined) return [];
  if (kept === "all") return [`${LEAN_FIELD_LABELS[field]}: ${prose}`];
  for (const sentence of kept) {
    if (!prose.includes(sentence)) {
      throw new Error(
        `Lean protocols index for "${namespace}" keeps a ${field} sentence its declaration no longer states: ${sentence}`,
      );
    }
  }
  return [`${LEAN_FIELD_LABELS[field]}: ${kept.join(" ")}`];
}

function renderDeclaration(namespace: ProtocolNamespace, lean: boolean): string[] {
  const navigation = getAdvertisedProtocolNavigation().find((entry) => entry.namespace === namespace);
  if (!navigation) return [];

  const availability = namespaceAvailability(namespace);
  const declaration = navigation.declaration;
  const coverage = getProtocolNamespaceCoverage(namespace);
  const coverageLine = coverage?.line ?? declaration.coverageNote;
  if (!coverageLine) {
    throw new Error(`Protocol declaration "${namespace}" has neither runtime coverage nor coverageNote.`);
  }

  // Capability AREAS, for the one namespace that opts in (D-DS9-R). They say
  // what kinds of question this namespace answers so the model can aim a
  // ToolSearch query at the right area; they are never callable names, because
  // a protocol tool is callable only after discovery records it.
  const facetLines = declaration.advertiseFacetsInPrompt === true
    ? [
        `Capability areas: ${declaration.facets.join("; ")}. `
        + "Name the area you need in a ToolSearch query on this namespace; the tools it returns "
        + "become callable by name.",
      ]
    : [];

  const lines = lean
    ? [
        `### ${namespace}`,
        declaration.identity,
        ...facetLines,
        ...leanKeptLine(namespace, "read", declaration.read),
        ...leanKeptLine(namespace, "quote", declaration.quote),
        `Act: ${declaration.act}`,
        ...leanKeptLine(namespace, "whenItApplies", declaration.whenItApplies),
        `Characteristics and limits: ${declaration.characteristicAndLimits}`,
        coverageLine,
      ]
    : [
        `### ${namespace}`,
        declaration.identity,
        ...facetLines,
        `Read: ${declaration.read}`,
        `Quote: ${declaration.quote}`,
        `Act: ${declaration.act}`,
        `When it applies: ${declaration.whenItApplies}`,
        `Characteristics and limits: ${declaration.characteristicAndLimits}`,
        coverageLine,
      ];

  if (availability.availableCount === 0 && availability.requiredEnvironmentNames.length > 0) {
    lines.push(
      `Availability: This namespace is not available in this install until ${availability.requiredEnvironmentNames.join(" and ")} is configured.`,
    );
  } else if (availability.hasMutating) {
    lines.push("Contains mutating tools (may require approval).");
  }
  return lines;
}

/**
 * Renders the layer with the lean index ON or OFF, uncached. Production reads
 * `buildProtocolsPrompt`, which uses `PROTOCOLS_PROMPT_LEAN`; this exists so
 * the OFF render can be proved identical to the pre-P-5 layer.
 */
export function renderProtocolsPrompt(lean: boolean): string {
  const lines = [
    "# Protocols",
    "",
    "## What Vex can reach",
    "",
    "Search a namespace with ToolSearch; a namespace itself is never called by name.",
    "",
  ];

  for (const navigation of getAdvertisedProtocolNavigation()) {
    lines.push(...renderDeclaration(navigation.namespace, lean), "");
  }

  const webResearchEnvironment = getToolDef("WebResearch")?.requiresEnv;
  lines.push(buildTaskShapesPrompt({
    webResearch: webResearchEnvironment
      ? Boolean(process.env[webResearchEnvironment]?.trim())
      : true,
    solana: namespaceAvailability("solana").availableCount > 0,
  }, { lean }));

  return lines.join("\n");
}

export function buildProtocolsPrompt(): string {
  const fingerprint = protocolAvailabilityFingerprint();
  const lean = PROTOCOLS_PROMPT_LEAN;
  if (cached?.fingerprint === fingerprint && cached.lean === lean) return cached.text;
  cached = { fingerprint, lean, text: renderProtocolsPrompt(lean) };
  return cached.text;
}

export function resetProtocolsPromptCache(): void {
  cached = null;
}
