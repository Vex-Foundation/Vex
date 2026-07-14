/**
 * Vex-treasury: token buyback and burn. Public, receive-only addresses — not
 * secrets. Swap-integrator fees accrue here and fund VEX buyback+burn.
 *
 * Pure constants only. This file is the @vex-lib alias target consumed by
 * vex-app, so it must never import Node/Electron-privileged code — the values
 * below are public destination addresses, safe to ship in the renderer bundle.
 */

import type { Address } from "viem";

/** EVM treasury — the integrator-fee `feeReceiver` for aggregator swaps. */
export const VEX_TREASURY_EVM: Address =
  "0xe341f3da256C38356bce4Afd456d7fa36E356E94";

/**
 * Solana treasury — the documented future Jupiter referral-fee owner. Base58
 * address (not an EVM `Address`). Currently unused in code; kept here so the
 * treasury pair is documented in one place alongside its EVM counterpart.
 */
export const VEX_TREASURY_SOLANA =
  "EvA1d9zMBXKFVXjSUFyHphiKUpwHJcLfZfmUH9GCd1sX";
