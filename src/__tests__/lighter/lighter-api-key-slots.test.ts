import { describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import {
  inspectLighterApiKeySlots,
  readLighterApiKeySlotObservation,
  selectAvailableLighterApiKeyIndex,
} from "@tools/lighter/wallet-funding/api-key-slots.js";
import type { LighterApiKey, LighterApiKeysResponse } from "@tools/lighter/types.js";

const OBSERVED_AT = new Date("2030-01-01T00:00:00.000Z");

function publicKey(seed: number): string {
  return seed.toString(16).padStart(80, "0");
}

function apiKey(apiKeyIndex: number, accountIndex = 42): LighterApiKey {
  return {
    account_index: accountIndex,
    api_key_index: apiKeyIndex,
    nonce: 0,
    public_key: publicKey(apiKeyIndex + 1),
    transaction_time: 1,
  };
}

function response(apiKeys: readonly LighterApiKey[]): LighterApiKeysResponse {
  return { code: 200, api_keys: [...apiKeys] };
}

describe("Lighter Phase 3 API-key slot inspection", () => {
  it("fetches the all-slots sentinel explicitly", async () => {
    const client = {
      getApiKeys: vi.fn().mockResolvedValue(response([apiKey(4)])),
    };

    const observation = await readLighterApiKeySlotObservation({
      client,
      environment: "core",
      accountIndex: 42,
      observedAt: OBSERVED_AT,
    });

    expect(client.getApiKeys).toHaveBeenCalledWith("core", {
      accountIndex: 42,
      apiKeyIndex: 255,
    });
    expect(observation.occupiedApiKeyIndexes).toEqual([4]);
    expect(observation.observationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("selects the lowest slot unused by both Lighter and local reservations", () => {
    const observation = inspectLighterApiKeySlots(
      response([apiKey(7), apiKey(4), apiKey(0)]),
      42,
      OBSERVED_AT,
    );

    expect(observation.occupiedApiKeyIndexes).toEqual([0, 4, 7]);
    expect(selectAvailableLighterApiKeyIndex(observation, [5])).toBe(6);
  });

  it("canonicalizes provider row order and optional public-key prefixes", () => {
    const prefixed = { ...apiKey(4), public_key: `0x${publicKey(5).toUpperCase()}` };
    const first = inspectLighterApiKeySlots(
      response([apiKey(6), prefixed]),
      42,
      OBSERVED_AT,
    );
    const second = inspectLighterApiKeySlots(
      response([prefixed, apiKey(6)]),
      42,
      OBSERVED_AT,
    );

    expect(first.observationHash).toBe(second.observationHash);
  });

  it.each([
    ["different account", response([apiKey(4, 43)])],
    ["reserved sentinel row", response([apiKey(255)])],
    ["malformed public key", response([{ ...apiKey(4), public_key: "abcd" }])],
    ["duplicate index", response([apiKey(4), { ...apiKey(4), public_key: publicKey(9) }])],
    ["non-success code", { code: 400, api_keys: [] }],
  ] as const)("refuses a %s response conservatively", (_label, raw) => {
    expect(() => inspectLighterApiKeySlots(raw, 42, OBSERVED_AT)).toThrow(VexError);
    try {
      inspectLighterApiKeySlots(raw, 42, OBSERVED_AT);
    } catch (error) {
      expect((error as VexError).code).toBe(ErrorCodes.LIGHTER_INVALID_RESPONSE);
    }
  });

  it("refuses corrupt local reservations", () => {
    const observation = inspectLighterApiKeySlots(response([]), 42, OBSERVED_AT);
    expect(() => selectAvailableLighterApiKeyIndex(observation, [3])).toThrow(
      "invalid trading-key index",
    );
  });

  it("fails closed when every conservative trading slot is occupied", () => {
    const occupied = Array.from({ length: 251 }, (_, offset) => apiKey(offset + 4));
    const observation = inspectLighterApiKeySlots(response(occupied), 42, OBSERVED_AT);

    expect(() => selectAvailableLighterApiKeyIndex(observation, [])).toThrow(
      "No unused Lighter trading API-key slot",
    );
  });
});
