/**
 * The user's Lighter trading limits, per (environment, wallet).
 *
 * PREFERENCE, NOT AUTHORITY. The agent reads the capital share as information;
 * the privileged executor is what enforces it. Nothing here approves an order.
 *
 * Writes are compare-and-set on `revision`, the pattern the onboarding
 * workflows already use and the one `deepseek-harness`'s settings seam proves
 * out (`packages/settings/settings/tests/settings.spec.ts`, "refuses a write
 * whose expected revision is stale, leaving the winner in place"):
 *
 *  - the FIRST write requires `expectedRevision: null` and fails if a row
 *    already exists;
 *  - every later write requires the row's current revision;
 *  - a deep-equal write with a STALE revision still fails, because the editor
 *    holding it has not seen what the winner stored and must be told;
 *  - a deep-equal write with the CURRENT revision returns the row unchanged and
 *    does not move the revision, so an idle Save does not invalidate another
 *    editor's token.
 */

import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import { queryOne } from "../client.js";

export interface LighterTradingLimitsRow {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly agentCapitalSharePercent: number | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface WriteLighterTradingLimitsInput {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly agentCapitalSharePercent: number | null;
  readonly expectedRevision: number | null;
}

const SELECT_COLUMNS =
  "environment, wallet_address, agent_capital_share_percent, revision, updated_at";

export async function readLighterTradingLimits(
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterTradingLimitsRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_trading_limits
      WHERE environment = $1 AND wallet_address = $2`,
    [environment, normalizeWallet(walletAddress)],
  );
  return row ? map(row) : null;
}

/**
 * Compare-and-set write. Throws `LIGHTER_SETTINGS_REVISION_CONFLICT` when the
 * caller's `expectedRevision` no longer describes the stored row.
 */
export async function writeLighterTradingLimits(
  input: WriteLighterTradingLimitsInput,
): Promise<LighterTradingLimitsRow> {
  const walletAddress = normalizeWallet(input.walletAddress);
  const share = assertShare(input.agentCapitalSharePercent);

  if (input.expectedRevision === null) {
    const inserted = await queryOne<Record<string, unknown>>(
      `INSERT INTO lighter_trading_limits
         (environment, wallet_address, agent_capital_share_percent)
       VALUES ($1, $2, $3)
       ON CONFLICT (environment, wallet_address) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [input.environment, walletAddress, share],
    );
    if (inserted) return map(inserted);
    throw conflict(await readLighterTradingLimits(input.environment, walletAddress));
  }

  assertRevision(input.expectedRevision);
  // One statement decides both cases: an identical value at the CURRENT
  // revision returns the row untouched, a different value bumps it. Splitting
  // this into a read and a write would open the window this CAS exists to close.
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_trading_limits SET
       agent_capital_share_percent = $3,
       revision = CASE
         WHEN agent_capital_share_percent IS NOT DISTINCT FROM $3::integer THEN revision
         ELSE revision + 1
       END,
       updated_at = CASE
         WHEN agent_capital_share_percent IS NOT DISTINCT FROM $3::integer THEN updated_at
         ELSE NOW()
       END
     WHERE environment = $1 AND wallet_address = $2 AND revision = $4
     RETURNING ${SELECT_COLUMNS}`,
    [input.environment, walletAddress, share, input.expectedRevision],
  );
  if (row) return map(row);
  throw conflict(await readLighterTradingLimits(input.environment, walletAddress));
}

function conflict(current: LighterTradingLimitsRow | null): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_SETTINGS_REVISION_CONFLICT,
    current === null
      ? "These Lighter trading limits changed since they were read, and no saved value exists now."
      : `These Lighter trading limits changed since they were read (now at revision ${current.revision}).`,
    "Reload the current value in Settings and apply the change again.",
  );
}

function assertShare(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "The agent capital share must be a whole percent from 1 to 100, or no limit at all.",
    );
  }
  return value;
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "The Lighter trading limits revision is invalid.",
    );
  }
}

function normalizeWallet(walletAddress: string): string {
  const lowered = walletAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lowered)) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading limits require an EVM wallet address.",
    );
  }
  return lowered;
}

function map(row: Record<string, unknown>): LighterTradingLimitsRow {
  const share = row.agent_capital_share_percent;
  return {
    environment: row.environment as LighterEnvironment,
    walletAddress: String(row.wallet_address),
    agentCapitalSharePercent: share === null ? null : Number(share),
    revision: Number(row.revision),
    updatedAt: toIso(row.updated_at as string | Date),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
