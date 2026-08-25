import {
  PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST,
  PROTOCOL_TOOLS,
  isProtocolToolAvailable,
} from "@vex-agent/tools/protocols/catalog.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";
import { isAlwaysInjectedNamespace } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { getToolDef } from "@vex-agent/tools/registry/lookup.js";
import type { ProtocolNamespace, ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import { getProtocolNamespaceCoverage } from "./chain-coverage.js";
import { buildTaskShapesPrompt } from "./task-shapes.js";

interface NamespaceAvailability {
  readonly availableCount: number;
  readonly hasMutating: boolean;
  /** Env names gating this namespace's UNAVAILABLE mutating tools (partial gating). */
  readonly gatedMutatingEnvironmentNames: readonly string[];
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
    // A PARTIALLY gated namespace (indexify: keyless discovery reads beside
    // env-gated trading) renders neither the Availability line (reads exist)
    // nor the mutation marker (the mutating tools are hidden) unless the env
    // names gating its unavailable MUTATING tools are carried separately.
    gatedMutatingEnvironmentNames: [...new Set(
      tools
        .filter((tool) => tool.mutating && !isProtocolToolAvailable(tool))
        .flatMap((tool) => tool.requiresEnv ? [tool.requiresEnv] : []),
    )].sort(),
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

  // D-DS9: an always-injected namespace already has every tool in the
  // session's tools array, so the model must call those tools by name
  // directly instead of paying the ToolSearch round the header doctrine
  // prescribes for every other namespace. The name list renders from the
  // same catalog the injection reads, in the same order, so the prompt can
  // never advertise a tool the tools array does not carry.
  const alwaysLoadedLines = isAlwaysInjectedNamespace(namespace)
    ? [
        "Always loaded: every tool below is already in your tools array; call it by name directly, no ToolSearch round needed: "
          + advertisedTools()
            .filter((tool) => tool.namespace === namespace)
            .map((tool) => `\`${tool.publicName}\``)
            .join(", ")
          + ".",
      ]
    : [];

  const lines = [
    `### ${namespace}`,
    declaration.identity,
    ...alwaysLoadedLines,
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
  } else if (availability.gatedMutatingEnvironmentNames.length > 0) {
    // Partially gated namespace: its reads are live, but every mutating tool
    // is env-hidden. Saying so stops the model both from hunting for a trade
    // tool that discovery will not return and from believing none exists.
    lines.push(
      "Contains mutating tools (may require approval); they stay unavailable until "
      + `${availability.gatedMutatingEnvironmentNames.join(" and ")} is configured.`,
    );
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
    "Search a namespace with ToolSearch; a namespace itself is never called by name. Exception: a namespace marked \"Always loaded\" already has every tool in your tools array, so call those tools directly.",
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
