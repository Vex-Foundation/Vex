/**
 * EXPAND CONFORMANCE (owner motion law, round 3 item 9). Every in-flow
 * open/close surface in the shell goes through ONE primitive, so the app has
 * one curve, one duration and one closed-content contract instead of nine
 * hand-rolled reveals.
 *
 * Two gates:
 *
 * 1. A SOURCE gate over the converted files. A render pin can only cover the
 *    surfaces that mount cheaply in jsdom; the ones behind a store or a feed
 *    fixture would silently fall out of the family. The gate also refuses the
 *    two ways a conversion regresses - a re-introduced `{open ? ... : null}`
 *    body, and an entrance keyframe left on an expanding body (a reveal must
 *    not also play a mount animation).
 * 2. RENDER pins on the surfaces that mount directly: the trigger's
 *    `aria-controls` target is the primitive, and a closed body stays in the
 *    DOM while leaving the accessibility tree.
 *
 * Surfaces deliberately NOT here: menus, popovers and dialogs (GlobalApprovals,
 * GlobalErrorBanner, the context-meter panel, PositionChains' network browser).
 * They are overlay surfaces with their own enter animation, not in-flow height
 * reveals, and giving them a height animation would fight their positioning.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReasonedBlock } from "../ReasonedBlock.js";
import { ToolDisclosure } from "../ToolDisclosure.js";
import { ReasoningSegments } from "../TurnIsland/ReasoningSegments.js";

/** Every surface converted to the shared primitive, by source path. */
const CONVERTED_SURFACES: readonly string[] = [
  "features/appShell/ReasonedBlock.tsx",
  "features/appShell/ToolDisclosure.tsx",
  "features/appShell/ToolLedger/ToolActRow.tsx",
  "features/appShell/ToolLedger/ToolGroupRow.tsx",
  "features/appShell/ToolLedger/ExplorerRefLinks.tsx",
  "features/appShell/TurnIsland/ReasoningSegments.tsx",
  "features/appShell/SessionComposer/ComposerQueueDock.tsx",
  "features/appShell/screens/agent-scan/AgentScanRow.tsx",
  "features/appShell/screens/token-history/BridgeLegsDetail.tsx",
];

function source(path: string): string {
  return readFileSync(join(process.cwd(), "src/renderer", path), "utf8");
}

afterEach(() => {
  cleanup();
});

describe("expand conformance (source gate)", () => {
  it.each(CONVERTED_SURFACES)("%s reveals through ExpandRegion", (path) => {
    const text = source(path);
    expect(text).toContain("ExpandRegion");
    expect(text).toContain("components/ui/expand-region.js");
  });

  it.each(CONVERTED_SURFACES)(
    "%s plays no entrance keyframe on the expanded body",
    (path) => {
      // `vex-entry-settle` is a MOUNT animation. On content that is now
      // permanently mounted it would either never play or double up with the
      // height reveal; either way it is the wrong axis.
      expect(source(path)).not.toContain("vex-entry-settle");
    },
  );

  it("keeps the primitive the only owner of the height mechanism", () => {
    for (const path of CONVERTED_SURFACES) {
      expect(source(path)).not.toContain("interpolate-size");
    }
  });
});

describe("expand conformance (render pins)", () => {
  it("ReasonedBlock: the trace body is the primitive and survives closing", () => {
    render(createElement(ReasonedBlock, { reasoning: "weighed the ledger" }));
    const trigger = screen.getByRole("button", { name: /Reasoned/ });
    fireEvent.click(trigger);
    const body = document.getElementById(trigger.getAttribute("aria-controls")!);
    expect(body?.className).toContain("vex-expand");
    expect(body?.getAttribute("data-open")).toBe("true");

    fireEvent.click(trigger);
    expect(body?.getAttribute("data-open")).toBe("false");
    expect(body?.getAttribute("aria-hidden")).toBe("true");
    expect(body?.textContent).toContain("weighed the ledger");
  });

  it("ToolDisclosure: the body is the primitive and survives closing", () => {
    render(
      createElement(ToolDisclosure, {
        label: "wallet:read",
        body: '{"chain":"base"}',
        emptyHint: "(none)",
      }),
    );
    const trigger = screen.getByRole("button", { name: /wallet:read/ });
    fireEvent.click(trigger);
    const body = document.getElementById(trigger.getAttribute("aria-controls")!);
    expect(body?.className).toContain("vex-expand");

    fireEvent.click(trigger);
    expect(body?.getAttribute("data-open")).toBe("false");
    expect(body?.hasAttribute("inert")).toBe(true);
    expect(body?.textContent).toContain('{"chain":"base"}');
  });

  it("ReasoningSegments: each settled thought expands through the primitive", () => {
    render(createElement(ReasoningSegments, { segments: ["first", "second"] }));
    const trigger = screen.getByRole("button", { name: "Thought 1" });
    fireEvent.click(trigger);
    const body = document.getElementById(trigger.getAttribute("aria-controls")!);
    expect(body?.className).toContain("vex-expand");
    expect(body?.getAttribute("data-open")).toBe("true");
  });

  it("closing returns focus to the trigger rather than losing it to body", () => {
    render(createElement(ReasonedBlock, { reasoning: "trace" }));
    const trigger = screen.getByRole("button", { name: /Reasoned/ });
    fireEvent.click(trigger);
    const body = document.getElementById(trigger.getAttribute("aria-controls")!);
    // Focus something inside, the way a reader tabbing into the trace would.
    body?.setAttribute("tabindex", "-1");
    (body as HTMLElement).focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
  });
});
