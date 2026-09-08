import { describe, expect, it, vi } from "vitest";

import { syncLighterPublicApiKeyNonces } from "@vex-agent/tools/protocols/lighter/nonce-sync.js";

describe("Lighter public API-key nonce sync", () => {
  it("records every public API-key nonce returned by the provider", async () => {
    const client = {
      getApiKeys: vi.fn().mockResolvedValue({
        code: 200,
        api_keys: [
          {
            account_index: 42,
            api_key_index: 1,
            nonce: 1784732515923,
            public_key: "public-1",
            transaction_time: 1784732516903382,
          },
          {
            account_index: 42,
            api_key_index: 2,
            nonce: 1784732515924,
            public_key: "public-2",
            transaction_time: 1784732516903383,
          },
        ],
      }),
    };
    const nonceState = {
      recordObserved: vi.fn().mockResolvedValue(undefined),
    };

    const result = await syncLighterPublicApiKeyNonces({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 255,
    }, { client, nonceState });

    expect(client.getApiKeys).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      apiKeyIndex: 255,
    });
    expect(nonceState.recordObserved).toHaveBeenCalledTimes(2);
    expect(nonceState.recordObserved).toHaveBeenNthCalledWith(1, {
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 1,
      nonce: 1784732515923,
      publicKey: "public-1",
      transactionTime: 1784732516903382,
    });
    expect(result).toEqual({
      environment: "rhc",
      requestedAccountIndex: 42,
      requestedApiKeyIndex: 255,
      observedCount: 2,
      recordedCount: 2,
    });
  });

  it("omits apiKeyIndex when syncing the provider default", async () => {
    const client = {
      getApiKeys: vi.fn().mockResolvedValue({ code: 200, api_keys: [] }),
    };
    const nonceState = {
      recordObserved: vi.fn().mockResolvedValue(undefined),
    };

    await syncLighterPublicApiKeyNonces({
      environment: "core",
      accountIndex: 1,
    }, { client, nonceState });

    expect(client.getApiKeys).toHaveBeenCalledWith("core", { accountIndex: 1 });
    expect(nonceState.recordObserved).not.toHaveBeenCalled();
  });

  it("propagates exactness refusals instead of silently recording unsafe nonces", async () => {
    const client = {
      getApiKeys: vi.fn().mockResolvedValue({
        code: 200,
        api_keys: [{
          account_index: 42,
          api_key_index: 1,
          nonce: Number.MAX_SAFE_INTEGER + 1,
          public_key: "public-1",
          transaction_time: 1784732516903382,
        }],
      }),
    };
    const nonceState = {
      recordObserved: vi
        .fn()
        .mockRejectedValue(new Error("lighter_nonce_state: nonce must be a safe non-negative integer")),
    };

    await expect(syncLighterPublicApiKeyNonces({
      environment: "rhc",
      accountIndex: 42,
    }, { client, nonceState })).rejects.toThrow("nonce must be a safe non-negative integer");
  });
});
