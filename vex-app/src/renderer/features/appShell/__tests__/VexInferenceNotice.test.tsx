/**
 * The welcome's Vex Inference notice ("AI is now paid in VEX").
 *
 * Pinned, against the env read and the real ui store: the exact copy; shown
 * while OpenRouter or no provider is named; never while Vex Inference
 * (`vexcloud`) is named, configured or not, and never while the read is
 * loading or failed; "Use Vex Inference" opens the Model section in Settings
 * and saves nothing; "Not now" persists the dismissal, hands the caret to the
 * composer and keeps the card away on the next mount; both keys are native
 * buttons inside a region named by the title; no blue fill (the send key
 * stays the view's one).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { partializeUiState } from "../../../stores/uiStore/persistence.js";
import { clearComposerFocus, publishComposerFocus } from "../composer-focus.js";

let envData: unknown;
vi.mock("../../../lib/api/onboarding.js", () => ({
  useEnvState: () => ({ data: envData }),
}));

const { VexInferenceNotice, VEX_INFERENCE_NOTICE_COPY } = await import("../VexInferenceNotice.js");

const TITLE = "AI is now paid in VEX";

function envWith(provider: Partial<EnvState["provider"]>): unknown {
  return {
    ok: true,
    data: { provider: { configured: false, name: null, modelLabel: null, endpointTag: null, ...provider } },
  };
}

beforeEach(() => {
  envData = envWith({ configured: true, name: "openrouter", modelLabel: "anthropic/claude-sonnet-4.5" });
  useUiStore.setState({ vexInferenceNoticeDismissed: false, shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
  clearComposerFocus();
});

describe("VexInferenceNotice - when it shows", () => {
  it("says what changed, in the owner's copy, while OpenRouter is active", () => {
    render(<VexInferenceNotice />);
    const region = screen.getByRole("region", { name: TITLE });
    expect(screen.getByRole("heading", { name: TITLE })).toBeTruthy();
    expect(region.textContent).toContain(
      "Vex Inference runs the agent on top models and charges your VEX balance per request. 3% comes back as cashback.",
    );
    expect(VEX_INFERENCE_NOTICE_COPY.title).toBe(TITLE);
    const keys = [...region.querySelectorAll("button")].map((key) => key.textContent);
    expect(keys).toEqual(["Use Vex Inference", "Not now"]);
  });

  it("shows when no provider is set up yet", () => {
    envData = envWith({});
    render(<VexInferenceNotice />);
    expect(screen.getByRole("region", { name: TITLE })).toBeTruthy();
  });

  it.each([
    ["configured", { configured: true, name: "vexcloud" as const, modelLabel: "a/b" }],
    ["signed out", { configured: false, name: "vexcloud" as const }],
  ])("stays away when Vex Inference is already the provider (%s)", (_case, provider) => {
    envData = envWith(provider);
    const { container } = render(<VexInferenceNotice />);
    expect(container.firstChild).toBeNull();
  });

  it.each([
    ["loading", undefined],
    ["failed", { ok: false, error: { code: "internal.unexpected", message: "x" } }],
  ])("stays away while the env read is %s, so it never flashes", (_case, data) => {
    envData = data;
    const { container } = render(<VexInferenceNotice />);
    expect(container.firstChild).toBeNull();
  });

  it("stays away once dismissed", () => {
    useUiStore.setState({ vexInferenceNoticeDismissed: true });
    const { container } = render(<VexInferenceNotice />);
    expect(container.firstChild).toBeNull();
  });
});

describe("VexInferenceNotice - its keys", () => {
  it("Use Vex Inference opens the provider setting in Settings and dismisses nothing", () => {
    render(<VexInferenceNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Use Vex Inference" }));
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "settings", origin: null, section: "model" });
    expect(useUiStore.getState().vexInferenceNoticeDismissed).toBe(false);
  });

  it("Not now dismisses it for good and hands the caret to the composer", () => {
    const focus = vi.fn();
    const unregister = publishComposerFocus(focus);
    try {
      const first = render(<VexInferenceNotice />);
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(partializeUiState(useUiStore.getState())["vexInferenceNoticeDismissed"]).toBe(true);
      expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
      first.unmount();
      const second = render(<VexInferenceNotice />);
      expect(second.container.firstChild).toBeNull();
    } finally {
      unregister();
    }
  });

  it("both keys are native buttons reachable by keyboard, and neither is the blue fill", () => {
    render(<VexInferenceNotice />);
    for (const name of ["Use Vex Inference", "Not now"]) {
      const key = screen.getByRole("button", { name });
      expect(key.tagName).toBe("BUTTON");
      expect(key.getAttribute("tabindex")).toBeNull();
      expect(key.getAttribute("data-vex-button")).not.toBe("primary");
    }
  });
});
