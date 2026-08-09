import { describe, expect, it } from "vitest";
import {
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENVIRONMENTS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import {
  getLighterReadOnlyCredentialStatus,
  lighterReadOnlyAuthTokenEnvKey,
} from "@tools/lighter/credentials.js";
import { getLighterClient } from "@tools/lighter/client.js";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const RUN_LIVE_AUTH = process.env.VEX_LIGHTER_AUTH_LIVE === "1";
const describeLiveAuth = RUN_LIVE_AUTH ? describe : describe.skip;

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

async function runTool(
  toolId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await executeProtocolTool({ toolId, params }, READ_CTX);
  expect(result.success, result.output).toBe(true);
  expect(result.actionKind).toBe("read");
  return JSON.parse(result.output) as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
}

function expectPublicAccountProvenance(
  data: Record<string, unknown>,
  environment: LighterEnvironment,
  toolId: "lighter.account.get" | "lighter.positions",
): void {
  expect(data.source).toBe("live_lighter_public_api");
  expect(data.provenance).toEqual(expect.objectContaining({
    source: "live_lighter_public_api",
    provider: "lighter",
    dataPlane: "provider_public_rest",
    toolId,
    environment,
    endpointPaths: [LIGHTER_ENDPOINT_PATHS.account],
    independentOnchainVerification: false,
    authenticated: false,
  }));
}

function expectReadOnlyAccountProvenance(
  data: Record<string, unknown>,
  environment: LighterEnvironment,
  toolId: "lighter.openOrders" | "lighter.orderHistory" | "lighter.trades",
  endpointPath: string,
): void {
  expect(data.source).toBe("live_lighter_read_only_account_api");
  expect(data.provenance).toEqual(expect.objectContaining({
    source: "live_lighter_read_only_account_api",
    provider: "lighter",
    dataPlane: "provider_read_only_auth_rest",
    toolId,
    environment,
    endpointPaths: [endpointPath],
    cacheStatus: "fresh_no_cache",
    maxDataAgeMs: 0,
    authenticated: true,
    credentialCapability: "read_only_account_data",
    independentOnchainVerification: false,
  }));
}

describeLiveAuth("Lighter live read-only authenticated account boundary", () => {
  for (const environment of LIGHTER_ENVIRONMENTS) {
    it(`reads ${environment} auth-gated account endpoints with a real read-only token`, { timeout: 60_000 }, async () => {
      const status = getLighterReadOnlyCredentialStatus(environment);
      expect(status.configured, `${lighterReadOnlyAuthTokenEnvKey(environment)} is required`).toBe(true);
      expect(status.metadata, "read-only token metadata is required").not.toBeNull();
      expect(status.metadata?.environment).toBe(environment);
      expect(status.metadata?.expired, "read-only token must not be expired").toBe(false);

      const accountIndex = status.metadata!.accountIndex;
      const client = getLighterClient();
      const account = await client.getAccount(environment, {
        by: "index",
        value: accountIndex,
        activeOnly: true,
      });
      expect(account.code).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(account.accounts)).toBe(true);

      const trades = await client.getAccountTrades(environment, {
        accountIndex,
        limit: 1,
        sortBy: "timestamp",
      });
      expect(trades.code).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(trades.trades)).toBe(true);

      const activeOrders = await client.getAccountActiveOrders(environment, { accountIndex });
      expect(activeOrders.code).toBeGreaterThanOrEqual(0);

      const inactiveOrders = await client.getAccountInactiveOrders(environment, {
        accountIndex,
        limit: 1,
      });
      expect(inactiveOrders.code).toBeGreaterThanOrEqual(0);

      const accountTool = await runTool("lighter.account.get", {
        environment,
        accountIndex,
        activeOnly: true,
      });
      expectPublicAccountProvenance(accountTool, environment, "lighter.account.get");
      expect(rows(accountTool.accounts).length).toBeGreaterThanOrEqual(0);

      const positionsTool = await runTool("lighter.positions", {
        environment,
        accountIndex,
        activeOnly: true,
      });
      expectPublicAccountProvenance(positionsTool, environment, "lighter.positions");
      expect(rows(positionsTool.accounts).length).toBeGreaterThanOrEqual(0);

      const openOrdersTool = await runTool("lighter.openOrders", {
        environment,
        limit: 1,
      });
      expectReadOnlyAccountProvenance(
        openOrdersTool,
        environment,
        "lighter.openOrders",
        LIGHTER_ENDPOINT_PATHS.accountActiveOrders,
      );
      expect(openOrdersTool.accountIndexSource).toBe("credential");
      expect(rows(openOrdersTool.orders).length).toBeLessThanOrEqual(1);

      const orderHistoryTool = await runTool("lighter.orderHistory", {
        environment,
        limit: 1,
      });
      expectReadOnlyAccountProvenance(
        orderHistoryTool,
        environment,
        "lighter.orderHistory",
        LIGHTER_ENDPOINT_PATHS.accountInactiveOrders,
      );
      expect(orderHistoryTool.accountIndexSource).toBe("credential");
      expect(rows(orderHistoryTool.orders).length).toBeLessThanOrEqual(1);

      const tradesTool = await runTool("lighter.trades", {
        environment,
        limit: 1,
      });
      expectReadOnlyAccountProvenance(
        tradesTool,
        environment,
        "lighter.trades",
        LIGHTER_ENDPOINT_PATHS.trades,
      );
      expect(tradesTool.accountIndexSource).toBe("credential");
      expect(rows(tradesTool.trades).length).toBeLessThanOrEqual(1);
    });
  }
});
