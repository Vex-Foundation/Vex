/** Public-scope Lighter integration activation. Never stores credentials. */

import type { LighterEnvironment } from "@tools/lighter/types.js";
import { queryOne } from "../client.js";

export interface LighterIntegrationSetting {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly enabled: boolean;
  readonly enabledAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface SettingRow {
  readonly environment: LighterEnvironment;
  readonly wallet_address: string;
  readonly enabled: boolean;
  readonly enabled_at: Date | null;
  readonly disabled_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const RETURNING = `
  environment, wallet_address, enabled, enabled_at, disabled_at, created_at, updated_at
`;

export async function getLighterIntegrationSetting(
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterIntegrationSetting | null> {
  assertWalletAddress(walletAddress);
  const row = await queryOne<SettingRow>(
    `SELECT ${RETURNING}
       FROM lighter_integration_settings
      WHERE environment = $1 AND wallet_address = $2`,
    [environment, walletAddress.toLowerCase()],
  );
  return row === null ? null : mapRow(row);
}

export async function setLighterIntegrationEnabled(input: {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly enabled: boolean;
}): Promise<LighterIntegrationSetting> {
  assertWalletAddress(input.walletAddress);
  const row = await queryOne<SettingRow>(
    `WITH setting AS (
       INSERT INTO lighter_integration_settings
         (environment, wallet_address, enabled, enabled_at, disabled_at)
       VALUES (
         $1, $2, $3,
         CASE WHEN $3 THEN NOW() ELSE NULL END,
         CASE WHEN $3 THEN NULL ELSE NOW() END
       )
       ON CONFLICT (environment, wallet_address) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             enabled_at = CASE
               WHEN EXCLUDED.enabled AND NOT lighter_integration_settings.enabled THEN NOW()
               ELSE lighter_integration_settings.enabled_at
             END,
             disabled_at = CASE
               WHEN NOT EXCLUDED.enabled AND lighter_integration_settings.enabled THEN NOW()
               ELSE lighter_integration_settings.disabled_at
             END,
             updated_at = NOW()
       RETURNING ${RETURNING}
     ), workflow AS (
       INSERT INTO lighter_onboarding_workflows (
         environment, wallet_address, workflow_state
       )
       SELECT environment, wallet_address, 'integration_enabled'
         FROM setting
        WHERE enabled = TRUE
       ON CONFLICT (environment, wallet_address) DO NOTHING
     )
     SELECT ${RETURNING} FROM setting`,
    [input.environment, input.walletAddress.toLowerCase(), input.enabled],
  );
  if (row === null) {
    throw new Error("Lighter integration activation write returned no row.");
  }
  return mapRow(row);
}

export async function isLighterIntegrationEnabled(
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<boolean> {
  return (await getLighterIntegrationSetting(environment, walletAddress))?.enabled === true;
}

function assertWalletAddress(walletAddress: string): void {
  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
    throw new Error("Lighter integration setting requires a valid EVM wallet address.");
  }
}

function mapRow(row: SettingRow): LighterIntegrationSetting {
  return {
    environment: row.environment,
    walletAddress: row.wallet_address,
    enabled: row.enabled,
    enabledAt: row.enabled_at,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
