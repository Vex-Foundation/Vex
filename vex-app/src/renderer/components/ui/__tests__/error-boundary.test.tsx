/**
 * The containment primitive: what the user SEES when a subtree throws, what
 * main RECEIVES about it, and what the report is allowed to carry.
 *
 * The regression this suite exists for is the one the app shipped with: no
 * boundary at all, so a render throw unmounted the whole React root and left a
 * blank window with no evidence anywhere. Delete the boundary from the tree in
 * `render` below and the first two tests go red for exactly that reason - the
 * throw escapes and nothing renders.
 *
 * `window.vex.telemetry.reportRendererError` is the REAL contract here, so the
 * double is the bridge method and the assertions are made on the payload that
 * would cross IPC. Everything under the boundary is real.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryReportInput } from "@shared/types/bridge/common.js";
import { telemetryReportInputSchema } from "@shared/schemas/telemetry.js";
import { ErrorBoundary } from "../error-boundary.js";
import {
  digestStack,
  parseStackLine,
  sanitizeFrameFile,
} from "../../../lib/renderer-error-report.js";

const reports: TelemetryReportInput[] = [];

beforeEach(() => {
  reports.length = 0;
  // React logs every caught error through console.error; the suite asserts on
  // the REPORT, and an unsilenced React error banner buries the real failure
  // of a broken test in noise.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      telemetry: {
        reportRendererError: (input: TelemetryReportInput) => {
          reports.push(input);
          return Promise.resolve({ ok: true, data: { recorded: false } });
        },
      },
    },
  });
});

/** A child that throws on demand, so a retry can be observed recovering. */
function Boom({ throwing, label }: { throwing: boolean; label: string }): JSX.Element {
  if (throwing) throw new TypeError("cannot read properties of undefined");
  return <p>{label}</p>;
}

describe("containment", () => {
  it("renders the recovery surface instead of unmounting the tree", () => {
    render(
      <div>
        <p>sibling stays</p>
        <ErrorBoundary surface="test.surface">
          <Boom throwing label="never" />
        </ErrorBoundary>
      </div>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("TypeError");
    expect(alert.textContent).toContain("cannot read properties of undefined");
    // The point of containment: everything outside the boundary still renders.
    expect(screen.getByText("sibling stays")).not.toBeNull();
  });

  it("shows the SAME correlation id it reported to main", () => {
    render(
      <ErrorBoundary surface="test.surface">
        <Boom throwing label="never" />
      </ErrorBoundary>,
    );

    expect(reports).toHaveLength(1);
    const reported = reports[0]?.correlationId;
    expect(typeof reported).toBe("string");
    expect(screen.getByRole("alert").textContent).toContain(reported ?? "<none>");
  });

  it("gives keyboard focus to the safe action", () => {
    render(
      <ErrorBoundary surface="test.surface">
        <Boom throwing label="never" />
      </ErrorBoundary>,
    );

    expect(document.activeElement?.textContent).toBe("Try again");
  });

  it("retries into a healthy render when the person asks", () => {
    // The switch lives OUTSIDE React so the retry re-renders the same element
    // against a subject that has since become healthy - what a transient
    // failure looks like. A boundary that never cleared its state would keep
    // showing the fallback anyway.
    const control = { throwing: true };
    function Controlled(): JSX.Element {
      if (control.throwing) throw new Error("transient");
      return <p>recovered</p>;
    }

    render(
      <ErrorBoundary surface="test.surface">
        <Controlled />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).not.toBeNull();

    control.throwing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("recovered")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the caller's extra route and runs it", () => {
    const chosen = vi.fn();
    render(
      <ErrorBoundary
        surface="test.surface"
        actions={[{ label: "Return to safety", onSelect: chosen }]}
      >
        <Boom throwing label="never" />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Return to safety" }));
    expect(chosen).toHaveBeenCalledTimes(1);
  });

  it("clears the failure when its subject changes", () => {
    const { rerender } = render(
      <ErrorBoundary surface="test.surface" resetKey="a">
        <Boom throwing label="never" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).not.toBeNull();

    // A boundary that stayed failed across a subject change would black out a
    // healthy subtree for as long as it stayed mounted.
    rerender(
      <ErrorBoundary surface="test.surface" resetKey="b">
        <Boom throwing={false} label="second subject" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("second subject")).not.toBeNull();
  });
});

describe("the report that crosses IPC", () => {
  it("is a valid payload naming the surface, the error and bounded frames", () => {
    render(
      <ErrorBoundary surface="studio.workspace">
        <Boom throwing label="never" />
      </ErrorBoundary>,
    );

    const report = reports[0];
    if (report === undefined) throw new Error("no report");
    // The preload validator is the real gate; parsing here proves the payload
    // this component builds would actually be accepted rather than silently
    // rejected inside a caught promise.
    expect(telemetryReportInputSchema.safeParse(report).success).toBe(true);
    expect(report.kind).toBe("boundary");
    expect(report.errorName).toBe("TypeError");
    expect(report.message).toContain("[studio.workspace]");
    expect(report.componentStack).toContain("Boom");
    const stack = report.stack;
    if (stack === null || stack === undefined) throw new Error("no stack digest");
    // The bound reports itself: however deep React's own frames run, the
    // digest states how many frames existed and whether any were left out.
    expect(stack.frames.length).toBeLessThanOrEqual(stack.frameCount);
    expect(stack.truncated).toBe(stack.frames.length < stack.frameCount);
    expect(stack.byteCount).toBeGreaterThan(0);
  });
});

describe("stack digest bounds", () => {
  it("reports what it left out instead of cutting in silence", () => {
    const frames = Array.from(
      { length: 40 },
      (_, i) => `    at fn${String(i)} (app://vex/assets/index-abc.js:${String(i)}:7)`,
    );
    const raw = ["Error: deep", ...frames].join("\n");

    const digest = digestStack(raw);
    if (digest === null) throw new Error("no digest");
    expect(digest.frameCount).toBe(40);
    expect(digest.frames).toHaveLength(24);
    expect(digest.truncated).toBe(true);
    expect(digest.byteCount).toBe(new TextEncoder().encode(raw).length);
    // The throwing site is frame 0 and is never the part dropped.
    expect(digest.frames[0]?.fn).toBe("fn0");
  });

  it("says a short stack is whole", () => {
    const digest = digestStack(
      "Error: x\n    at boot (app://vex/assets/index-abc.js:1:1)",
    );
    expect(digest?.truncated).toBe(false);
    expect(digest?.frameCount).toBe(1);
  });

  it("parses both V8 frame spellings", () => {
    expect(parseStackLine("    at run (app://vex/a.js:12:3)")).toEqual({
      fn: "run",
      file: "app://vex/a.js",
      line: 12,
      column: 3,
    });
    expect(parseStackLine("    at app://vex/a.js:12:3")).toEqual({
      fn: null,
      file: "app://vex/a.js",
      line: 12,
      column: 3,
    });
    expect(parseStackLine("Error: not a frame")).toBeNull();
  });
});

describe("frame sanitization", () => {
  it("never emits an absolute user path", () => {
    expect(sanitizeFrameFile("/home/alice/Vex/vex-app/src/renderer/App.tsx")).toBe(
      "…/renderer/App.tsx",
    );
    expect(sanitizeFrameFile("C:\\Users\\alice\\Vex\\vex-app\\src\\App.tsx")).toBe(
      "…/src/App.tsx",
    );
  });

  it("keeps a bundle URL's origin and path, and drops its query", () => {
    expect(sanitizeFrameFile("app://vex/assets/index-abc.js?t=1#x")).toBe(
      "app://vex/assets/index-abc.js",
    );
    expect(sanitizeFrameFile("http://127.0.0.1:5173/src/renderer/App.tsx?import")).toBe(
      "http://127.0.0.1:5173/src/renderer/App.tsx",
    );
  });
});
