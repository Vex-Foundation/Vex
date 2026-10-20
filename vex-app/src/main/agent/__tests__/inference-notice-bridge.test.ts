/**
 * The main-side bridge for D16 notices: a valid engine notice is broadcast on
 * `EV.engine.inferenceNotice`, an off-contract one is dropped, and teardown
 * unsubscribes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const broadcast = vi.fn();
vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: (...args: unknown[]) => broadcast(...args) }));
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@utils/logger.js", () => {
  const quiet = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
  return { default: quiet, logger: quiet, createChildLogger: () => quiet };
});

const { EV } = await import("@shared/ipc/channels.js");
const { inferenceNoticeBus, emitMaxTokensClampNotice } = await import("@vex-agent/inference/inference-notice-bus.js");
const { setupInferenceNoticeBridge } = await import("../inference-notice-bridge.js");

afterEach(() => {
  broadcast.mockReset();
  inferenceNoticeBus.clear();
});

describe("inference notice bridge", () => {
  it("broadcasts a valid notice and stops after teardown", () => {
    const off = setupInferenceNoticeBridge();
    emitMaxTokensClampNotice({
      provider: "vexcloud",
      model: "anthropic/claude-haiku-5.5",
      sessionId: "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e",
      missionRunId: null,
      clamp: { requested: 16_384, effective: 4_096, reason: "balance" },
    });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast.mock.calls[0]?.[0]).toBe(EV.engine.inferenceNotice);
    expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ kind: "max_tokens_clamped", effective: 4_096, reason: "balance" });

    off();
    emitMaxTokensClampNotice({
      provider: "vexcloud",
      model: "m",
      sessionId: "s",
      missionRunId: null,
      clamp: { requested: 2, effective: 1, reason: "balance" },
    });
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it("drops an off-contract notice", () => {
    const off = setupInferenceNoticeBridge();
    inferenceNoticeBus.emit({
      type: "engine.inference.notice",
      kind: "max_tokens_clamped",
      sessionId: "s",
      missionRunId: null,
      provider: "somewhere-else",
      model: "m",
      requested: 2,
      effective: 1,
      reason: "balance",
      occurredAt: new Date().toISOString(),
    });
    expect(broadcast).not.toHaveBeenCalled();
    off();
  });
});
