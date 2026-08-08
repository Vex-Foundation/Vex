/**
 * Signing-oracle guard (Sprint 3 T10) — the trading keys sign exactly two
 * fixed message shapes anywhere in this codebase: the trench.express
 * `VEX-attest:` badge attestation and the AgentScan `AgentScan Handshake v1`
 * wallet-binding proof. This test enumerates every `signMessage` / raw
 * ed25519 sign call site under `src/` and asserts the only files containing
 * one are the two modules that own those formats — a new call site anywhere
 * else is either a duplicate signing oracle for an existing format (should
 * reuse the owning module) or an entirely new message shape (needs its own
 * blast-radius review, not a silent addition here).
 *
 * Scans the whole `src/` tree (not just `src/vex-agent/`, unlike the sibling
 * tests in this directory) because the two allowed modules live on either
 * side of that boundary: `src/tools/wallet/handshake-signing.ts` and
 * `src/vex-agent/tools/protocols/trench/handlers/launch/execute/attribute.ts`.
 *
 * Uses a recursive readdir walk, NOT `git ls-files`: on this machine the repo
 * path contains a space, which breaks the `git ls-files`-based scanners the
 * sibling tests in this directory use (see their pre-existing, unrelated
 * failures). A plain fs walk has no such dependency.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "src");

const EXCLUDED_DIR_NAMES = new Set(["__tests__", "node_modules", "e2e", "scripts"]);

const HANDSHAKE_SIGNING_MODULE = resolve(ROOT, "tools/wallet/handshake-signing.ts");
const TRENCH_ATTRIBUTION_SIGN_SITE = resolve(
  ROOT,
  "vex-agent/tools/protocols/trench/handlers/launch/execute/attribute.ts",
);
const TRENCH_ATTRIBUTION_MESSAGE_BUILDER = resolve(ROOT, "tools/trench-express/attribution.ts");

const ALLOWED_SIGNING_MODULES = [HANDSHAKE_SIGNING_MODULE, TRENCH_ATTRIBUTION_SIGN_SITE];

const SIGNING_CALL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "viem signMessage", pattern: /\.signMessage\s*\(/ },
  { name: "raw ed25519 sign.detached", pattern: /\.sign\.detached\s*\(/ },
  { name: "raw ed25519 sign (noble/curves-style)", pattern: /\bed25519\.sign\s*\(/ },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

interface SigningCallSite {
  readonly path: string;
  readonly line: number;
  readonly pattern: string;
  readonly snippet: string;
}

function findSigningCallSites(files: string[]): SigningCallSite[] {
  const hits: SigningCallSite[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf-8"));
    for (const [i, line] of code.split("\n").entries()) {
      for (const { name, pattern } of SIGNING_CALL_PATTERNS) {
        if (pattern.test(line)) {
          hits.push({ path: file, line: i + 1, pattern: name, snippet: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return hits;
}

describe("signing-oracle guard — only the named modules may produce VEX-attest / AgentScan Handshake signatures", () => {
  it("no signMessage / raw ed25519 sign call site exists outside the two allowed modules", () => {
    const files = listTsFiles(ROOT);
    expect(files.length, "no source files discovered — readdir walk broken?").toBeGreaterThan(0);

    const hits = findSigningCallSites(files);
    const disallowed = hits.filter((hit) => !ALLOWED_SIGNING_MODULES.includes(hit.path));

    if (disallowed.length > 0) {
      const detail = disallowed
        .map((hit) => `  ${hit.path}:${hit.line} [${hit.pattern}] ${hit.snippet}`)
        .join("\n");
      throw new Error(
        `signing-oracle policy violated — a signing call site exists outside the allowed modules:\n${detail}\n` +
          `Allowed modules:\n  ${ALLOWED_SIGNING_MODULES.join("\n  ")}`,
      );
    }
    expect(disallowed).toEqual([]);
  });

  it("both allowed modules actually contain a signing call site (the allowlist is not vacuous)", () => {
    for (const file of ALLOWED_SIGNING_MODULES) {
      const code = stripComments(readFileSync(file, "utf-8"));
      const hasSigningCall = SIGNING_CALL_PATTERNS.some(({ pattern }) => pattern.test(code));
      expect(hasSigningCall, `${file} was expected to contain a signing call site`).toBe(true);
    }
  });

  it("ties each allowed signing call site to the one message format it is permitted to produce", () => {
    const attributeSource = readFileSync(TRENCH_ATTRIBUTION_SIGN_SITE, "utf-8");
    expect(attributeSource).toContain("buildAttestMessage");

    const attributionSource = readFileSync(TRENCH_ATTRIBUTION_MESSAGE_BUILDER, "utf-8");
    expect(attributionSource).toContain("VEX-attest:");

    const handshakeSigningSource = readFileSync(HANDSHAKE_SIGNING_MODULE, "utf-8");
    expect(handshakeSigningSource).toContain("AgentScan Handshake v1");
  });
});
