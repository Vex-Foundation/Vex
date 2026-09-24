/**
 * How long the Lighter client lets a request wait. With the network down on
 * 2026-09-24 an approved desk order sat on a spinner for 32 seconds behind the
 * general 30-second HTTP limit before failing. Reads now give up after 10
 * seconds; sends keep the general limit, since cutting a send short would
 * leave it unknown whether it reached the sequencer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHTER_READ_TIMEOUT_MS, type LighterEndpointConfig, type LighterEnvironment } from "@tools/lighter/constants.js";

const fetchWithTimeout = vi.fn();

vi.mock("../../utils/http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/http.js")>()),
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

const { LighterClient } = await import("@tools/lighter/client.js");

const ENDPOINTS: Record<LighterEnvironment, LighterEndpointConfig> = {
  core: { restBaseUrl: "https://core.example", wsUrl: "wss://core.example/stream", readonlyWsUrl: "wss://core.example/stream?readonly=true" },
  rhc: { restBaseUrl: "https://rhc.example", wsUrl: "wss://rhc.example/stream", readonlyWsUrl: "wss://rhc.example/stream?readonly=true" },
};

function okResponse(data: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => data, text: async () => JSON.stringify(data) };
}

describe("Lighter client request limits", () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
  });

  it("gives a read at most ten seconds", async () => {
    fetchWithTimeout.mockResolvedValue(okResponse({ status: 1, network_id: 304, timestamp: 1717777777 }));

    await new LighterClient(ENDPOINTS).getStatus("rhc");

    expect(LIGHTER_READ_TIMEOUT_MS).toBe(10_000);
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining("https://rhc.example"),
      expect.objectContaining({ timeoutMs: LIGHTER_READ_TIMEOUT_MS }),
    );
  });

  it("leaves a send on the general limit", async () => {
    fetchWithTimeout.mockResolvedValue(okResponse({ code: 200, tx_hash: "0xabc" }));

    await new LighterClient(ENDPOINTS).sendTx("rhc", { txType: 14, txInfo: "{\"signed\":true}" }).catch(() => undefined);

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const options = fetchWithTimeout.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("timeoutMs");
  });
});
