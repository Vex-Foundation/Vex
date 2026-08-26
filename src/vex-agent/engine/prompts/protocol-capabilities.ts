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

let cached: { readonly fingerprint: string; readonly text: string } | null = null;

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

function renderDeclaration(namespace: ProtocolNamespace): string[] {
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

  const lines = [
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

export function buildProtocolsPrompt(): string {
  const fingerprint = protocolAvailabilityFingerprint();
  if (cached?.fingerprint === fingerprint) return cached.text;

  const lines = [
    "# Protocols",
    "",
    "## What Vex can reach",
    "",
    "Search a namespace with ToolSearch; a namespace itself is never called by name.",
    "",
  ];

  for (const navigation of getAdvertisedProtocolNavigation()) {
    lines.push(...renderDeclaration(navigation.namespace), "");
  }

  const webResearchEnvironment = getToolDef("WebResearch")?.requiresEnv;
  lines.push(buildTaskShapesPrompt({
    webResearch: webResearchEnvironment
      ? Boolean(process.env[webResearchEnvironment]?.trim())
      : true,
    solana: namespaceAvailability("solana").availableCount > 0,
  }));

  cached = { fingerprint, text: lines.join("\n") };
  return cached.text;
}

export function resetProtocolsPromptCache(): void {
  cached = null;
}
