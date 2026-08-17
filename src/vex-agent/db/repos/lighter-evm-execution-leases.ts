/** Cross-process execution lease for one Lighter EVM wallet on one chain. */

import {
  executeWith,
  getPool,
  queryOne,
  queryOneWith,
  type Executor,
} from "../client.js";

export interface LighterEvmExecutionLease {
  readonly chainId: number;
  readonly walletAddress: string;
  readonly ownerId: string;
  readonly intentId: string;
  readonly acquiredAt: Date;
  readonly heartbeatAt: Date;
  readonly expiresAt: Date;
}

interface LeaseRow {
  readonly chain_id: number;
  readonly wallet_address: string;
  readonly owner_id: string;
  readonly intent_id: string;
  readonly acquired_at: Date;
  readonly heartbeat_at: Date;
  readonly expires_at: Date;
}

export interface AcquireLighterEvmExecutionLeaseInput {
  readonly chainId: number;
  readonly walletAddress: string;
  readonly ownerId: string;
  readonly intentId: string;
  readonly ttlMs: number;
}

const RETURNING = `
  chain_id, wallet_address, owner_id, intent_id,
  acquired_at, heartbeat_at, expires_at
`;

export async function acquireLighterEvmExecutionLease(
  input: AcquireLighterEvmExecutionLeaseInput,
  exec: Executor = getPool(),
): Promise<LighterEvmExecutionLease | null> {
  assertLeaseInput(input.chainId, input.walletAddress, input.ownerId, input.ttlMs);
  const walletAddress = input.walletAddress.toLowerCase();
  const row = await queryOneWith<LeaseRow>(
    exec,
    `INSERT INTO lighter_evm_execution_leases
       (chain_id, wallet_address, owner_id, intent_id, acquired_at, heartbeat_at, expires_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW() + ($5::int * interval '1 millisecond'))
     ON CONFLICT (chain_id, wallet_address) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           intent_id = EXCLUDED.intent_id,
           acquired_at = NOW(),
           heartbeat_at = NOW(),
           expires_at = EXCLUDED.expires_at
       WHERE lighter_evm_execution_leases.expires_at <= NOW()
     RETURNING ${RETURNING}`,
    [input.chainId, walletAddress, input.ownerId, input.intentId, input.ttlMs],
  );
  return row === null ? null : mapRow(row);
}

export async function renewLighterEvmExecutionLease(input: {
  readonly chainId: number;
  readonly walletAddress: string;
  readonly ownerId: string;
  readonly ttlMs: number;
}, exec: Executor = getPool()): Promise<LighterEvmExecutionLease | null> {
  assertLeaseInput(input.chainId, input.walletAddress, input.ownerId, input.ttlMs);
  const row = await queryOneWith<LeaseRow>(
    exec,
    `UPDATE lighter_evm_execution_leases
        SET heartbeat_at = NOW(),
            expires_at = NOW() + ($4::int * interval '1 millisecond')
      WHERE chain_id = $1
        AND wallet_address = $2
        AND owner_id = $3
        AND expires_at > NOW()
      RETURNING ${RETURNING}`,
    [input.chainId, input.walletAddress.toLowerCase(), input.ownerId, input.ttlMs],
  );
  return row === null ? null : mapRow(row);
}

export async function releaseLighterEvmExecutionLease(input: {
  readonly chainId: number;
  readonly walletAddress: string;
  readonly ownerId: string;
}, exec: Executor = getPool()): Promise<boolean> {
  const affected = await executeWith(
    exec,
    `DELETE FROM lighter_evm_execution_leases
      WHERE chain_id = $1 AND wallet_address = $2 AND owner_id = $3`,
    [input.chainId, input.walletAddress.toLowerCase(), input.ownerId],
  );
  return affected > 0;
}

export async function getLighterEvmExecutionLease(
  chainId: number,
  walletAddress: string,
): Promise<LighterEvmExecutionLease | null> {
  const row = await queryOne<LeaseRow>(
    `SELECT ${RETURNING}
       FROM lighter_evm_execution_leases
      WHERE chain_id = $1 AND wallet_address = $2`,
    [chainId, walletAddress.toLowerCase()],
  );
  return row === null ? null : mapRow(row);
}

function assertLeaseInput(
  chainId: number,
  walletAddress: string,
  ownerId: string,
  ttlMs: number,
): void {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Lighter EVM execution lease requires a positive integer chain id.");
  }
  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
    throw new Error("Lighter EVM execution lease requires a valid wallet address.");
  }
  if (ownerId.length === 0 || ownerId.length > 200) {
    throw new Error("Lighter EVM execution lease requires a bounded owner id.");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 2_147_483_647) {
    throw new Error("Lighter EVM execution lease requires a positive int32 TTL.");
  }
}

function mapRow(row: LeaseRow): LighterEvmExecutionLease {
  return {
    chainId: Number(row.chain_id),
    walletAddress: row.wallet_address,
    ownerId: row.owner_id,
    intentId: row.intent_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}
