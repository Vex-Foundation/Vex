import { describe, expect, it } from "vitest";
import { LIGHTER_ENVIRONMENTS } from "@tools/lighter/constants.js";
import {
  getLighterReadOnlyCredentialStatus,
  lighterReadOnlyAuthTokenEnvKey,
} from "@tools/lighter/credentials.js";
import { getLighterClient } from "@tools/lighter/client.js";

const RUN_LIVE_AUTH = process.env.VEX_LIGHTER_AUTH_LIVE === "1";
const describeLiveAuth = RUN_LIVE_AUTH ? describe : describe.skip;

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

      const tokens = await client.getReadOnlyTokens(environment, { accountIndex });
      expect(tokens.code).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(tokens.tokens)).toBe(true);

      const trades = await client.getAccountTrades(environment, {
        accountIndex,
        limit: 1,
        sortBy: "timestamp",
      });
      expect(trades.code).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(trades.trades)).toBe(true);
    });
  }
});
