/**
 * Composer toolbar row - the shrink chain, the trailing runtime cluster, and
 * the context meter's panel (UIUX round 3, lane F2; codex Bug 3 + the deepseek
 * cross-check §2).
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. jsdom performs no layout: `offsetWidth`
 * and `scrollWidth` are always 0 and container queries never evaluate. So the
 * overflow contract is pinned STRUCTURALLY - every rule the reference uses to
 * avoid horizontal overflow is asserted as a present, correctly-placed class on
 * the element that owns it, and the collapse is asserted as the declared
 * container-query variant plus the invariant that makes collapsing SAFE (the
 * accessible name does not live on the collapsible label). Pixel proof needs a
 * Chromium run; see the lane report.
 *
 * Pinned here:
 *  - leading cluster concedes (min-w-0, no `shrink-0` on the text seats), its
 *    labels own the ellipsis, its glyphs are fixed;
 *  - trailing cluster is `flex-none` and its seats never shrink;
 *  - the permission label collapses at the row container's 460px threshold
 *    while the seat keeps its accessible name;
 *  - no focusable control is blanket-clipped, and every one carries a visible
 *    focus ring;
 *  - the context meter's click panel: dialog semantics, Escape and outside
 *    dismissal, focus restoration, tooltip suppression while open, and the
 *    honest total-only bar;
 *  - starter chips are a function of the STAGE, not a second emptiness read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { resetDraftsForTest } from "../../../../lib/composer-drafts.js";
import { resetComposerQueueForTest } from "../../../../lib/composer-queue.js";

vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock("../../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: { ok: true, data: { status: null } } }),
  useRequestStop: () => ({ mutateAsync: async () => undefined }),
}));
// Reconfigurable: `undefined` is the cold-start case (the REASON control is a
// quiet placeholder); a resolved model mounts the model chip.
let models: ReadonlyArray<{ modelId: string; reasoning: null }> | null = null;
vi.mock("../../../../lib/api/models.js", () => ({
  useAvailableModels: () => ({
    data: models === null ? undefined : { ok: true, data: { models } },
  }),
}));

let contextWindow: {
  tokensUsed: number;
  contextLimit: number | null;
  pressureBarrierFraction?: number;
} | null = null;
vi.mock("../../../../lib/api/usage.js", () => ({
  useContextWindow: () => ({
    data: contextWindow === null ? undefined : { ok: true, data: contextWindow },
  }),
}));

// Compaction is the meter panel's action block; its own state table is pinned
// by CompactionApplyButton.test.tsx, so it stays inert here.
vi.mock("../../../../lib/api/compaction.js", () => ({
  useCompactionLiveSync: vi.fn(),
  useCompactionStatus: () => ({ data: { ok: true, data: null } }),
}));
vi.mock("../../../../lib/api/compaction-preparation.js", () => ({
  usePreparationLiveSync: vi.fn(),
  usePreparation: () => ({ data: { ok: true, data: null } }),
  useRequestCompactionApply: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../../../../lib/api/sessions.js", () => ({
  useSessionPlan: () => ({ data: { ok: true, data: null } }),
  useExportSessionMarkdown: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("../../PlanDisplayModal.js", () => ({ PlanDisplayModal: () => null }));
vi.mock("../../SessionExportDialog.js", () => ({
  SessionExportDialog: () => null,
}));
vi.mock("../../../wizard/steps/provider/ModelBrandIcon.js", () => ({
  ModelBrandIcon: () => <svg data-testid="model-brand-icon" />,
}));

const { SessionComposer } = await import("../../SessionComposer.js");

const SESSION = "00000000-0000-4000-8000-00000000cc02";

function agentRow(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: SESSION,
    mode: "agent",
    permission: "full",
    title: "Toolbar",
    initialGoal: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessageAt: null,
    messageCount: 0,
    pinned: false,
    archived: false,
    ...over,
  } as SessionListItem;
}

function mountDocked(over: Partial<SessionListItem> = {}) {
  return render(
    <SessionComposer
      activeSession={agentRow(over)}
      activeSessionId={SESSION}
      variant="docked"
    />,
  );
}

beforeEach(() => {
  resetDraftsForTest();
  resetComposerQueueForTest();
  contextWindow = { tokensUsed: 45_000, contextLimit: 100_000 };
  models = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The toolbar row is the flex parent of both clusters. */
function toolbarRow(container: HTMLElement): HTMLElement {
  const seat = container.querySelector(
    '[data-vex-area="composer-permission-chip"]',
  );
  const row = seat?.parentElement?.parentElement ?? null;
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("composer toolbar - the shrink chain (Bug 3)", () => {
  it("the row is the query container the permission collapse answers to", () => {
    const { container } = mountDocked();
    expect(toolbarRow(container).className).toContain("@container");
  });

  it("the leading cluster concedes width instead of painting outside the row", () => {
    // A long model id is exactly what codex named as the second overflow
    // trigger, alongside "Full access".
    models = [
      { modelId: "anthropic/claude-opus-4-1-20250805-extended", reasoning: null },
    ];
    const { container } = mountDocked();
    const modelChip = container.querySelector(
      '[data-vex-area="composer-model-chip"]',
    ) as HTMLElement | null;
    expect(modelChip).not.toBeNull();
    const chip = modelChip as HTMLElement;
    // The chip box MAY shrink: `min-w-0`, and no `shrink-0` pinning it.
    expect(chip.className).toContain("min-w-0");
    expect(chip.className).not.toContain("shrink-0");
    // Its cluster is the shrinkable one.
    const cluster = chip.parentElement as HTMLElement;
    expect(cluster.className).toContain("min-w-0");
  });

  it("labels own the ellipsis and fixed glyphs never shrink", () => {
    models = [
      { modelId: "anthropic/claude-opus-4-1-20250805-extended", reasoning: null },
    ];
    const { container } = mountDocked();
    const label = container.querySelector(
      "[data-vex-model-label]",
    ) as HTMLElement;
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("min-w-0");
    // The brand glyph is identity, not text: it is fixed.
    const glyphBox = container.querySelector(
      '[data-testid="model-brand-icon"]',
    )?.parentElement as HTMLElement;
    expect(glyphBox.className).toContain("shrink-0");
  });

  it("the reasoning placeholder carries no width FLOOR that the row cannot reclaim", () => {
    const { container } = mountDocked();
    const placeholder = container.querySelector(
      "[data-vex-reasoning-placeholder]",
    ) as HTMLElement;
    // 6.5rem is a preferred width now, not a min-width the row must honour.
    expect(placeholder.className).toContain("w-[6.5rem]");
    expect(placeholder.className).toContain("min-w-0");
    expect(placeholder.className).not.toContain("min-w-[6.5rem]");
    expect(placeholder.className).not.toContain("shrink-0");
  });

  it("the trailing cluster is protected: it never concedes", () => {
    const { container } = mountDocked();
    const seat = container.querySelector(
      '[data-vex-area="composer-permission-chip"]',
    ) as HTMLElement;
    const trailing = seat.parentElement as HTMLElement;
    expect(trailing.className).toContain("flex-none");
    // Every seat inside it is fixed.
    expect(seat.className).toContain("shrink-0");
    const meter = container.querySelector(
      '[data-vex-area="composer-context-ring"]',
    ) as HTMLElement;
    expect(meter.className).toContain("shrink-0");
    expect(
      container.querySelector('button[aria-label="Send message"]')?.className,
    ).toContain("shrink-0");
  });

  it("the permission LABEL collapses second, and the seat keeps its name", () => {
    const { container } = mountDocked({ permission: "full" });
    const seat = container.querySelector(
      '[data-vex-area="composer-permission-chip"]',
    ) as HTMLElement;
    const label = container.querySelector(
      "[data-vex-permission-label]",
    ) as HTMLElement;
    // The reference threshold, declared on the LABEL - never on the seat, and
    // never on a focusable control.
    expect(label.className).toContain("@max-[460px]:hidden");
    expect(label.className).toContain("truncate");
    // The invariant that makes the collapse safe: the accessible name is on
    // the seat, so hiding the text cannot leave an unnamed control.
    expect(seat.getAttribute("aria-label")).toBe("Access mode: Full access");
    expect(seat.className).not.toContain("@max-[460px]:hidden");
  });

  it("no focusable seat is clipped, and every one shows focus", () => {
    const { container } = mountDocked();
    const row = toolbarRow(container);
    // A blanket clip on a cluster would hide focusable controls that are still
    // reachable by keyboard.
    for (const cluster of Array.from(row.children)) {
      expect(cluster.className).not.toContain("overflow-hidden");
    }
    const focusables = Array.from(
      row.querySelectorAll<HTMLElement>("button, [tabindex]"),
    );
    expect(focusables.length).toBeGreaterThan(0);
    for (const node of focusables) {
      if (node.getAttribute("tabindex") === "0" && node.tagName === "SPAN") {
        // The static permission seat is a tooltip anchor, not a control.
        continue;
      }
      expect(node.className).toContain("focus-visible:ring");
    }
  });
});

describe("composer toolbar - the access-mode seat", () => {
  it("names the session grant beside the context meter and never offers a toggle", () => {
    const { container } = mountDocked({ permission: "restricted" });
    const seat = container.querySelector(
      '[data-vex-area="composer-permission-chip"]',
    ) as HTMLElement;
    expect(seat.textContent).toBe("Restricted");
    expect(seat.querySelector("button")).toBeNull();
    // Adjacency is the owner's requirement: mode next to the counter.
    expect(
      seat.nextElementSibling?.querySelector(
        '[data-vex-area="composer-context-ring"]',
      ),
    ).not.toBeNull();
  });
});

describe("composer toolbar - the context meter panel", () => {
  it("the trigger is a 28px button naming its percentage; no fabricated denominator", () => {
    contextWindow = { tokensUsed: 45_000, contextLimit: null };
    const { container, unmount } = mountDocked();
    expect(
      container.querySelector('[data-vex-area="composer-context-ring"]'),
    ).toBeNull();
    unmount();

    contextWindow = { tokensUsed: 45_000, contextLimit: 100_000 };
    const second = mountDocked();
    const trigger = second.container.querySelector(
      '[data-vex-area="composer-context-ring"]',
    ) as HTMLButtonElement;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-label")).toBe("Context 45% used");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.className).toContain("h-7");
    expect(trigger.className).toContain("w-7");
  });

  it("click opens a dialog with the occupancy sentence, the tokens and a TOTAL-ONLY bar", () => {
    contextWindow = {
      tokensUsed: 45_000,
      contextLimit: 100_000,
      pressureBarrierFraction: 0.8,
    };
    const { container } = mountDocked();
    fireEvent.click(
      container.querySelector(
        '[data-vex-area="composer-context-ring"]',
      ) as HTMLButtonElement,
    );
    const panel = screen.getByRole("dialog", { name: "Session context" });
    expect(panel.textContent).toContain("Context 45% used");
    expect(panel.textContent).toContain("45.0k of 100.0k tokens");
    expect(panel.textContent).toContain("Auto-compact at ~80%");
    expect(panel.textContent).toContain("lags the live turn by one");
    // The DTO carries no category split, so exactly one bar segment exists and
    // no legend is invented.
    expect(panel.querySelectorAll("[data-vex-context-bar]").length).toBe(1);
    expect(panel.textContent).not.toContain("Messages");
    expect(panel.textContent).not.toContain("Tools");
  });

  it("Escape closes the panel and returns focus to the trigger", () => {
    const { container } = mountDocked();
    const trigger = container.querySelector(
      '[data-vex-area="composer-context-ring"]',
    ) as HTMLButtonElement;
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("an outside pointer closes the panel without stealing focus back", () => {
    const { container } = mountDocked();
    fireEvent.click(
      container.querySelector(
        '[data-vex-area="composer-context-ring"]',
      ) as HTMLButtonElement,
    );
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the tooltip serves the closed state only - the two never stack", () => {
    const { container } = mountDocked();
    const trigger = container.querySelector(
      '[data-vex-area="composer-context-ring"]',
    ) as HTMLButtonElement;
    fireEvent.focus(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("composer - starter chips follow the STAGE", () => {
  it("the hero stage carries the slot", () => {
    const { container } = render(
      <SessionComposer
        activeSession={agentRow()}
        activeSessionId={SESSION}
        variant="hero"
      />,
    );
    expect(container.querySelector(".h-\\[60px\\]")).not.toBeNull();
  });

  it("the docked stage carries NO slot - no 60px remnant under the card", () => {
    const { container } = mountDocked();
    expect(container.querySelector(".h-\\[60px\\]")).toBeNull();
  });
});
