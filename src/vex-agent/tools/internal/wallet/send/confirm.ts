/**
 * Wallet send - `WalletSendConfirm`. Gates a prepared intent on
 * session-ownership / status / expiry / approval, resolves AND decrypts the
 * session's signing wallet only AFTER the approval gate, asserts it matches
 * the intent's recorded wallet BEFORE consuming, CAS-consumes atomically, and
 * runs exactly one executor branch. Signing authority stays session-scoped via
 * `resolveSigningWallet` + address match; key material is never logged.
 */

import { walletAddressesEqual } from "@tools/wallet/inventory.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import * as walletIntentsRepo from "@vex-agent/db/repos/wallet-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";

import { executeEvmTransfer } from "../send-execute-evm.js";
import { executeSolanaTransfer } from "../send-execute-solana.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "../resolve.js";
import { type ExecuteOutcome } from "../send-types.js";
import { fail } from "./results.js";
import { finalizeOutcome } from "./finalize.js";
import { validateConfirmParams } from "./validation.js";

// ── WalletSendConfirm ─────────────────────────────────────────────────

export async function handleWalletSendConfirm(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const validated = validateConfirmParams(params);
  if (!validated.ok) {
    return validated.result;
  }
  const { network, intentId } = validated.values;

  // Session-scoped lookup - cross-session intentId yields null (Codex
  // puzzle-5 phase-4 review point 3).
  const intent = await walletIntentsRepo.getById(intentId, context.sessionId);
  if (!intent) {
    return fail(`Intent not found: ${intentId}.`);
  }

  if (intent.network !== network) {
    return fail(
      `Network mismatch: intent is ${intent.network}, got ${network}`,
    );
  }

  if (intent.status !== "pending") {
    return fail(`Intent ${intentId} is ${intent.status} - cannot consume.`);
  }

  if (new Date(intent.expiresAt) <= new Date()) {
    return fail(`Intent expired at ${intent.expiresAt}.`);
  }

  // Approval gate - UNCHANGED from pre-phase-4. Intent stays `pending`
  // for the approval-then-retry cycle; the same row is consumed on the
  // second dispatch after the operator approves.
  if (!context.approved && context.sessionPermission === "restricted") {
    return {
      success: false,
      output:
        "Transfer requires approval under restricted permission. Use the approval flow to confirm.",
      pendingApproval: true,
    };
  }

  // Resolve the session's signing wallet AFTER the approval gate, and assert it
  // matches the intent's recorded wallet BEFORE consuming. A mismatch (selection
  // drift / bug) fails closed WITHOUT mutating the intent - it stays `pending`
  // and expires; no markFailed (which requires `consuming`). Codex 5B review.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, network);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  const invFamily = network === "solana" ? "solana" : "evm";
  if (!walletAddressesEqual(invFamily, signer.address, intent.walletAddress)) {
    return fail("Selected wallet does not match this intent's wallet. Re-prepare the transfer.");
  }

  // CAS-consume atomically; race losers get null.
  //
  // Under the session control lock, in a DB-ONLY transaction that COMMITS
  // before the signing calls below. The lock makes this claim serialize with
  // the compaction safe-moment gate: either the gate saw this row as
  // `consuming` and deferred the cutover, or this claim landed strictly after
  // the cutover committed. Holding the lock across `executeEvmTransfer` /
  // `executeSolanaTransfer` would block the operator's Stop - the exact
  // inversion the lock exists to prevent (session-control-lock.ts, hold
  // duration).
  const claimed = await withSessionControlLock(context.sessionId, (client) =>
    walletIntentsRepo.consumeIfPendingWith(client, intentId, context.sessionId),
  );
  if (!claimed) {
    const cur = await walletIntentsRepo.getById(intentId, context.sessionId);
    return fail(
      `Cannot consume intent ${intentId}: status=${cur?.status ?? "unknown"}.`,
    );
  }

  let outcome: ExecuteOutcome;
  if (network === "solana") {
    if (signer.family !== "solana") return fail("Resolved wallet family mismatch.");
    outcome = await executeSolanaTransfer(claimed, signer);
  } else {
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
    outcome = await executeEvmTransfer(claimed, signer);
  }

  return finalizeOutcome(intentId, context.sessionId, outcome);
}
