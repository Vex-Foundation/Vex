/**
 * Signing-oracle guard (Sprint 3 T10) - the trading keys sign exactly three
 * fixed message shapes anywhere in this codebase: the trench.express
 * `VEX-attest:` badge attestation, the pools.fun
 * `VEX-attest:v1:pools.fun:` badge attestation, and the AgentScan
 * `AgentScan Handshake v1` wallet-binding proof. A new signing call site
 * anywhere else is either a
 * duplicate signing oracle for an existing format (should reuse the owning
 * module) or an entirely new message shape (needs its own blast-radius
 * review, not a silent addition here). This is checked from three angles,
 * because any one alone is evadable:
 *   1. call-site scan — every raw signing call (`signMessage`, ed25519
 *      `sign`/`sign.detached`, `signTypedData`, `signTransaction`,
 *      `SigningKey`, …) must live in one of the two owning modules, or be a
 *      documented, named transaction-signing site (see
 *      `KNOWN_TRANSACTION_SIGNING_SITES` — a real transaction signature is
 *      not a signing-oracle concern; a text-message signature is);
 *   2. import exclusivity — only the owning module may import the other
 *      module's signing entry point, so a third module cannot produce one of
 *      these two signatures by calling through the owner instead of raw;
 *   3. reserved-string exclusivity — the literal wire-format strings
 *      themselves may not be duplicated into a second module, which would
 *      let that module build a byte-identical signable payload without ever
 *      matching pattern (1) or (2).
 *
 * Scans the whole `src/` tree (not just `src/vex-agent/`, unlike the sibling
 * tests in this directory), INCLUDING `scripts/`/`e2e/` subtrees (dropped
 * from the exclusion list — `src/vex-agent/scripts` alone ships 24 real
 * files that are as capable of holding a signing call as anything else) —
 * because the two allowed modules live on either side of the
 * `vex-agent`/`tools` boundary: `src/tools/wallet/handshake-signing.ts` and
 * `src/vex-agent/tools/protocols/trench/handlers/launch/execute/attribute.ts`.
 *
 * Uses a recursive readdir walk, NOT `git ls-files`: on this machine the repo
 * path contains a space, which breaks the `git ls-files`-based scanners the
 * sibling tests in this directory use (see their pre-existing, unrelated
 * failures). A plain fs walk has no such dependency.
 *
 * Patterns are matched against WHOLE-FILE text (comments stripped), not
 * line-by-line — a call split across lines (`foo.signMessage\n  (msg)`)
 * would evade a per-line scan but not this one, since `\s*` in the patterns
 * absorbs the embedded newline.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "src");

const EXCLUDED_DIR_NAMES = new Set(["__tests__", "node_modules"]);

const HANDSHAKE_SIGNING_MODULE = resolve(ROOT, "tools/wallet/handshake-signing.ts");
const HANDSHAKE_ORCHESTRATOR = resolve(ROOT, "vex-agent/agentscan/handshake.ts");
const TRENCH_ATTRIBUTION_SIGN_SITE = resolve(
  ROOT,
  "vex-agent/tools/protocols/trench/handlers/launch/execute/attribute.ts",
);
const TRENCH_ATTRIBUTION_MESSAGE_BUILDER = resolve(ROOT, "tools/trench-express/attribution.ts");

/**
 * The pools.fun badge lane, admitted 2026-08-23. It is a THIRD text-signing
 * site, not a reuse of the trench one, and deliberately so: both launchpads
 * live on chain 4663, so a shared `VEX-attest:<chainId>:<token>` string would
 * let a signature produced for one venue be replayed at the other. The pools
 * string is versioned and domain-bound (`VEX-attest:v1:pools.fun:<chainId>:
 * <token>`), and each literal stays pinned to its own owning module below.
 */
const POOLS_ATTRIBUTION_SIGN_SITE = resolve(
  ROOT,
  "vex-agent/tools/protocols/pools/handlers/launch/execute/attribute.ts",
);
const POOLS_ATTRIBUTION_MESSAGE_BUILDER = resolve(ROOT, "tools/pools-fun/attribution.ts");

const ALLOWED_SIGNING_MODULES = [
  HANDSHAKE_SIGNING_MODULE,
  TRENCH_ATTRIBUTION_SIGN_SITE,
  POOLS_ATTRIBUTION_SIGN_SITE,
];

/**
 * Real, on-chain TRANSACTION signing (`walletClient.signTransaction`,
 * `Transaction.sign(...)`) is the wallet's normal, expected function and is
 * outside this guard's concern — it cannot produce a `VEX-attest:` or
 * `AgentScan Handshake` TEXT-MESSAGE signature, because viem/web3.js's
 * transaction-signing entry points take a transaction/instruction object,
 * not an arbitrary string. Each entry here is a SPECIFIC, reviewed
 * (file, pattern) pair; a new pattern hit in one of these files that isn't
 * already named here still fails the guard. Bump this list — with
 * justification — only for a genuinely new transaction-signing call site.
 */
const KNOWN_TRANSACTION_SIGNING_SITES: ReadonlyArray<{ path: string; pattern: string }> = [
  { path: resolve(ROOT, "tools/evm-chains/staged-broadcast.ts"), pattern: "signTransaction" },
  { path: resolve(ROOT, "tools/khalani/bridge-executor/leg-signing.ts"), pattern: "signTransaction" },
  { path: resolve(ROOT, "tools/uniswap/execute.ts"), pattern: "signTransaction" },
];

const SIGNING_CALL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "signMessage (method or bare)", pattern: /\bsignMessage\s*\(/g },
  { name: "raw ed25519 sign.detached", pattern: /\.sign\.detached\s*\(/g },
  { name: "raw ed25519 sign (noble/curves-style)", pattern: /\bed25519\.sign\s*\(/g },
  { name: "signTypedData", pattern: /\bsignTypedData\s*\(/g },
  { name: "signTransaction", pattern: /\bsignTransaction\s*\(/g },
  { name: "ethers SigningKey", pattern: /\bSigningKey\b/g },
  // Unqualified `sign(...)` — e.g. tweetnacl's non-detached `sign`, or a
  // bare-imported signer called without a receiver. The negative lookbehind
  // excludes METHOD calls (`transaction.sign(keypair)`, `tx.sign(signers)`,
  // `Math.sign(x)`), which are a different, legitimate concern (transaction
  // signing / arithmetic) already covered — or explicitly not covered —
  // elsewhere in this file. No `\s*` before the paren (unlike the other
  // patterns): real call syntax never inserts a space there, and allowing
  // one made this match English prose like "...transaction to sign (found
  // ...)" in unrelated error messages.
  { name: "bare sign(...)", pattern: /(?<!\.)\bsign\(/g },
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

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function snippetAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEndIndex = text.indexOf("\n", index);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  return text.slice(lineStart, lineEnd).trim().slice(0, 120);
}

interface SigningCallSite {
  readonly line: number;
  readonly pattern: string;
  readonly snippet: string;
}

/**
 * Pure — no filesystem access — so the meta-test below can feed it
 * hand-built evasion fixtures directly, and the real scan can feed it file
 * contents. Whole-file matching (not per-line): see module doc.
 */
function scanTextForSigningCallSites(text: string): SigningCallSite[] {
  const hits: SigningCallSite[] = [];
  for (const { name, pattern } of SIGNING_CALL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      hits.push({ line: lineNumberAt(text, index), pattern: name, snippet: snippetAt(text, index) });
    }
  }
  return hits;
}

function findSigningCallSites(files: string[]): Array<SigningCallSite & { path: string }> {
  const hits: Array<SigningCallSite & { path: string }> = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf-8"));
    for (const hit of scanTextForSigningCallSites(code)) {
      hits.push({ path: file, ...hit });
    }
  }
  return hits;
}

function isAllowedCallSite(hit: { path: string; pattern: string }): boolean {
  if (ALLOWED_SIGNING_MODULES.includes(hit.path)) return true;
  return KNOWN_TRANSACTION_SIGNING_SITES.some(
    (site) => site.path === hit.path && site.pattern === hit.pattern,
  );
}

/** Every file (excluding the allowed ones) that contains `needle` in its comment-stripped code. */
function findExclusivityViolations(
  files: string[],
  needle: string,
  allowedFiles: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (allowedFiles.includes(file)) continue;
    const code = stripComments(readFileSync(file, "utf-8"));
    if (code.includes(needle)) violations.push(file);
  }
  return violations;
}

/** Same as above but over RAW text (comments included) — reserved wire-format strings must not appear ANYWHERE else, not even in a comment. */
function findRawStringViolations(
  files: string[],
  needle: string,
  allowedFiles: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (allowedFiles.includes(file)) continue;
    if (readFileSync(file, "utf-8").includes(needle)) violations.push(file);
  }
  return violations;
}

describe("signing-oracle guard — only the named modules may produce VEX-attest / AgentScan Handshake signatures", () => {
  it("no signing call site exists outside the two allowed modules or the documented transaction-signing allowlist", () => {
    const files = listTsFiles(ROOT);
    expect(files.length, "no source files discovered — readdir walk broken?").toBeGreaterThan(0);

    const hits = findSigningCallSites(files);
    const disallowed = hits.filter((hit) => !isAllowedCallSite(hit));

    if (disallowed.length > 0) {
      const detail = disallowed
        .map((hit) => `  ${hit.path}:${hit.line} [${hit.pattern}] ${hit.snippet}`)
        .join("\n");
      throw new Error(
        `signing-oracle policy violated — a signing call site exists outside the allowed modules:\n${detail}\n` +
          `Allowed modules:\n  ${ALLOWED_SIGNING_MODULES.join("\n  ")}\n` +
          `Documented transaction-signing sites:\n  ${KNOWN_TRANSACTION_SIGNING_SITES.map((s) => `${s.path} [${s.pattern}]`).join("\n  ")}`,
      );
    }
    expect(disallowed).toEqual([]);
  });

  it("both allowed modules actually contain a signing call site (the allowlist is not vacuous)", () => {
    for (const file of ALLOWED_SIGNING_MODULES) {
      const code = stripComments(readFileSync(file, "utf-8"));
      expect(scanTextForSigningCallSites(code).length, `${file} was expected to contain a signing call site`).toBeGreaterThan(0);
    }
  });

  it("ties each allowed signing call site to the one message format it is permitted to produce", () => {
    const attributeSource = readFileSync(TRENCH_ATTRIBUTION_SIGN_SITE, "utf-8");
    expect(attributeSource).toContain("buildAttestMessage");

    const attributionSource = readFileSync(TRENCH_ATTRIBUTION_MESSAGE_BUILDER, "utf-8");
    expect(attributionSource).toContain("VEX-attest:");

    const poolsAttributeSource = readFileSync(POOLS_ATTRIBUTION_SIGN_SITE, "utf-8");
    expect(poolsAttributeSource).toContain("buildPoolsAttestMessage");

    const poolsAttributionSource = readFileSync(POOLS_ATTRIBUTION_MESSAGE_BUILDER, "utf-8");
    expect(poolsAttributionSource).toContain("VEX-attest:v1:pools.fun:");

    const handshakeSigningSource = readFileSync(HANDSHAKE_SIGNING_MODULE, "utf-8");
    expect(handshakeSigningSource).toContain("AgentScan Handshake v1");
  });

  it("only the orchestrator may import handshake-signing.js; only the trench sign site may import buildAttestMessage", () => {
    const files = listTsFiles(ROOT);

    const handshakeSigningImporters = findExclusivityViolations(files, "handshake-signing", [
      HANDSHAKE_SIGNING_MODULE,
      HANDSHAKE_ORCHESTRATOR,
    ]);
    expect(
      handshakeSigningImporters,
      `only ${HANDSHAKE_ORCHESTRATOR} may import handshake-signing.js`,
    ).toEqual([]);

    const buildAttestMessageImporters = findExclusivityViolations(files, "buildAttestMessage", [
      TRENCH_ATTRIBUTION_MESSAGE_BUILDER,
      TRENCH_ATTRIBUTION_SIGN_SITE,
    ]);
    expect(
      buildAttestMessageImporters,
      `only ${TRENCH_ATTRIBUTION_SIGN_SITE} may import buildAttestMessage`,
    ).toEqual([]);

    const buildPoolsAttestMessageImporters = findExclusivityViolations(
      files,
      "buildPoolsAttestMessage",
      [POOLS_ATTRIBUTION_MESSAGE_BUILDER, POOLS_ATTRIBUTION_SIGN_SITE],
    );
    expect(
      buildPoolsAttestMessageImporters,
      `only ${POOLS_ATTRIBUTION_SIGN_SITE} may import buildPoolsAttestMessage`,
    ).toEqual([]);
  });

  it("the reserved wire-format literals appear only in their owning modules (not even duplicated into a comment elsewhere)", () => {
    const files = listTsFiles(ROOT);

    const handshakeLiteralElsewhere = findRawStringViolations(files, "AgentScan Handshake v1", [
      HANDSHAKE_SIGNING_MODULE,
    ]);
    expect(handshakeLiteralElsewhere).toEqual([]);

    // `VEX-attest:` is a PREFIX of the pools literal, so the pools builder is
    // admitted here too. The narrower check below is what actually pins the
    // pools string to one module: without it, admitting the pools builder for
    // the shared prefix would also let it hold the bare trench form.
    const attestLiteralElsewhere = findRawStringViolations(files, "VEX-attest:", [
      TRENCH_ATTRIBUTION_MESSAGE_BUILDER,
      POOLS_ATTRIBUTION_MESSAGE_BUILDER,
    ]);
    expect(attestLiteralElsewhere).toEqual([]);

    const poolsAttestLiteralElsewhere = findRawStringViolations(
      files,
      "VEX-attest:v1:pools.fun:",
      [POOLS_ATTRIBUTION_MESSAGE_BUILDER],
    );
    expect(poolsAttestLiteralElsewhere).toEqual([]);

    // The bare trench form must NOT appear in the pools builder: the pools
    // module may only ever build the versioned, domain-bound string, and the
    // whole point of the split is that neither venue can produce the other's
    // signable bytes.
    const trenchFormInPoolsBuilder = readFileSync(POOLS_ATTRIBUTION_MESSAGE_BUILDER, "utf-8")
      .includes("VEX-attest:${");
    expect(
      trenchFormInPoolsBuilder,
      "the pools builder must not interpolate the bare `VEX-attest:<...>` trench form",
    ).toBe(false);
  });

  it("catches known evasion forms in fixture strings (meta-test — proves the scan logic, not just today's file set)", () => {
    const evasions: ReadonlyArray<{ label: string; code: string }> = [
      { label: "split method call (newline before the paren)", code: 'walletClient.signMessage\n  ({ message: "x" });' },
      { label: "bare unqualified signMessage call (no receiver)", code: 'signMessage({ message: "x" });' },
      { label: "bare tweetnacl sign (non-detached)", code: "sign(message, secretKey);" },
      { label: "ethers SigningKey reference", code: "const key = new SigningKey(privateKey);" },
      { label: "signTypedData call", code: "await walletClient.signTypedData(typedData);" },
      { label: "signTransaction call", code: "await walletClient.signTransaction(request);" },
    ];
    for (const { label, code } of evasions) {
      expect(scanTextForSigningCallSites(code).length, `expected to catch: ${label}`).toBeGreaterThan(0);
    }

    // Negative control: the scan must NOT flag ordinary transaction-object
    // method calls or Math.sign — otherwise every legitimate broadcast path
    // would need allowlisting, which defeats the guard's signal.
    const benign = ["transaction.sign(keypair);", "tx.sign(signers);", "Math.sign(x);"];
    for (const code of benign) {
      expect(scanTextForSigningCallSites(code)).toEqual([]);
    }
  });
});
