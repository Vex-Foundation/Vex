/**
 * Khalani bridge handler - STAGED execute onto the Agent Scan `agent_activity`
 * contract (Phase-2 W3a; plan R2/R4/R5/R14-Q2/R15/C1/C2).
 *
 * The execute path records BEFORE it signs: `createBridgeActivityIntent` plans
 * every Vex-signed leg (allowances + the origin `bridge_deposit`) PLUS exactly
 * one logical `bridge_fill_expected` row (carrying the route endpoints, requested
 * amounts, USD estimates, and the quote/route ids) - all inside one transaction,
 * guarded by the DB in-flight index (C2). Then every leg follows the full staged
 * discipline (sign → persist hash CAS → broadcast → accept), the deposit hash is
 * submitted to Khalani, and the provider order id is CAS-attached to the logical
 * row. The in-turn order poll NEVER fabricates a `confirmed` fill: a provider
 * `filled` is left pending for the W4 sweep's independent RPC verification (R6/B4
 * - see the seam note below); only provider-terminal `failed`/`refunded` are
 * recorded (the conservative failure direction).
 *
 * VERIFICATION SEAM LEFT FOR W4: `confirmBridgeExpectedFill` requires an
 * independent RPC verification of the destination fill (B4). W4
 * (`sync/bridge-activity-repair.ts`) owns that checklist + SSRF-controlled RPC
 * fallback; W3a has no verified path, so it leaves the logical row pending and
 * the W4 sweep performs the verified confirm + balance enqueue.
 *
 * SOLANA: a Vex-signed Solana deposit stages its base58 signature in `tx_hash`
 * with `nonce NULL` (chain_family='solana') through the dedicated
 * `markActivitySolanaBroadcast` CAS (B1 nonce matrix) - wired by the
 * coordinator after W3a's original refusal (the primitive did not exist yet).
 * The `chain_family='solana'` CAS predicate keeps an EVM leg from ever staging
 * nonce-less (defense-in-depth at the DB layer). W5 (§2/R2b, migration 049)
 * extended that CAS to ALSO require `recent_blockhash`/`last_valid_block_height`
 * evidence in the SAME atomic write - `bridge-executor.ts`'s Solana leg now
 * signs via the shared `prepareVersionedTx` (STRICT sole-signer check + fresh
 * blockhash REPLACE), which the `onHashStaged` hook below threads into this
 * call.
 *
 * Internals split into siblings (Card C5, move-only, once this file crossed
 * the repo's 500-line cap): `bridge-support.ts` (agent-grade result shaping,
 * explorer-link/route-jargon helpers, the never-signed-leg abort/in-flight/
 * order-lookup primitives - shared by both siblings below), `bridge-poll.ts`
 * (the in-turn provider order-poll interpretation), `bridge-execute.ts` (the
 * `khalani.bridge` handler body itself, the 16 numbered steps). This file
 * stays the public gate - `BRIDGE_HANDLERS` is the only export.
 */

import type { ProtocolHandler } from "../../types.js";
import { executeKhalaniBridge } from "./bridge-execute.js";

export const BRIDGE_HANDLERS: Record<string, ProtocolHandler> = {
  "khalani.bridge": executeKhalaniBridge,
};
