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

/**
 * WHAT VEX CHARGES IN ONE NAMESPACE, in one line per block.
 *
 * The live test (2026-09-03, p1.txt lines 134-136) measured the gap: the fee
 * note names swaps, bridges, the generic EVM pair and launches, and the
 * FREE list names sends, wraps, Pendle and Morpho, which leaves the Solana
 * generic pair, Solana lend and predict, and the pools trades in NEITHER list.
 * An agent that cannot tell whether a namespace charges guesses, and a guess
 * about the user's money is the one guess this file exists to remove.
 *
 * EVERY ENTRY CARRIES ITS EVIDENCE, and the evidence is what
 * `__tests__/vex-agent/studio/protocol-blocks.test.ts` checks: a charged
 * namespace names the fee constant its lane actually references, and a free
 * namespace names the lane directories that must import no fee module and
 * reference no fee constant at all. A claim of "none" with no code behind it
 * would be exactly the drift the fee-note suite already refuses for the block's
 * own fee paragraph.
 */
interface StudioNamespaceFee {
  /** Rendered after "- Vex fee: ". One sentence, no rate arithmetic. */
  readonly line: string;
  /**
   * The fee constant a charged lane references, with the directory that
   * references it. Absent when the namespace charges nothing at all.
   */
  readonly charged?: {
    readonly symbol: string;
    readonly lane: string;
  };
  /** Lanes that must carry NO fee module and NO fee constant, ever. */
  readonly freeLanes: readonly string[];
}

export const STUDIO_NAMESPACE_FEES: Readonly<Record<string, StudioNamespaceFee>> = {
  dexscreener: {
    line: "none; every tool here is a read.",
    freeLanes: ["src/vex-agent/tools/protocols/dexscreener", "src/tools/dexscreener"],
  },
  khalani: {
    line: "25 bps of the input on a bridge execute; reads and quotes free.",
    charged: { symbol: "BRIDGE_FEE_BPS", lane: "src/tools/bridge-fee" },
    freeLanes: [],
  },
  kyberswap: {
    line: "25 bps of the input on a swap execute, embedded in the quote.",
    charged: { symbol: "KYBERSWAP_FEE_BPS", lane: "src/tools/kyberswap" },
    freeLanes: [],
  },
  morpho: {
    line: "none on any action, rewards claims included; gas is still yours.",
    freeLanes: ["src/vex-agent/tools/protocols/morpho", "src/tools/morpho"],
  },
  pendle: {
    line: "none on any action; gas is still yours.",
    freeLanes: ["src/vex-agent/tools/protocols/pendle", "src/tools/pendle"],
  },
  pools: {
    line: "25 bps of the native value a launch or trade sends; reads are free.",
    charged: { symbol: "POOLS_FEE_BPS", lane: "src/tools/pools-fun" },
    freeLanes: [],
  },
  relay: {
    line: "25 bps of the input on a bridge execute; reads and quotes free.",
    charged: { symbol: "BRIDGE_FEE_BPS", lane: "src/vex-agent/tools/protocols/relay" },
    freeLanes: [],
  },
  solana: {
    line:
      "25 bps of the input on a SWAP, embedded in the quote; the lend, borrow "
      + "and prediction actions none.",
    charged: {
      symbol: "JUPITER_SWAP_FEE_BPS",
      lane: "src/tools/solana-ecosystem/jupiter/jupiter-swaps",
    },
    freeLanes: [
      "src/tools/solana-ecosystem/jupiter/jupiter-lend",
      "src/tools/solana-ecosystem/jupiter/jupiter-prediction",
    ],
  },
  launchpads: {
    // Nothing in this namespace moves value. Listing the locker is a database
    // read, and publishing a picture is an upload to a host Vex runs: there is
    // no swap, no transfer and no launch here to take a cut of, so the honest
    // line is "none" with the lanes that must import no fee module as evidence.
    line:
      "none - the image locker is a read and publishing a picture moves no value, so neither "
      + "charges anything. The launch a picture is FOR is charged by its own launchpad namespace.",
    freeLanes: ["src/vex-agent/tools/protocols/launchpads"],
  },
  uniswap: {
    line:
      "25 bps of the input on a swap execute, as a separate transfer leg, not "
      + "in the quote.",
    charged: { symbol: "UNISWAP_FEE_BPS", lane: "src/tools/uniswap" },
    freeLanes: [],
  },
  virtuals: {
    // The curve trade pair landed, so the first half of this line stopped being
    // "a later lane" and became a charge the user can incur today. The LAUNCH
    // half is still stated as future behaviour, because claiming a fee for a
    // tool that does not exist is as wrong as hiding one that does.
    line:
      "25 bps of the VIRTUAL you commit on a bonding-curve buy, taken off the input before the curve, "
      + "and 25 bps of the VIRTUAL a receipt proves you received on a sell, taken as a separate leg "
      + "after the sale settles; a trade that reverts or cannot be proven is never charged. Every "
      + "Virtuals read is free, a graduated agent trades under its venue's own fee with no second one, "
      + "and the confirmed policy for the launch tools of a later lane is 25 bps of the initial "
      + "purchase once a launch is observed on chain, with genesis free.",
    charged: { symbol: "VIRTUALS_CURVE_FEE_BPS", lane: "src/tools/virtuals" },
    freeLanes: [],
  },
};

function feeLine(namespace: string): string {
  const fee = STUDIO_NAMESPACE_FEES[namespace];
  return fee === undefined
    // A namespace with no entry is a gap, and saying so is honest where
    // guessing "none" would be a claim about the user's money that no code
    // backs. `protocol-blocks.test.ts` fails before this can ship.
    ? "- Vex fee: not stated for this namespace yet; call `vex_ToolDescribe` on the tool."
    : `- Vex fee: ${fee.line}`;
}

/** The environment variable a namespace's tools declare, when they declare one. */
function namespaceRequiredKey(namespace: string): string | undefined {
  const keys = new Set(
    buildStudioInventory()
      .filter((tool) => tool.namespace === namespace)
      .flatMap((tool) => tool.requiresEnv ? [tool.requiresEnv] : []),
  );
  return [...keys].sort()[0];
}

/**
 * The `Key:` line, or NOTHING when the namespace needs no provider key.
 *
 * SILENCE IS THE STATEMENT, and the intro above says what it means: a block
 * with no `Key:` line needs no key. Ten of the eleven namespaces required none,
 * so the line was the same 72 bytes repeated ten times in a file every agent
 * loads on every turn - the first lever the byte bound names, and the one taken
 * when the per-namespace fee lines (I-6) pushed the block past it. Nothing is
 * cut: the fact is rendered once instead of ten times, and a namespace that
 * DOES need a key still says so in its own block.
 */
function availabilityLine(
  namespace: string,
  environment: StudioInstallationEnvironment,
): string | undefined {
  const key = namespaceRequiredKey(namespace);
  if (key === undefined) return undefined;
  return isStudioEnvironmentKeyConfigured(environment, key)
    ? `- Key: \`${key}\`, and it IS configured in this installation.`
    : `- Key: \`${key}\`, and it is NOT configured here: every tool in this `
      + "namespace answers `configuration_unavailable` until the user sets it "
      + "in Vex.";
}

/**
 * The KEY LINES for the ALWAYS-LOADED tools, which have no protocol block.
 *
 * Eleven namespaces carry a "Key:" line; the hot set carried none, so
 * `TwitterAccount`'s provider secret was the one availability an agent could
 * not read anywhere (live test 2026-09-03, p1.txt lines 131-132). Derived from
 * the same live inventory as every other count here, so a hot tool that gains
 * or loses a key gains or loses its line without anyone remembering to edit
 * this file.
 */
function alwaysLoadedKeyLines(
  environment: StudioInstallationEnvironment,
): readonly string[] {
  const gated = buildStudioInventory()
    .filter((tool) => tool.kind === "internal" && tool.requiresEnv !== undefined)
    .map((tool) => ({ name: tool.publicName, key: tool.requiresEnv as string }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (gated.length === 0) {
    return ["No always-loaded tool needs a provider key.", ""];
  }
  return [
    "Always-loaded tools have no block; all run without a key except these:",
    "",
    ...gated.map(({ name, key }) => (
      isStudioEnvironmentKeyConfigured(environment, key)
        ? `- \`${name}\`: key \`${key}\`, and it IS configured here.`
        : `- \`${name}\`: key \`${key}\`, and it is NOT configured here: it answers `
          + "`configuration_unavailable` until the user sets it in Vex."
    )),
    "",
  ];
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
    "depends on its `Key:` line, and a block with NO `Key:` line needs no provider",
    "key. The tool-by-tool inventory is in `.vex/protocols.md`; one tool's argument",
    "contract is on its own description, which `vex_ToolDescribe` returns whole.",
    "",
    ...alwaysLoadedKeyLines(environment),
  ];

  for (const navigation of getAdvertisedProtocolNavigation()) {
    const { namespace, declaration } = navigation;
    const coverage = getProtocolNamespaceCoverage(namespace)?.line
      ?? declaration.coverageNote;
    const availability = availabilityLine(namespace, environment);
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
      feeLine(namespace),
      ...(availability === undefined ? [] : [availability]),
      "",
    );
  }

  lines.push(
    "A quote authorizes only the execute in its OWN pair and stays fresh for",
    `${String(Math.round(PREQUOTE_MAX_AGE_MS / 60_000))} minutes. A namespace's own execute runs the SAME code path as the`,
    "always-loaded front door for that venue: same quote gate, same Vex fee, same",
    "approval card.",
    "A namespaced quote never unlocks the front door, and the front door's",
    "quote never unlocks a namespaced execute.",
  );
  return lines.join("\n").trimEnd();
}
