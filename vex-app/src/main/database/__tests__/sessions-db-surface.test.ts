/**
 * Façade surface lock for `sessions-db.ts`.
 *
 * `sessions-db.ts` was split into `./sessions/*` sibling modules and now
 * re-exports the identical public surface. This test pins that surface so a
 * future structural change cannot silently drop, rename, or re-type an export
 * that the IPC layer (`ipc/chat.ts`, `ipc/wallets-session.ts`,
 * `ipc/sessions/*`) imports from the old path.
 *
 * It asserts:
 *   - every expected runtime export is present with the correct `typeof`,
 *   - the EXACT set of runtime export keys (no extras, none missing),
 *   - the type-only export (`SessionWalletScopeRow`) still compiles when
 *     imported as a type.
 */

import { describe, expect, it } from "vitest";
import * as sessionsDb from "../sessions-db.js";
// Type-only import: must compile. `SessionWalletScopeRow` is an interface and
// therefore is NOT a runtime export key.
import type { SessionWalletScopeRow } from "../sessions-db.js";

// Compile-time assertion that the type export resolves to its shape.
type _AssertWalletScopeShape = SessionWalletScopeRow["evm"];

const EXPECTED_FUNCTION_EXPORTS = [
  "createSessionWithClient",
  "createSession",
  "getSessionWalletScope",
  "initializeSessionWalletScopeWithClient",
  "initializeSessionWalletScope",
  "setInitialMissionGoalIfUnset",
  "getSessionById",
  "listSessions",
  "getSessionExportMessages",
  "softDeleteSessionWithClient",
  "softDeleteSession",
  "setSessionPinnedWithClient",
  "setSessionPinned",
] as const;

describe("sessions-db façade surface", () => {
  it("exposes every expected function export with typeof === 'function'", () => {
    for (const key of EXPECTED_FUNCTION_EXPORTS) {
      expect(typeof (sessionsDb as Record<string, unknown>)[key]).toBe("function");
    }
  });

  it("exposes EXACTLY the expected runtime export keys", () => {
    const runtimeKeys = Object.keys(sessionsDb).sort();
    expect(runtimeKeys).toEqual([...EXPECTED_FUNCTION_EXPORTS].sort());
  });
});
