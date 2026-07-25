/**
 * Cross-package contract test (W5 design REVISION 1 R1): the backend's
 * `SOLANA_SYNTHETIC_CHAIN_ID` (used by the `agent_activity` kind/family
 * binding CHECK, migration 049) and the desktop's `SOLANA_CHAIN_ID` (used to
 * render the chain switcher / balances) must be the SAME literal id. A
 * relative cross-package import is deliberate here — this file's only job is
 * to fail loudly the moment the two independently-maintained constants drift,
 * which a same-package import could never catch. `vex-app/.../display.ts` is
 * a dependency-free constants module (no React, no Node/Electron API), so
 * importing it from a root-package test has no boundary-crossing runtime
 * risk — it never happens outside this test file.
 */
import { describe, expect, it } from "vitest";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../constants/solana-chain.js";
import { SOLANA_CHAIN_ID as DESKTOP_SOLANA_CHAIN_ID } from "../../../vex-app/src/shared/chains/display.js";

describe("SOLANA_SYNTHETIC_CHAIN_ID — backend/desktop contract", () => {
  it("matches the desktop display constant exactly", () => {
    expect(SOLANA_SYNTHETIC_CHAIN_ID).toBe(DESKTOP_SOLANA_CHAIN_ID);
  });

  it("is the Khalani-originated Solana synthetic id (20011000000)", () => {
    expect(SOLANA_SYNTHETIC_CHAIN_ID).toBe(20_011_000_000);
  });
});
