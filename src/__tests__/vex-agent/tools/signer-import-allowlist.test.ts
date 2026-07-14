/**
 * Signer-import allowlist regression (puzzle 5 phase 5B).
 *
 * Pins the per-session wallet invariant at the source level:
 *   1. Only the un-migrated protocol signer files may import the zero-arg
 *      `requireEvmWallet/requireSolanaWallet/requireWalletForChain` primitives
 *      (which resolve the PRIMARY wallet, bypassing session scope). The runtime
 *      deny-guard blocks them under `source:"session"`; this test prevents a
 *      migrated tool (or a new tool) from silently re-introducing primary
 *      signing. The allowlist shrinks as 5D-protocols migrates each.
 *   2. The protocol manifest actionKind census stays within
 *      {read, user_wallet_broadcast, external_post}. The deny-guard covers the
 *      two signing kinds; a NEW signing kind would slip past it, so its
 *      appearance must force a deny-guard review (this test fails).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(process.cwd(), "src/vex-agent/tools");
const SIGNER_RE = /\b(requireEvmWallet|requireSolanaWallet|requireWalletForChain)\b/;

// Un-migrated protocol signers, hard-denied under source:"session" by the
// runtime guard. Paths relative to src/vex-agent/tools.
const ALLOWLIST = new Set<string>([
  // All in-tree protocol signers migrated to per-session resolution (5D p1-p3).
  // Khalani's signer is in src/tools/khalani/bridge-executor.ts (outside this walk
  // root); it is migrated in p4 and pinned by the src/tools/** scan in p5.
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function importsSigner(src: string): boolean {
  return src.split("\n").some((line) => {
    const t = line.trim();
    return t.startsWith("import") && SIGNER_RE.test(t);
  });
}

describe("signer import allowlist", () => {
  it("only allowlisted protocol files import zero-arg signer primitives", () => {
    const offenders: string[] = [];
    for (const file of walk(TOOLS_DIR)) {
      const rel = file.slice(TOOLS_DIR.length + 1).split("\\").join("/");
      if (importsSigner(readFileSync(file, "utf-8")) && !ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("migrated wallet tools no longer import signer primitives", () => {
    const migrated = [
      "internal/wallet/read.ts",
      "internal/wallet/send.ts",
      "internal/wallet/send-execute-evm.ts",
      "internal/wallet/send-execute-solana.ts",
      "protocols/khalani/handlers/read.ts",
      "protocols/kyberswap/handlers/swap.ts",
      "protocols/kyberswap/handlers/zap.ts",
      "protocols/kyberswap/handlers/limit-order.ts",
      "protocols/solana-jupiter/handlers/core.ts",
      "protocols/polymarket/handlers-clob.ts",
    ];
    for (const rel of migrated) {
      const src = readFileSync(join(TOOLS_DIR, rel), "utf-8");
      expect({ rel, imports: importsSigner(src) }).toEqual({ rel, imports: false });
    }
  });

  it("protocol manifest actionKinds stay within the deny-covered census", () => {
    // "local_write" reviewed for hyperliquid.risk.proposeSetup (HL Phase 4a):
    // writes a local session-policy proposal row only — no signing, no provider call.
    const allowedKinds = new Set(["read", "user_wallet_broadcast", "external_post", "local_write"]);
    const seen = new Set<string>();
    for (const file of walk(join(TOOLS_DIR, "protocols"))) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(/actionKind:\s*"([a-z_]+)"/g)) {
        seen.add(m[1]);
      }
    }
    const outside = [...seen].filter((k) => !allowedKinds.has(k));
    // The 5B deny-guard is gone (lifted in 5D-protocols p5), but a NEW signing
    // actionKind must still force a deliberate review here before it can reach
    // a handler.
    expect(outside).toEqual([]);
  });
});

// ── src/tools/** protocol-client signer scan (5D-protocols p5) ──────
// The shared protocol clients (khalani/bridge-executor, polymarket/clob/client,
// kyberswap, solana-ecosystem) must not resolve the zero-arg primary wallet
// either. `multi-auth.ts` DEFINES the primitives (export, not import) — the
// import-line check excludes it.
const SRC_TOOLS_DIR = join(process.cwd(), "src/tools");

describe("src/tools signer import scan", () => {
  it("no src/tools file imports the zero-arg signer primitives", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_TOOLS_DIR)) {
      if (importsSigner(readFileSync(file, "utf-8"))) {
        offenders.push(file.slice(SRC_TOOLS_DIR.length + 1).split("\\").join("/"));
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── Keystore/decrypt isolation in protocol paths (5D-protocols p5) ──
// Protocol code must reach signing material ONLY via the resolve helpers
// (resolveSigningWallet / resolveSelectedAddress in internal/wallet/resolve.ts).
// Direct imports of secret-loading / keystore / zero-arg-signer symbols are
// banned in protocol paths. Pure helpers (walletAddressesEqual, familyToInventory)
// and the `type ChainWallet` import are NOT secret-loading and stay allowed.
const PROTOCOL_PATHS = [
  "src/vex-agent/tools/protocols",
  "src/tools/khalani",
  "src/tools/polymarket",
  "src/tools/kyberswap",
  "src/tools/solana-ecosystem",
].map((p) => join(process.cwd(), p));

const BANNED_SIGNING_SYMBOLS = [
  "decryptPrivateKey", "decryptSecretBytes", "decryptSolanaSecretKey",
  "loadKeystore", "loadKeystoreFile", "loadSolanaKeystore",
  "loadEvmSecret", "loadSolanaSecret", "loadEvmKey",
  "loadWalletFromEntry",
  "requireEvmWallet", "requireSolanaWallet", "requireWalletForChain",
  "createEvmWalletEntry", "importEvmWalletEntry",
  "createSolanaWalletEntry", "importSolanaWalletEntry",
];
const BANNED_RE = new RegExp(`\\b(${BANNED_SIGNING_SYMBOLS.join("|")})\\b`);

describe("protocol-path keystore/decrypt isolation", () => {
  it("protocol code never imports secret-loading or zero-arg signer symbols", () => {
    const offenders: string[] = [];
    for (const root of PROTOCOL_PATHS) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue; // path absent — skip
      }
      for (const file of files) {
        const importLines = readFileSync(file, "utf-8")
          .split("\n")
          .filter((l) => l.trim().startsWith("import"));
        if (importLines.some((l) => BANNED_RE.test(l))) {
          offenders.push(file.slice(process.cwd().length + 1).split("\\").join("/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
