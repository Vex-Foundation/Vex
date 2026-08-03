/**
 * W0 — manifest convention linter.
 *
 * Freezes the param/description convention (`protocols/conventions.ts`) across
 * BOTH model-facing lanes: the protocol manifests reached through
 * `discover_tools`/`execute_tool`, and the action-alias + wallet JSON schemas
 * the model reaches first. Every alias-vs-protocol drift found by the audit
 * (D9, D10) existed because only one lane was pinned.
 *
 * The tree is out of convention today, so `_manifest-lint/allowlist.ts` lists
 * every current violation. This suite therefore proves three things at once:
 * no NEW violation, no STALE allowlist entry, and no silent widening of a rule.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import { WALLET_TOOLS } from "@vex-agent/tools/registry/wallet.js";
import { CANONICAL_CHAIN_SLUGS } from "@vex-agent/tools/protocols/conventions.js";
import { listLocalChains } from "@tools/evm-chains/registry.js";
import {
  isLinterOwnSource,
  lintGenericErrorLiterals,
  lintSlippageDefaultHome,
  lintToolSubject,
  MANIFEST_LINT_ALLOWLIST,
  SLIPPAGE_DEFAULT_OWNER,
  staleAllowlistKeys,
  toLintSubject,
  toSchemaLintSubject,
  withoutAllowlisted,
  type ManifestLintIssue,
  type SourceFile,
} from "@vex-agent/tools/protocols/_manifest-lint.js";

const REPO_ROOT = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function readSources(relativeDir: string): SourceFile[] {
  return walk(join(REPO_ROOT, relativeDir)).map((file) => ({
    path: relative(REPO_ROOT, file).split(sep).join("/"),
    text: readFileSync(file, "utf-8"),
  })).filter((source) => !isLinterOwnSource(source.path));
}

function format(issues: readonly ManifestLintIssue[]): string {
  return issues.map((i) => `  - ${i.subject} [${i.rule}/${i.detail}] ${i.message}`).join("\n");
}

const protocolIssues = PROTOCOL_TOOLS.flatMap((manifest) => lintToolSubject(toLintSubject(manifest)));

const aliasIssues = [...ACTION_ALIAS_TOOLS, ...WALLET_TOOLS].flatMap((tool) =>
  lintToolSubject(
    toSchemaLintSubject({
      name: tool.name,
      description: tool.description,
      mutating: tool.mutating,
      parameters: tool.parameters,
    }),
  ),
);

const protocolSources = readSources("src/vex-agent/tools/protocols");
const sourceIssues = [
  ...lintGenericErrorLiterals(protocolSources),
  ...lintSlippageDefaultHome([...protocolSources, ...readSources("src/tools")]),
];

const allIssues = [...protocolIssues, ...aliasIssues, ...sourceIssues];

describe("W0 — manifest convention linter", () => {
  it("reads a non-empty surface (sanity)", () => {
    expect(PROTOCOL_TOOLS.length).toBeGreaterThan(0);
    expect(ACTION_ALIAS_TOOLS.length + WALLET_TOOLS.length).toBeGreaterThan(0);
    expect(protocolSources.length).toBeGreaterThan(0);
  });

  it("no protocol manifest violates the convention outside the allowlist", () => {
    const live = withoutAllowlisted(protocolIssues);
    expect(live, `unallowlisted protocol manifest violations:\n${format(live)}`).toEqual([]);
  });

  it("no action-alias or wallet tool violates the convention outside the allowlist", () => {
    const live = withoutAllowlisted(aliasIssues);
    expect(live, `unallowlisted alias/wallet violations:\n${format(live)}`).toEqual([]);
  });

  it("no source-level violation (generic errors, second slippage default) outside the allowlist", () => {
    const live = withoutAllowlisted(sourceIssues);
    expect(live, `unallowlisted source violations:\n${format(live)}`).toEqual([]);
  });

  // W4b: the slippage default now has EXACTLY ONE home. This is stronger than
  // "no unallowlisted violation" above — it proves the debt is gone rather than
  // merely recorded, so a future copy cannot be re-admitted by adding a line to
  // the allowlist.
  it("exactly one module declares a slippage default, and no entry allowlists a second", () => {
    const slippageIssues = lintSlippageDefaultHome([
      ...protocolSources,
      ...readSources("src/tools"),
    ]);
    expect(
      slippageIssues,
      `a second slippage default exists — move it onto ${SLIPPAGE_DEFAULT_OWNER}:\n${format(slippageIssues)}`,
    ).toEqual([]);
    expect(MANIFEST_LINT_ALLOWLIST.filter((e) => e.rule === "slippage-default-home")).toEqual([]);
  });

  it("the allowlist carries no stale entry (a fixed violation must be deleted, not kept)", () => {
    const stale = staleAllowlistKeys(allIssues);
    expect(
      stale,
      `these allowlist entries no longer match a live violation — delete them:\n${stale.map((k) => `  - ${k}`).join("\n")}`,
    ).toEqual([]);
  });

  it("CANONICAL_CHAIN_SLUGS covers every locally-registered chain", () => {
    const uncovered = listLocalChains().filter(
      (chain) => !chain.aliases.some((alias) => CANONICAL_CHAIN_SLUGS.has(alias)),
    );
    expect(
      uncovered.map((c) => c.name),
      "a chain in the local EVM registry has no canonical slug — add it to CANONICAL_CHAIN_SLUGS deliberately",
    ).toEqual([]);
  });
});
