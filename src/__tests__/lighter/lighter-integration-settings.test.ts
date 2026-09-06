import { requireValue } from "../helpers/require-value.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryOne = vi.hoisted(() => vi.fn());

vi.mock("@vex-agent/db/client.js", () => ({ queryOne }));

const repo = await import("@vex-agent/db/repos/lighter-integration-settings.js");

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const NOW = new Date("2030-01-01T00:00:00.000Z");

function row(enabled: boolean) {
  return {
    environment: "core",
    wallet_address: WALLET.toLowerCase(),
    enabled,
    enabled_at: enabled ? NOW : null,
    disabled_at: enabled ? null : NOW,
    created_at: NOW,
    updated_at: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lighter integration settings repository", () => {
  it("is default-disabled when no public-scope row exists", async () => {
    queryOne.mockResolvedValue(null);
    await expect(repo.isLighterIntegrationEnabled("core", WALLET)).resolves.toBe(false);
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining("FROM lighter_integration_settings"),
      ["core", WALLET.toLowerCase()],
    );
  });

  it("upserts activation timestamps without storing any credential field", async () => {
    queryOne.mockResolvedValue(row(true));
    const result = await repo.setLighterIntegrationEnabled({
      environment: "core",
      walletAddress: WALLET,
      enabled: true,
    });

    expect(result).toMatchObject({
      environment: "core",
      walletAddress: WALLET.toLowerCase(),
      enabled: true,
      enabledAt: NOW,
    });
    const [sql, params] = requireValue(queryOne.mock.calls[0]);
    expect(sql).toContain("ON CONFLICT (environment, wallet_address) DO UPDATE");
    expect(sql).toContain("enabled_at");
    expect(sql).toContain("disabled_at");
    expect(sql).toContain("INSERT INTO lighter_onboarding_workflows");
    expect(sql).toContain("'integration_enabled'");
    expect(sql).not.toMatch(/private|secret|signature|token|credential/i);
    expect(params).toEqual(["core", WALLET.toLowerCase(), true]);
  });

  it("rejects malformed wallet scope before querying", async () => {
    await expect(repo.setLighterIntegrationEnabled({
      environment: "core",
      walletAddress: "not-a-wallet",
      enabled: true,
    })).rejects.toThrow("valid EVM wallet address");
    expect(queryOne).not.toHaveBeenCalled();
  });
});
