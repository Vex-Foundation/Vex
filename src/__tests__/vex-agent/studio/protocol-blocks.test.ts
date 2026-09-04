/**
 * SECTION 5: one block per protocol, and this installation's own availability.
 *
 * Two failures are being prevented. The first is a protocol an agent cannot see:
 * `.vex/protocols.md` is an inventory table with no prose and is not loaded at
 * startup, so before this section a measured session could see that a tool
 * exists and still not know what the protocol is, which chains it reaches or
 * which quote authorizes its execute. The second is a wasted first call: nothing
 * told the agent which provider keys are configured HERE, so the first call to
 * an unconfigured namespace was always the one that found out (A17).
 *
 * The third thing asserted is a security property: the availability line reports
 * variable NAMES and never values, into a file that lives in the user's
 * repository (rule 07).
 *
 * Pure, no DB, no network.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import {
  STUDIO_NAMESPACE_FEES,
  renderStudioProtocolBlocks,
} from "@vex-agent/studio/instructions/protocol-blocks.js";
import {
  resolveStudioInstallationEnvironment,
  studioDeclaredEnvironmentKeys,
} from "@vex-agent/studio/instructions/installation-environment.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";

import { STUDIO_TEST_ENVIRONMENT } from "./render-fixtures.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/** Every `.ts` file under one directory, recursively. */
function sourcesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("the protocol blocks", () => {
  const rendered = renderStudioProtocolBlocks(STUDIO_TEST_ENVIRONMENT);

  it("gives EVERY advertised protocol its own block", () => {
    // A project chooses agents, wallets and a level - never protocols. So the
    // set here is the server's, not the project's, and a protocol that lands
    // without a block would be invisible to an agent that never runs a search.
    const namespaces = getAdvertisedProtocolNavigation().map((n) => n.namespace);
    expect(namespaces.length).toBeGreaterThan(0);
    for (const namespace of namespaces) {
      expect(rendered, `${namespace} must have a block`).toContain(`### ${namespace}`);
    }
  });

  it("carries what the protocol IS, its chains, and its read/quote/act tools", () => {
    for (const navigation of getAdvertisedProtocolNavigation()) {
      expect(rendered).toContain(navigation.declaration.identity);
      expect(rendered).toContain(`- Read: ${navigation.declaration.read}`);
      expect(rendered).toContain(`- Quote: ${navigation.declaration.quote}`);
      expect(rendered).toContain(`- Act: ${navigation.declaration.act}`);
    }
    expect(rendered).toContain("- Chains:");
  });

  it("is rendered from the declarations, never re-authored beside them", () => {
    // One source: the same `ProtocolNamespaceDeclaration` the in-app prompt
    // layer renders. A second wording here would drift the first time a
    // protocol changed.
    const first = getAdvertisedProtocolNavigation()[0];
    if (first === undefined) throw new Error("no advertised protocol to render from");
    expect(rendered.includes(first.declaration.whenItApplies)).toBe(false);
  });

  it("says which key is missing HERE, and never prints a value", () => {
    for (const key of STUDIO_TEST_ENVIRONMENT.missingKeys) {
      if (!rendered.includes(key)) continue;
      expect(rendered).toContain("NOT configured here");
      expect(rendered).toContain("configuration_unavailable");
    }
    // Names only. A configured key's VALUE must never reach a file in the
    // user's repository.
    const environment = resolveStudioInstallationEnvironment({
      ...Object.fromEntries(studioDeclaredEnvironmentKeys().map((k) => [k, "s3cret-value"])),
    });
    const withKeys = renderStudioProtocolBlocks(environment);
    expect(withKeys).not.toContain("s3cret-value");
    // Only the keys a NAMESPACE requires appear here; an internal tool's key
    // (TwitterAccount) has no protocol block to sit in.
    const named = environment.configuredKeys.filter((key) => withKeys.includes(key));
    expect(named.length).toBeGreaterThan(0);
  });

  it("flips a namespace's availability line with the environment, both ways", () => {
    const declared = studioDeclaredEnvironmentKeys();
    expect(declared.length).toBeGreaterThan(0);
    const none = renderStudioProtocolBlocks({ configuredKeys: [], missingKeys: declared });
    const all = renderStudioProtocolBlocks({ configuredKeys: declared, missingKeys: [] });
    expect(none).toContain("NOT configured here");
    expect(all).not.toContain("NOT configured here");
    expect(all).toContain("IS configured in this installation");
  });

  it("declares only keys the EXPORTED surface needs, so TAVILY_API_KEY is gone", () => {
    // The declared list is DERIVED from the exported inventory, which is why
    // dropping WebResearch from the export also stops the managed block telling
    // a coding agent to configure a Tavily key it has no tool for. The in-app
    // tool still needs that key; the block speaks only for the MCP surface.
    const declared = studioDeclaredEnvironmentKeys();
    expect(declared).not.toContain("TAVILY_API_KEY");
    expect(declared).toEqual([...new Set(
      buildStudioInventory().flatMap((tool) => (tool.requiresEnv ? [tool.requiresEnv] : [])),
    )].sort());
  });

  it("treats a whitespace-only variable as missing, exactly as the tools do", () => {
    const key = studioDeclaredEnvironmentKeys()[0];
    if (key === undefined) throw new Error("no declared environment key to test");
    const environment = resolveStudioInstallationEnvironment({ [key]: "   " });
    expect(environment.configuredKeys).not.toContain(key);
    expect(environment.missingKeys).toContain(key);
  });

  it("states the quote/execute rule once, for every namespace at once", () => {
    expect(rendered).toContain("authorizes only the execute in its OWN pair");
    expect(rendered).toContain("15 minutes");
    expect(rendered).toContain("same quote gate");
  });

  it("says a namespaced quote does NOT unlock the front door", () => {
    // I-6k: "same executor ... same quote gate" read as if a namespaced quote
    // could authorize the always-loaded execute, which `SwapExecute`'s own
    // description denies (live test pass 2, p1.txt lines 75-77).
    expect(rendered).toContain("SAME code path");
    expect(rendered).toContain("A namespaced quote never unlocks the front door");
  });

  it("gives EVERY namespace a Vex fee line", () => {
    // I-6: the fee note named swaps, bridges, Trench, the generic EVM pair and
    // launches, leaving the Solana generic pair, Solana lend/predict and the
    // pools trades in neither list (p1.txt lines 134-136).
    for (const navigation of getAdvertisedProtocolNavigation()) {
      expect(
        STUDIO_NAMESPACE_FEES[navigation.namespace],
        `${navigation.namespace} needs a fee entry`,
      ).toBeDefined();
    }
    const feeLines = rendered.split("\n").filter((line) => line.startsWith("- Vex fee: "));
    expect(feeLines).toHaveLength(getAdvertisedProtocolNavigation().length);
    expect(rendered).not.toContain("not stated for this namespace yet");
  });

  it("backs every fee line with the code that charges it, or with the absence of it", () => {
    // A fee line is a claim about the user's money, so it is not allowed to
    // drift from the lane: a charged namespace names the constant its lane
    // references, and a free one names lanes that must import no fee module and
    // reference no fee constant at all. Same technique, and same reason, as
    // `instructions-fee-note.test.ts`.
    for (const [namespace, fee] of Object.entries(STUDIO_NAMESPACE_FEES)) {
      const charged = fee.charged;
      if (charged !== undefined) {
        const lane = resolve(REPO_ROOT, charged.lane);
        expect(
          sourcesUnder(lane).some((path) => readFileSync(path, "utf8").includes(charged.symbol)),
          `${namespace}: ${charged.lane} no longer references ${charged.symbol}`,
        ).toBe(true);
      }
      for (const laneName of fee.freeLanes) {
        const lane = resolve(REPO_ROOT, laneName);
        for (const path of sourcesUnder(lane)) {
          const source = readFileSync(path, "utf8");
          expect(
            /FEE_BPS/.test(source),
            `${namespace}: ${laneName} charges something; the block says it is free`,
          ).toBe(false);
          expect(
            [...source.matchAll(/from\s*["']([^"']+)["']/g)]
              .some((match) => /vex-fee\/|bridge-fee|\/fee\//.test(match[1] ?? "")),
            `${namespace}: ${laneName} imports a fee module; the block says it is free`,
          ).toBe(false);
        }
      }
    }
  });

  it("gives the ALWAYS-LOADED tools their own key lines", () => {
    // A17 was fixed per namespace; the hot set has no block, so TwitterAccount's
    // provider secret was readable nowhere (p1.txt lines 131-132).
    const gated = buildStudioInventory()
      .filter((tool) => tool.kind === "internal" && tool.requiresEnv !== undefined);
    expect(gated.length).toBeGreaterThan(0);
    for (const tool of gated) {
      expect(rendered, `${tool.publicName} must carry its key line`)
        .toContain(`\`${tool.publicName}\`: key \`${String(tool.requiresEnv)}\``);
    }
    // Both ways, and never a value.
    const declared = studioDeclaredEnvironmentKeys();
    const all = renderStudioProtocolBlocks({ configuredKeys: declared, missingKeys: [] });
    for (const tool of gated) {
      expect(all).toContain(`\`${tool.publicName}\`: key \`${String(tool.requiresEnv)}\`, and it IS configured here.`);
    }
  });
});
