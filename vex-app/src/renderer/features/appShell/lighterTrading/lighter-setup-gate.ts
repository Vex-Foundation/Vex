/**
 * The desk's access gate: whether entering the Lighter trading panel should
 * present account setup instead of a live ticket.
 *
 * The panel is only tradeable with a set-up trading key. `accountGap` is the
 * env-only read of why the account is unavailable (`useLighterTradingAccount`),
 * and ONLY a missing key gates setup:
 *
 *  - `not_onboarded`  → the vault is unlocked and holds no Lighter trading key
 *                       for this wallet: the one state setup fixes.
 *  - `locked_vault`   → the vault is the desk's own Unlock gate, not a missing
 *                       key (setup could not run against a locked vault anyway).
 *  - `ambiguous_account` → the desk's own Settings gate: several onboarded
 *                       accounts, so setup is not what is missing.
 *  - `null`           → the account is available (a key exists): trade freely.
 *
 * Provider errors surface as their own retryable account state, never a missing
 * key, so they are `null` here and never force setup.
 */

import type { LighterTradingAccountUnavailableReason } from "@shared/schemas/lighter-trading.js";

export function shouldPresentLighterSetup(
  accountGap: LighterTradingAccountUnavailableReason | null,
): boolean {
  return accountGap === "not_onboarded";
}
