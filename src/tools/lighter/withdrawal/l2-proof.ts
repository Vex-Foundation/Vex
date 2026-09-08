import type {
  LighterTxFromL1Response,
  LighterWithdrawHistoryItem,
} from "../types.js";
import { decimalToBaseUnits } from "../wallet-funding/onboarding-plan.js";
import { ErrorCodes, VexError } from "../../../errors.js";

export interface LighterCoreWithdrawalL2Evidence {
  readonly hash: string;
  readonly status: number;
  readonly executed: boolean;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly assetIndex: 3;
  readonly routeType: 0;
  readonly amountUnits: string;
  readonly blockHeight: string;
  readonly executedAt: string;
  readonly verifiedAt: string;
}

export function proveLighterCoreWithdrawalL2Transaction(input: {
  readonly tx: LighterTxFromL1Response;
  readonly expectedHash: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly amountUnits: string;
}): LighterCoreWithdrawalL2Evidence {
  const { tx } = input;
  if (
    tx.code !== 200
    || tx.hash !== input.expectedHash
    || tx.type !== 13
    || tx.account_index !== input.accountIndex
    || tx.api_key_index !== input.apiKeyIndex
    || String(tx.nonce) !== canonicalDecimal(input.nonce, true, "nonce")
  ) throw invalid("Lighter transaction evidence does not match the submitted Core withdrawal identity.");
  const info = exactIntegerFields(tx.info, [
    "FromAccountIndex", "ApiKeyIndex", "AssetIndex", "RouteType", "Amount", "ExpiredAt", "Nonce",
  ]);
  const amountUnits = canonicalDecimal(input.amountUnits, false, "amount");
  if (
    info.FromAccountIndex !== String(input.accountIndex)
    || info.ApiKeyIndex !== String(input.apiKeyIndex)
    || info.AssetIndex !== "3"
    || info.RouteType !== "0"
    || info.Amount !== amountUnits
    || info.Nonce !== canonicalDecimal(input.nonce, true, "nonce")
    || info.ExpiredAt !== String(tx.expire_at)
  ) throw invalid("Lighter transaction info does not preserve the approved TxType 13 fields.");
  if (!Number.isInteger(tx.status) || tx.status < 0) throw invalid("Lighter returned an invalid withdrawal transaction status.");
  return {
    hash: tx.hash,
    status: tx.status,
    executed: tx.status === 3,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    expiredAt: info.ExpiredAt,
    assetIndex: 3,
    routeType: 0,
    amountUnits,
    blockHeight: String(tx.block_height),
    executedAt: String(tx.executed_at),
    verifiedAt: String(tx.verified_at),
  };
}

export function selectLighterCoreWithdrawalHistory(input: {
  readonly rows: readonly LighterWithdrawHistoryItem[];
  readonly existingHistoryId: string | null;
  readonly amountUnits: string;
  readonly notBefore: Date;
}): LighterWithdrawHistoryItem | null {
  const amountUnits = canonicalDecimal(input.amountUnits, false, "amount");
  if (!Number.isFinite(input.notBefore.getTime())) throw invalid("Withdrawal history lower-bound time is invalid.");
  if (input.existingHistoryId !== null) {
    const exact = input.rows.filter((row) => row.id === input.existingHistoryId);
    if (exact.length > 1) throw invalid("Lighter returned duplicate rows for the adopted withdrawal history id.");
    const row = exact[0];
    if (row === undefined) return null;
    assertHistoryIdentity(row, amountUnits);
    return row;
  }
  const lowerBound = input.notBefore.getTime() - 5 * 60_000;
  const candidates = input.rows.filter((row) => {
    try {
      assertHistoryIdentity(row, amountUnits);
      return providerTimestampMs(row.timestamp) >= lowerBound;
    } catch {
      return false;
    }
  });
  if (candidates.length > 1) {
    throw invalid("Multiple Core withdrawal history rows match the submitted amount and time window.");
  }
  return candidates[0] ?? null;
}

export function publicWithdrawalHistoryEvidence(row: LighterWithdrawHistoryItem): Record<string, unknown> {
  return {
    id: row.id,
    amount: row.amount,
    timestamp: row.timestamp,
    status: row.status,
    type: row.type,
    l1TxHash: row.l1_tx_hash,
    assetId: row.asset_id,
  };
}

function assertHistoryIdentity(row: LighterWithdrawHistoryItem, amountUnits: string): void {
  let observed: bigint;
  try {
    observed = decimalToBaseUnits(row.amount, 6);
  } catch {
    throw invalid("Lighter withdrawal history returned an invalid amount.");
  }
  if (
    row.type !== "secure"
    || row.asset_id !== 3
    || observed.toString(10) !== amountUnits
  ) throw invalid("Lighter withdrawal history row does not match Core USDC secure withdrawal identity.");
}

function providerTimestampMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid("Lighter withdrawal history timestamp is invalid.");
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function exactIntegerFields(rawJson: string, keys: readonly string[]): Record<string, string> {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw invalid("Lighter transaction info is not valid JSON.");
  }
  const result: Record<string, string> = {};
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...rawJson.matchAll(new RegExp(`"${escaped}"\\s*:\\s*(\\d+)`, "g"))];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
      throw invalid(`Lighter transaction info does not contain exactly one integer ${key} field.`);
    }
    result[key] = canonicalDecimal(matches[0][1], true, key);
  }
  return result;
}

function canonicalDecimal(value: string, allowZero: boolean, field: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || (!allowZero && BigInt(trimmed) === 0n)) {
    throw invalid(`Core withdrawal ${field} is invalid.`);
  }
  return BigInt(trimmed).toString(10);
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Keep the withdrawal unresolved and reconcile exact provider evidence before any retry.",
  );
}
