/**
 * Surface pin for the Khalani `balances.ts` barrel after the concern-grouped
 * structural split into `balances/` (types / selection / scan / aggregate, with
 * shared private helpers in `_shared.ts`).
 *
 * Guards the PUBLIC export surface against drift:
 * - the exact 4-key RUNTIME-VALUE set + the `typeof` of each (all functions);
 * - the 3 TYPE-ONLY exports (erased at runtime) via a compile-only type
 *   assertion below — `tsc` fails if any is dropped or its shape regresses.
 *
 * The split is behaviour-preserving; equivalence is covered by the existing
 * khalani balance/validation behaviour tests.
 */

import { describe, expect, it } from "vitest";
import * as barrel from "@tools/khalani/balances.js";
import type {
  BalanceChainError,
  BalanceChainSelection,
  TokenBalanceScanResult,
} from "@tools/khalani/balances.js";

// ── Exact runtime-value key pin ─────────────────────────────────────

const EXPECTED_KEYS = [
  "calculateTokensTotalUsd",
  "getSelectedChainIdsForFamily",
  "getTokenBalancesAcrossChains",
  "parseBalanceChainSelection",
] as const;

describe("khalani balances barrel surface", () => {
  it("exposes exactly the expected 4 runtime exports", () => {
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_KEYS]);
  });

  it("every runtime export is a function", () => {
    for (const key of Object.keys(barrel)) {
      expect(typeof (barrel as Record<string, unknown>)[key]).toBe("function");
    }
  });

  // ── Type-only exports (erased at runtime; verified by `tsc`) ───────
  it("re-exports the 3 type-only interfaces", () => {
    // Compile-only assertions: these reference the type-only exports so the
    // build fails if any is removed. They contribute no runtime behaviour.
    const _err = {
      chainId: 1,
      message: "x",
    } satisfies BalanceChainError;
    const _selection = {
      rawProvided: false,
      byFamily: new Map(),
    } satisfies BalanceChainSelection;
    const _scan = {
      address: "0x0",
      family: "eip155",
      tokens: [],
      scannedChainIds: [],
      chainErrors: [],
      totalUsd: 0,
      rejectedEntries: [],
    } satisfies TokenBalanceScanResult;
    expect([_err, _selection, _scan]).toHaveLength(3);
  });
});
