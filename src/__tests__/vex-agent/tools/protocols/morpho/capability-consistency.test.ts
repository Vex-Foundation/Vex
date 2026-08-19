/**
 * Morpho capability-consistency guard.
 *
 * The defect this file pins is not a bug in a handler: it is prose drift. Every
 * time the namespace GAINED an ability, some of the sentences describing it kept
 * denying that ability, and nothing failed. On 2026-08-17 the shipped catalog
 * could borrow, repay, move collateral in both directions and claim Merkl
 * rewards, while the doctrine block said Vex could not claim, the navigation
 * entry said execution was vault-only, one embedding passage said claiming was
 * not available yet, and the user-facing how-vex-works page repeated the claim
 * denial. Four surfaces, all false, all green.
 *
 * SO THE CAPABILITY SIDE IS DERIVED FROM THE CATALOG, NOT RESTATED HERE. The
 * test reads `PROTOCOL_TOOLS`, keeps the morpho namespace, and treats each
 * shipped `toolId` as a capability that EXISTS. Only the denial vocabulary is
 * written by hand, because there is no way to derive "the English sentences that
 * would contradict this tool" from a manifest. That split is the whole point: a
 * new morpho tool cannot silently make the table stale, because the table is
 * keyed on tool ids the catalog must still contain, and a tool that is REMOVED
 * fails `every denial entry names a shipped tool` rather than quietly disarming
 * its own guard.
 *
 * The scanned surfaces are every place a morpho capability statement can reach a
 * reader: the manifest descriptions and their param descriptions, the retrieval
 * passages and their aliases and example intents, every field of the navigation
 * entry including its facets, the Morpho doctrine section of the system prompt,
 * and the how-vex-works page the desktop app renders.
 *
 * The SECOND assertion is a different kind of honesty. The 1.25 health-factor
 * floor is a pre-signature buffer: the calldata Vex signs is a plain Morpho Blue
 * call with no floor in it, so an oracle move before inclusion can settle the
 * position under 1.25 and still above Morpho's own liquidation threshold of 1.
 * Any sentence that promises the floor as an on-chain guarantee is selling a
 * safety property the chain never agreed to, so the phrases that would promise
 * it are banned outright rather than tied to a tool id.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { MORPHO_NAVIGATION } from "@vex-agent/tools/protocols/navigation/entries-market/morpho.js";
import { buildProtocolsPrompt } from "@vex-agent/engine/prompts/protocols.js";

/** One scanned string plus enough provenance to fix it without searching. */
interface MorphoStatement {
  readonly source: string;
  readonly text: string;
}

/**
 * A capability the catalog SHIPS, and the phrasings that would deny it.
 *
 * `toolId` is the link to the catalog: the entry only arms when that tool is
 * really registered, and the staleness test fails if it stops being.
 */
interface CapabilityDenials {
  readonly toolId: string;
  readonly capability: string;
  readonly denials: readonly RegExp[];
}

const MORPHO_MANIFESTS = PROTOCOL_TOOLS.filter((manifest) => manifest.namespace === "morpho");

const HOW_VEX_WORKS_PATH = fileURLToPath(
  new URL(
    "../../../../../../vex-app/src/renderer/features/appShell/screens/how-vex-works-content.md",
    import.meta.url,
  ),
);

/**
 * The Morpho doctrine slice of the system prompt. Sliced rather than scanned
 * whole so a denial in the Pendle or Solana lending section, which may be
 * perfectly true there, cannot fail this test.
 */
function morphoDoctrine(): string {
  const prompt = buildProtocolsPrompt();
  const start = prompt.indexOf("## Lending (Morpho)");
  const end = prompt.indexOf("## Bridge Routing", start);
  expect(start, "Morpho doctrine heading missing from the protocols prompt").toBeGreaterThan(-1);
  expect(end, "Bridge Routing heading missing after the Morpho doctrine").toBeGreaterThan(start);
  return prompt.slice(start, end);
}

/** Only the Morpho section of the how-vex-works page, for the same reason. */
function howVexWorksMorphoSection(): string {
  const page = readFileSync(HOW_VEX_WORKS_PATH, "utf8");
  const start = page.indexOf("### ![Morpho]");
  expect(start, "Morpho section missing from how-vex-works-content.md").toBeGreaterThan(-1);
  const next = page.indexOf("\n### ", start + 1);
  return page.slice(start, next === -1 ? page.length : next);
}

function collectStatements(): MorphoStatement[] {
  const statements: MorphoStatement[] = [];

  for (const manifest of MORPHO_MANIFESTS) {
    statements.push({ source: `manifest ${manifest.toolId} description`, text: manifest.description });
    for (const param of manifest.params) {
      statements.push({
        source: `manifest ${manifest.toolId} param ${param.key}`,
        text: param.description,
      });
    }
    const discovery = manifest.discovery;
    if (discovery?.embeddingText) {
      statements.push({ source: `embedding passage ${manifest.toolId}`, text: discovery.embeddingText });
    }
    for (const alias of discovery?.aliases ?? []) {
      statements.push({ source: `embedding alias ${manifest.toolId}`, text: alias });
    }
    for (const intent of discovery?.exampleIntents ?? []) {
      statements.push({ source: `embedding intent ${manifest.toolId}`, text: intent });
    }
  }

  statements.push({ source: "navigation summary", text: MORPHO_NAVIGATION.summary });
  statements.push({ source: "navigation whenToUse", text: MORPHO_NAVIGATION.whenToUse });
  if (MORPHO_NAVIGATION.preferInstead) {
    statements.push({ source: "navigation preferInstead", text: MORPHO_NAVIGATION.preferInstead });
  }
  for (const facet of MORPHO_NAVIGATION.facets ?? []) {
    statements.push({ source: `navigation facet ${facet.label}`, text: `${facet.label}. ${facet.summary}` });
  }

  for (const line of morphoDoctrine().split("\n")) {
    if (line.trim().length > 0) statements.push({ source: "doctrine line", text: line });
  }

  statements.push({ source: "how-vex-works Morpho section", text: howVexWorksMorphoSection() });

  return statements;
}

/**
 * The denial vocabulary, one entry per shipped capability.
 *
 * Each pattern is written to catch the SHAPE of the false sentence rather than
 * one exact wording, and deliberately not so loose that a true sentence trips
 * it. "a repayment that cannot close its debt" and "an assets repayment cannot
 * reach zero" are both true and must keep passing, which is why the repay entry
 * anchors on the wallet-level actor rather than on the bare word "cannot".
 */
const CAPABILITY_DENIALS: readonly CapabilityDenials[] = [
  {
    toolId: "morpho.rewards.claim",
    capability: "claiming Merkl rewards",
    denials: [
      /\bcan(?:not|'t|no)\s+(?:\w+\s+){0,3}claim\b/i,
      /\bclaim(?:ing)?\b[^.]{0,60}\b(?:is|are)\s+(?:still\s+)?(?:not available|unavailable|read-only)/i,
      /\bno tool for claim/i,
      /\bclaiming\b[^.]{0,40}\bnot (?:available|supported|possible)\b/i,
      /\buser must (?:send|claim|sweep)\b/i,
    ],
  },
  {
    toolId: "morpho.market.borrow",
    capability: "borrowing on a Blue market",
    denials: [
      // Anchored on the ACTOR, because "a supplyCollateral quote cannot
      // authorize a borrow" is true and must keep passing.
      /\b(?:Vex|it) can(?:not|'t)\s+(?:\w+\s+){0,3}borrow\b/i,
      /\bcannot borrow\b/i,
      /\bno tool for borrow/i,
      /\bborrowing\b[^.]{0,40}\bnot (?:available|supported|possible)\b/i,
    ],
  },
  {
    toolId: "morpho.market.repay",
    capability: "repaying debt on a Blue market",
    denials: [
      /\bVex can(?:not|'t)\s+(?:\w+\s+){0,3}repay\b/i,
      /\bno tool for repay/i,
      /\brepaying\b[^.]{0,40}\bnot (?:available|supported|possible)\b/i,
    ],
  },
  {
    toolId: "morpho.market.supplyCollateral",
    capability: "supplying and withdrawing collateral",
    denials: [
      /\bcan(?:not|'t|no)\s+(?:\w+\s+){0,3}(?:move|supply|post|withdraw)\s+collateral\b/i,
      /\bno tool for (?:moving|supplying|withdrawing) collateral/i,
    ],
  },
  {
    toolId: "morpho.market.withdrawCollateral",
    capability: "executing on Blue markets at all, not only vaults",
    denials: [
      /\bvaults?[\s-]only\b/i,
      /\bon VAULTS ONLY\b/,
      /\beverything else (?:stays|remains|is still) read-only\b/i,
    ],
  },
];

/**
 * Phrasings that would sell the 1.25 floor as something the chain enforces.
 * Not keyed on a tool id: the floor is a policy of the whole execute lane, and
 * the lie is the same lie wherever it appears.
 */
const FLOOR_OVERPROMISES: readonly RegExp[] = [
  /\bguarantee[sd]?\b[^.]{0,50}\bhealth factor\b/i,
  /\bhealth factor\b[^.]{0,50}\bis guaranteed\b/i,
  /\bnever (?:be |get )?liquidated\b/i,
  /\bcannot (?:be |get )?liquidated (?:below|under)\b/i,
];

describe("morpho capability consistency", () => {
  const statements = collectStatements();
  const shippedToolIds = new Set(MORPHO_MANIFESTS.map((manifest) => manifest.toolId));

  it("scans a plausible number of morpho statements", () => {
    expect(MORPHO_MANIFESTS.length).toBe(19);
    expect(statements.length).toBeGreaterThan(100);
  });

  it("every denial entry names a tool the catalog still ships", () => {
    const orphaned = CAPABILITY_DENIALS.filter((entry) => !shippedToolIds.has(entry.toolId));
    expect(
      orphaned.map((entry) => entry.toolId),
      "the denial table is stale: these tool ids are no longer in PROTOCOL_TOOLS, so their guards are disarmed",
    ).toEqual([]);
  });

  for (const entry of CAPABILITY_DENIALS) {
    it(`no morpho string denies ${entry.capability}`, () => {
      const offenders: string[] = [];
      for (const statement of statements) {
        for (const denial of entry.denials) {
          const match = denial.exec(statement.text);
          if (match) offenders.push(`${statement.source}: "${match[0]}"`);
        }
      }
      expect(
        offenders,
        `${entry.toolId} ships, so these strings contradict the catalog:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }

  it("no morpho string promises the 1.25 floor as an on-chain guarantee", () => {
    const offenders: string[] = [];
    for (const statement of statements) {
      for (const overpromise of FLOOR_OVERPROMISES) {
        const match = overpromise.exec(statement.text);
        if (match) offenders.push(`${statement.source}: "${match[0]}"`);
      }
    }
    expect(
      offenders,
      `the floor is a pre-signature buffer, not a guarantee:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
