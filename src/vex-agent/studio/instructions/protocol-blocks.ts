/**
 * Section 5 of the managed block: ONE BLOCK PER PROTOCOL the server exposes.
 *
 * WHY THE BLOCK CARRIES THIS AT ALL. `.vex/protocols.md` is an inventory table:
 * names, hints and required keys, no prose, by design. A measured session could
 * therefore see that `morpho__vault_deposit` exists and still not know what
 * Morpho is, which chains it reaches, which read tool comes first or which quote
 * authorizes that deposit - and it is not loaded at startup either. The eleven
 * blocks below are what the in-app agent has always been told, in the file the
 * external agent actually receives.
 *
 * ONE SOURCE, NOT A COPY. The prose comes from
 * `tools/protocols/navigation/*` - the SAME `ProtocolNamespaceDeclaration` the
 * app's own prompt layer renders through `engine/prompts/protocol-capabilities.ts`,
 * and the same chain projection through `engine/prompts/chain-coverage.ts`.
 * Nothing here re-authors a sentence about a protocol: a protocol that changes
 * changes its declaration, and both consumers move together. The two fields the
 * prompt layer renders that this section does not - `whenItApplies` and
 * `characteristicAndLimits` - are the deliberate shortening the byte budget
 * asked for (`STUDIO_MANAGED_BLOCK_MAX_BYTES`), and they are named here rather
 * than silently dropped.
 *
 * AVAILABILITY IS THIS INSTALLATION'S, not a generic note. A namespace whose key
 * is missing says so in its own block, which is where an agent looks before it
 * spends a call finding out.
 */

import { getProtocolNamespaceCoverage } from "../../engine/prompts/chain-coverage.js";
import { PREQUOTE_MAX_AGE_MS } from "../../tools/protocols/prequote/registry.js";
import { buildStudioInventory } from "../../mcp/inventory/index.js";
import { getAdvertisedProtocolNavigation } from "../../tools/protocols/descriptions.js";
import { studioTaggedHeading } from "./changelog.js";
import type { StudioInstallationEnvironment } from "./installation-environment.js";
import { isStudioEnvironmentKeyConfigured } from "./installation-environment.js";

/** The environment variable a namespace's tools declare, when they declare one. */
function namespaceRequiredKey(namespace: string): string | undefined {
  const keys = new Set(
    buildStudioInventory()
      .filter((tool) => tool.namespace === namespace)
      .flatMap((tool) => tool.requiresEnv ? [tool.requiresEnv] : []),
  );
  return [...keys].sort()[0];
}

function availabilityLine(
  namespace: string,
  environment: StudioInstallationEnvironment,
): string {
  const key = namespaceRequiredKey(namespace);
  if (key === undefined) {
    return "- Key: none required, so these tools are available in this installation.";
  }
  return isStudioEnvironmentKeyConfigured(environment, key)
    ? `- Key: \`${key}\`, and it IS configured in this installation.`
    : `- Key: \`${key}\`, and it is NOT configured here. Every tool in this `
      + "namespace answers `configuration_unavailable` naming that variable "
      + "until the user sets it in Vex; do not work around it.";
}

/** Section 5, rendered from the protocol declarations and this installation. */
export function renderStudioProtocolBlocks(
  environment: StudioInstallationEnvironment,
): string {
  const lines: string[] = [
    studioTaggedHeading(
      "## Protocols available to this project",
      "Protocols available to this project",
    ),
    "",
    "A project chooses agents, wallets and a permission level - never protocols.",
    "Every protocol below is exposed to this project; whether its tools can RUN",
    "depends on the key named in its block. The tool-by-tool inventory, with the",
    "read-only and destructive hints, is in `.vex/protocols.md`; the argument",
    "contract of one tool is on that tool's own description, which",
    "`vex_ToolDescribe` returns whole.",
    "",
  ];

  for (const navigation of getAdvertisedProtocolNavigation()) {
    const { namespace, declaration } = navigation;
    const coverage = getProtocolNamespaceCoverage(namespace)?.line
      ?? declaration.coverageNote;
    lines.push(
      studioTaggedHeading(`### ${namespace}`, namespace),
      "",
      declaration.identity,
      "",
      // The runtime projection already labels itself "Coverage: ..."; a second
      // label would read as "Chains: Coverage: ...".
      `- Chains: ${(coverage ?? "see the namespace's own chain-listing tool.").replace(/^Coverage:\s*/, "")}`,
      `- Read: ${declaration.read}`,
      `- Quote: ${declaration.quote}`,
      `- Act: ${declaration.act}`,
      availabilityLine(namespace, environment),
      "",
    );
  }

  lines.push(
    "A quote authorizes only the execute in its OWN pair, and every quote is",
    `fresh for ${String(Math.round(PREQUOTE_MAX_AGE_MS / 60_000))} minutes. Whatever a namespace's own execute is named, it is`,
    "the",
    "same executor as the always-loaded front door pinned to one venue, with the",
    "same quote gate, the same Vex fee and the same approval card.",
  );
  return lines.join("\n").trimEnd();
}
