/**
 * The never-interrupt exemption, enforced structurally.
 *
 * Owner decree: Stop aborts everything push-based within ~1 s, with exactly one
 * exception — a sign→broadcast→persist window runs to completion, always. A leg
 * that may already have moved funds must never lose its outcome to a Stop.
 *
 * A comment can be deleted; a signal that cannot be passed cannot be observed.
 * So the modules that own those windows take NO abort signal at all, and this
 * test fails the build the moment the identifier appears in one of them. It
 * pins a DECISION rather than an output, mirroring the `stream-aborted-delta`
 * source-level precedent.
 *
 * Adding a file here is cheap. REMOVING one is a money-path product decision:
 * see `reports/stop-cancellation.md` §1.C (the exact span of every signing
 * path) and §1.C.6 (why the post-broadcast receipt wait stays uninterruptible
 * even though it is technically recoverable).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Every module that owns a sign → broadcast → persist window. */
const NEVER_INTERRUPT_FILES = [
  "src/tools/evm-chains/staged-broadcast.ts",
  "src/tools/khalani/bridge-executor/leg-signing.ts",
  "src/tools/solana-ecosystem/shared/solana-transaction/staged.ts",
  "src/tools/solana-ecosystem/shared/solana-transaction/confirm.ts",
  "src/tools/solana-ecosystem/shared/solana-transaction/rpc-submit.ts",
  "src/tools/khalani/solana-signer.ts",
  "src/tools/uniswap/execute.ts",
  "src/vex-agent/tools/internal/wallet/send-execute-evm.ts",
] as const;

describe("never-interrupt windows", () => {
  it.each(NEVER_INTERRUPT_FILES)("%s references no abort signal", (relativePath) => {
    const source = readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
    expect(source).not.toMatch(/\bAbortSignal\b/);
    expect(source).not.toMatch(/\babortSignal\b/);
    expect(source).not.toMatch(/\bthrowIfAborted\b/);
  });
});
