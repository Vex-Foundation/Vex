/**
 * The deposit pin verdict (plan 15.6, authority table row "Deposit address
 * (app)"): funding is enabled ONLY when the address pinned in this build
 * equals the backend's `/v1/account` `deposit_address`, and is not open while
 * either side has none. Pure; the caller
 * reads both sides fresh. Compared case-insensitively, reported checksummed
 * as each side gave it.
 */

import type { VexCloudDepositPin } from "@shared/schemas/vex-cloud.js";

export function depositPinVerdict(pinned: string | null, backend: string | null): VexCloudDepositPin {
  // No address on EITHER side means deposits are not open yet: the backend
  // reports none exactly when it has no custody configured (it then answers
  // 503 `deposits_unavailable`), which is the same state as an empty pin.
  if (pinned === null || backend === null) return { state: "not_open" };
  if (backend !== null && backend.toLowerCase() === pinned.toLowerCase()) {
    return { state: "matches", address: pinned };
  }
  return { state: "mismatch", pinned, backend };
}
