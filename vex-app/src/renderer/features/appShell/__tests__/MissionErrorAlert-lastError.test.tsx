/**
 * `MissionErrorAlert` consumes the DURABLE `runtimeStateDto.lastError`.
 *
 * The push channel answers "something just failed". This answers "why did my
 * mission stop" AFTER an app restart, when the live event is long gone — which
 * is the question the spec set out to make answerable from the UI. The field
 * was persisted and exposed, but nothing rendered it: the alert still showed
 * generic stopReason copy, so the evidence existed and the user never saw it.
 *
 * Classification goes through the SAME classifier as the push event and the
 * chat IPC mapper. One vocabulary, one mapping table — a category that reads
 * "rate-limited" in the banner cannot read "unexpected error" here.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import { MissionErrorAlert } from "../MissionControls/MissionErrorAlert.js";

function renderAlert(
  lastError: RuntimeStateDto["lastError"],
  stopReason: string | null = "provider_error",
) {
  render(createElement(MissionErrorAlert, { stopReason, lastError }));
  return screen.getByRole("alert");
}

describe("MissionErrorAlert - with durable evidence", () => {
  it("names the provider rate limit instead of `an inference or runtime error`", () => {
    const alert = renderAlert({ errorType: "rate_limit_exceeded", statusCode: 429 });
    expect(alert.getAttribute("data-vex-category")).toBe("capacity");
    expect(alert.textContent).toContain("rate-limited");
    expect(alert.textContent).not.toContain("an inference or runtime error");
  });

  it("points a context overflow at compaction", () => {
    const alert = renderAlert({ errorType: "context_length_exceeded" });
    expect(alert.getAttribute("data-vex-category")).toBe("context");
    expect(alert.textContent).toContain("Compact");
  });

  it("classifies from the SDK class alone when there is no status", () => {
    // The six status-less shapes have no other signal; this is the case the
    // durable `errorClass` column exists for.
    const alert = renderAlert({ errorClass: "SDKValidationError" });
    expect(alert.getAttribute("data-vex-category")).toBe("unreadable_response");
  });

  it("shows the bounded codes and NOTHING resembling provider prose", () => {
    const alert = renderAlert({
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      statusCode: 429,
      causeCode: "ECONNRESET",
    });
    expect(alert.textContent).toContain("rate_limit_exceeded");
    expect(alert.textContent).toContain("HTTP 429");
    expect(alert.textContent).toContain("ECONNRESET");
  });

  it("ALWAYS keeps the standing not-monitoring warning", () => {
    // The whole reason this alert is state-driven and undismissable: a paused
    // mission is not watching the market or the user's positions.
    const alert = renderAlert({ errorType: "rate_limit_exceeded" });
    expect(alert.textContent).toContain("not monitoring the market");
  });
});

describe("MissionErrorAlert - without durable evidence", () => {
  it("degrades to the original generic copy when lastError is absent", () => {
    // Runs that paused before the evidence was persisted, and pauses with
    // nothing classifiable to say, must not regress.
    const alert = renderAlert(undefined, "provider_error");
    expect(alert.textContent).toContain("an inference or runtime error");
    expect(alert.getAttribute("data-vex-category")).toBeNull();
  });

  it("uses the unexpected-error wording for any other stop reason", () => {
    const alert = renderAlert(undefined, "something_else");
    expect(alert.textContent).toContain("an unexpected error");
  });
});
