/**
 * Every production local EVM signature must pass through the durable nonce
 * allocator. This inventory is intentionally closed: a new direct signer is a
 * security review event, not an implementation detail.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");
const SOURCE_ROOTS = [resolve(ROOT, "src", "tools"), resolve(ROOT, "src", "vex-agent", "tools")];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function repoPath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

const DIRECT_SIGN_PATTERN = /\.(?:signTransaction|writeContract|sendTransaction)\s*\(/;

describe("local EVM nonce allocation boundary", () => {
  it("keeps the direct-signing file inventory closed", () => {
    const direct = SOURCE_ROOTS
      .flatMap(sourceFiles)
      .filter((file) => DIRECT_SIGN_PATTERN.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .sort();

    expect(direct).toEqual([
      "src/tools/evm-chains/staged-broadcast.ts",
      "src/tools/khalani/bridge-executor/leg-signing.ts",
      "src/tools/kyberswap/evm/erc20.ts",
      "src/tools/kyberswap/evm/nft.ts",
      "src/tools/uniswap/execute.ts",
    ]);
  });

  it("binds every reachable signing seam to live ownership and durable reservation", () => {
    const required = [
      ["src/tools/evm-chains/staged-broadcast.ts", "onNonceReserved"],
      ["src/tools/khalani/bridge-executor/leg-signing.ts", "onNonceReserved"],
      ["src/tools/uniswap/execute.ts", "reserveNonce"],
    ] as const;
    for (const [file, reservationSeam] of required) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      expect(source, file).toContain("acquireEvmNonceOwner(");
      expect(source, file).toContain(reservationSeam);
    }
  });

  it("keeps obsolete direct Kyber helpers unreachable from the production barrel", () => {
    const barrel = readFileSync(resolve(ROOT, "src/tools/kyberswap/evm-utils.ts"), "utf8");
    expect(barrel).not.toContain("sendKyberTransactionWithReceipt");
    expect(barrel).not.toContain("ensureErc721Approval");
    expect(barrel).not.toContain("ensureErc1155ApprovalForAll");
  });

  it("rejects every production reference to an obsolete direct Kyber signer", () => {
    const obsoleteFiles = new Set([
      "src/tools/kyberswap/evm/erc20.ts",
      "src/tools/kyberswap/evm/nft.ts",
    ]);
    const obsoleteExports = [
      "sendKyberTransactionWithReceipt",
      "ensureErc721Approval",
      "ensureErc1155ApprovalForAll",
    ];
    const offenders: string[] = [];
    for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
      const path = repoPath(file);
      if (obsoleteFiles.has(path)) continue;
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const exportedName of obsoleteExports) {
        if (new RegExp(`\\b${exportedName}\\b`).test(source)) {
          offenders.push(`${path} references ${exportedName}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("requires every production signStageBroadcast call site to supply the reservation hook", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
      const path = repoPath(file);
      if (path === "src/tools/evm-chains/staged-broadcast.ts") continue;
      const source = readFileSync(file, "utf8");
      let offset = source.indexOf("signStageBroadcast(");
      while (offset >= 0) {
        const callPrefix = source.slice(offset, offset + 1_500);
        if (!callPrefix.includes("onNonceReserved") && !callPrefix.includes("staging.hooks")) {
          offenders.push(path);
        }
        offset = source.indexOf("signStageBroadcast(", offset + 1);
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it("keeps durable nonce repair read-side only", () => {
    const source = readFileSync(
      resolve(ROOT, "src/vex-agent/db/repos/evm-nonce-reservations.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\.(?:sendRawTransaction|sendTransaction|writeContract|signTransaction)\s*\(/);
    expect(source).not.toContain("serializedTransaction");
  });
});
