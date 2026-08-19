/**
 * Khalani deposit-plan validator (codex-002 Phase 2).
 *
 * `validateDepositPlan` / `parseApproval` form the riskiest part of the wire
 * surface: a discriminated union by `kind` (CONTRACT_CALL / PERMIT2 / TRANSFER)
 * and an approval union by `type` (eip1193_request / solana_sendTransaction).
 * Moved VERBATIM from `validation.ts` — exact field-path error messages, exact
 * discriminator order, exact coercions, because these values become EVM/Solana
 * approvals fed to transaction signing.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import type { Approval, DepositPlan } from "../types.js";
import {
  asNumber,
  asOptionalString,
  asString,
  isRecordValue,
  parseOrThrow,
} from "./_shared.js";

// ---------------------------------------------------------------------------
// Deposit plan (discriminated union by `kind`)
// ---------------------------------------------------------------------------

function parseApproval(item: unknown, idx: number): Approval {
  if (!isRecordValue(item)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, `Invalid Khalani response: approval[${idx}] must be an object`);
  }
  const type = parseOrThrow(asString(`approval[${idx}].type`), item.type);
  if (type === "eip1193_request") {
    const request = isRecordValue(item.request) ? item.request : {};
    return {
      type,
      request: {
        method: parseOrThrow(asString(`approval[${idx}].request.method`), request.method),
        params: Array.isArray(request.params) ? request.params : undefined,
      },
      waitForReceipt: item.waitForReceipt === true ? true : undefined,
      deposit: item.deposit === true ? true : undefined,
    };
  }
  if (type === "solana_sendTransaction") {
    return {
      type,
      transaction: parseOrThrow(asString(`approval[${idx}].transaction`), item.transaction),
      deposit: item.deposit === true ? true : undefined,
    };
  }
  throw new VexError(ErrorCodes.KHALANI_API_ERROR, `Invalid Khalani response: unsupported approval type ${type}`);
}

export function validateDepositPlan(raw: unknown): DepositPlan {
  if (!isRecordValue(raw)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected deposit plan");
  }

  const kind = parseOrThrow(asString("deposit.kind"), raw.kind);
  if (kind === "CONTRACT_CALL") {
    const approvals = Array.isArray(raw.approvals)
      ? raw.approvals.map((item, idx) => parseApproval(item, idx))
      : [];
    return { kind, approvals };
  }
  if (kind === "PERMIT2") {
    if (!isRecordValue(raw.permit) || !isRecordValue(raw.transferDetails)) {
      throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: malformed PERMIT2 plan");
    }
    return {
      kind,
      permit: raw.permit,
      transferDetails: raw.transferDetails,
    };
  }
  if (kind === "TRANSFER") {
    const transfer = parseOrThrow(
      z.object({
        depositAddress: asString("deposit.depositAddress"),
        amount: asString("deposit.amount"),
        token: asString("deposit.token"),
        chainId: asNumber("deposit.chainId"),
        memo: asOptionalString,
        expiresAt: z.unknown().optional().transform((v) => (typeof v === "number" ? v : undefined)),
      }),
      raw,
    );
    return {
      kind,
      depositAddress: transfer.depositAddress,
      amount: transfer.amount,
      token: transfer.token,
      chainId: transfer.chainId,
      memo: transfer.memo,
      expiresAt: transfer.expiresAt,
    };
  }

  throw new VexError(ErrorCodes.KHALANI_API_ERROR, `Invalid Khalani response: unsupported deposit kind ${kind}`);
}
