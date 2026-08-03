/**
 * Cross-package contract test (W5 design REVISION 1 R1): the backend's
 * `SOLANA_SYNTHETIC_CHAIN_ID` (used by the `agent_activity` kind/family
 * binding CHECK, migration 049) and the desktop's `SOLANA_CHAIN_ID` (used to
 * render the chain switcher / balances) must be the SAME literal id.
 *
 * The desktop constant CANNOT be imported: `vex-app/src/**` lies outside this
 * package's tsconfig `rootDir`, so a relative import compiles only by
 * accident and fails the typecheck (TS6059). The mirror is therefore read as
 * TEXT and its literal extracted — the same deliberately crude, deliberately
 * unskippable technique `mission-run-status-vocabulary-drift.test.ts` already
 * uses for the other hand-mirrored cross-package vocabularies. It needs no
 * build graph, respects the process boundary, and still fails loudly the
 * moment the two independently-maintained constants drift.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../constants/solana-chain.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DISPLAY_MODULE = "vex-app/src/shared/chains/display.ts";

function readDesktopSolanaChainId(): number {
  const source = readFileSync(resolve(REPO_ROOT, DISPLAY_MODULE), "utf8");
  const match = /export const SOLANA_CHAIN_ID = ([0-9_]+)\s*;/.exec(source);
  if (!match?.[1]) {
    throw new Error(`SOLANA_CHAIN_ID literal not found in ${DISPLAY_MODULE}`);
  }
  return Number(match[1].replaceAll("_", ""));
}

describe("SOLANA_SYNTHETIC_CHAIN_ID — backend/desktop contract", () => {
  it("matches the desktop display constant exactly", () => {
    expect(SOLANA_SYNTHETIC_CHAIN_ID).toBe(readDesktopSolanaChainId());
  });

  it("is the Khalani-originated Solana synthetic id (20011000000)", () => {
    expect(SOLANA_SYNTHETIC_CHAIN_ID).toBe(20_011_000_000);
  });
});
