/**
 * LIVE: the gateway's `GET /v1/models` through the real client and the real
 * price projection the `VexInferenceStatus` tool reports (per one million
 * tokens, in USD and in VEX at a rate), over live bytes.
 *
 * GATED: runs only when `VEX_CLOUD_E2E_URL` names a running gateway origin,
 * for example a local VexVirtualsCompute with `VIRTUALS_UPSTREAM=fake`
 * (`pnpm dev`, which publishes the same registry rows as production).
 * Read only; no bearer is sent.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORIGIN = process.env.VEX_CLOUD_E2E_URL;
const describeLive = ORIGIN === undefined ? describe.skip : describe;

describeLive("live /v1/models", () => {
  it("parses every published row and projects each price exactly per one million tokens", async () => {
    const { createVexCloudApi } = await import("../api-client.js");
    const { perMillionMicroUsd, pricePerMillionView } = await import("../vex-inference-amounts.js");
    const api = createVexCloudApi({ origin: () => ORIGIN ?? "" });
    const models = await api.listModels(null, new AbortController().signal);
    if (!models.ok) throw new Error(`models read failed: ${JSON.stringify(models.failure)}`);
    expect(models.value.data.length).toBeGreaterThan(0);
    // 10^15 wei per micro-USD (1 VEX = $0.001), the fixture rate of the other suites.
    const rateX18 = 10n ** 15n * 10n ** 18n;
    for (const row of models.value.data) {
      const input = pricePerMillionView(row.pricing.prompt, rateX18);
      const output = pricePerMillionView(row.pricing.completion, rateX18);
      expect(input, row.id).not.toBeNull();
      expect(output, row.id).not.toBeNull();
      // The exact projection: per-token USD with 12 decimals is micro-USD per 1M tokens.
      const [whole, fraction = ""] = row.pricing.prompt.split(".");
      expect(perMillionMicroUsd(row.pricing.prompt)).toBe(BigInt(whole ?? "0") * 10n ** 12n + BigInt(fraction.padEnd(12, "0") || "0"));
      if (row.pricing.internal_reasoning !== undefined) expect(pricePerMillionView(row.pricing.internal_reasoning, rateX18), row.id).not.toBeNull();
      console.info(`[live-models] ${row.id} input=$${input?.usd}/1M (${input?.vexAtCurrentRate} VEX) output=$${output?.usd}/1M reasoning=${row.pricing.internal_reasoning === undefined ? "none" : "published"}`);
    }
  });
});
