/**
 * The run strip's live step (`composer-live-step.ts`): it repeats the turn's
 * live row while a run is live, keeps the band's own word between rounds,
 * and stops on a pending decision.
 */

import { describe, expect, it } from "vitest";
import type { StreamPreview } from "../../../stores/streamStore.js";
import {
  AWAITING_LABEL,
  resolveComposerLiveStep,
} from "../SessionComposer/composer-live-step.js";
import { PENDING_TURN_STREAM_ID } from "../SessionTranscript/turnPreview.js";

const PREVIEW: StreamPreview = {
  streamId: "s1",
  text: "",
  phase: "streaming",
  toolName: null,
  reasoningSegments: [],
  reasoningText: "",
  reasoningTokens: null,
  startedAtMs: 1_000,
  errorType: null,
  errorDetail: null,
  status: "thinking",
};

describe("resolveComposerLiveStep", () => {
  it("shows nothing live while the band names no live run", () => {
    expect(resolveComposerLiveStep(false, PREVIEW, false, true)).toBeNull();
  });

  it("repeats the live row's word and clock while the turn thinks", () => {
    expect(resolveComposerLiveStep(true, PREVIEW, false, true)).toEqual({
      label: "Thinking",
      detail: null,
      startedAtMs: 1_000,
      awaiting: false,
    });
  });

  it("names the tool being called, as the live row does", () => {
    const step = resolveComposerLiveStep(
      true,
      { ...PREVIEW, status: "calling", toolName: "wallet_send" },
      false,
      true,
    );
    expect(step?.label).toMatch(/^Calling /);
    expect(step?.awaiting).toBe(false);
  });

  it("carries the working wait's scope", () => {
    const step = resolveComposerLiveStep(
      true,
      { ...PREVIEW, streamId: PENDING_TURN_STREAM_ID, status: "working" },
      false,
      false,
    );
    expect(step?.label).toBe("Working");
    expect(step?.detail).toBe("Preparing the turn");
  });

  it("keeps the band's word and keeps moving between rounds", () => {
    expect(resolveComposerLiveStep(true, null, false, true)).toEqual({
      label: null,
      detail: null,
      startedAtMs: null,
      awaiting: false,
    });
  });

  it("stops on a pending decision, with or without a live preview", () => {
    expect(resolveComposerLiveStep(true, PREVIEW, true, true)).toMatchObject({
      label: AWAITING_LABEL,
      awaiting: true,
    });
    expect(resolveComposerLiveStep(true, null, true, true)).toMatchObject({
      label: AWAITING_LABEL,
      awaiting: true,
    });
  });

  it("keeps the band's word over a settled or failed preview", () => {
    for (const phase of ["done", "error"] as const) {
      expect(
        resolveComposerLiveStep(true, { ...PREVIEW, phase }, false, true)?.label,
      ).toBeNull();
    }
  });
});
