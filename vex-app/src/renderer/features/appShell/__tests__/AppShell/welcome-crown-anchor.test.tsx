/**
 * Welcome crown anchor — the owner-decreed "total smoothness" pass
 * (2026-07-22), carried into the RESIDENT SHELL (R2-D2): the crown (the hero
 * chrome) must NOT move when the composer pill grows or shrinks, and a
 * starter-chip pick must read as ONE gesture (chips fade + pill grows + caret
 * lands at the end of the seeded draft).
 *
 * WHAT RESIDENCY CHANGED, and what it did not. The hero chrome and the
 * composer used to be siblings in the panel's flex column, with the crown zone
 * balanced against a trailing spacer. They now live together INSIDE the
 * resident composer seat, which the scroll body flex-centres in the hero phase
 * — so the whole stack centres as one unit and the composer's DOM node
 * survives the move to the docked phase. The anchoring invariant is unchanged
 * and its mechanism is unchanged in kind: the crown is never inside the box
 * that grows, and the growing box has a FIXED layout height so growth
 * overflows DOWNWARD instead of re-centring the stack above it. Only the owner
 * of that fixed height moved, from a Tailwind class on the band to a
 * phase-scoped rule on `[data-vex-composer-dock]` in chat-transcript.css.
 *
 * WHY STRUCTURE, NOT PIXELS: jsdom has no layout engine — every element
 * reports offsetTop 0 and the textarea's scrollHeight is 0, so a numeric
 * "crown offsetTop is constant" assertion would pass vacuously even with the
 * co-centred-flex bug present. This suite pins the structure plus the CSS rule
 * that together guarantee the invariant in a real browser, and holds both
 * across the owner-reported chaos path (empty → chip-seeded long draft →
 * cleared draft) on the SAME nodes.
 *
 * Mount: real SessionPanel + real SessionComposer/ComposerQuickActions (the
 * growth mechanics under test); heavy session-branch children are stubbed, and
 * the hero is stubbed because the crown's SEATING belongs to SessionPanel.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The proven icon set for a real-SessionComposer mount (copied from
// composer-console.test.tsx — the quick-action chips consume IconFlame/
// ChartLineData01Icon/IconPercent, the send/stop key the arrows).
const mockSubmitChat = {
  isPending: false as boolean,
  mutateAsync: vi.fn(),
  stop: vi.fn(),
};
vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => mockSubmitChat,
  // The panel retires the welcome hero on the SEND edge (so the transcript is
  // mounted before the turn runs — see turnPreview's B1 arm). This suite is
  // about the idle crown's anchoring, so nothing here is ever submitting.
  useIsChatSubmitting: () => false,
}));
vi.mock("../../../../lib/api/messages.js", () => ({
  useTranscriptLiveSync: () => undefined,
  useTranscriptInfinite: () => ({
    data: undefined,
    isSuccess: false,
    isLoading: false,
  }),
  flattenTranscriptPages: () => [],
}));
vi.mock("../../../../lib/api/usage.js", () => ({
  useUsageLiveSync: () => undefined,
}));
vi.mock("../../../../lib/api/streams.js", () => ({
  useStreamPreviewSync: () => undefined,
}));
vi.mock("../../../../lib/api/runtime.js", () => ({
  useControlStateLiveSync: () => undefined,
  useRuntimeState: () => ({ data: { ok: true, data: { status: null } } }),
  // The composer now also routes Stop through the durable control plane.
  useRequestStop: () => ({ mutateAsync: async () => undefined }),
}));
vi.mock("../../../../lib/api/sessions.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../../../../lib/api/sessions.js")
  >();
  return {
    ...actual,
    useSession: () => ({ data: undefined, isLoading: false }),
  };
});
vi.mock("../../../../lib/api/models.js", () => ({
  // Capability unresolved → the quiet placeholder fills the effort slot.
  useAvailableModels: () => ({ data: undefined }),
}));
// Session-branch heavies + the hero: never mounted / not under test — the
// crown ZONE div being pinned belongs to SessionPanel itself.
vi.mock("../../SessionContext.js", () => ({ SessionContext: () => null }));
vi.mock("../../SessionTranscript.js", () => ({ SessionTranscript: () => null }));
vi.mock("../../MissionControls.js", () => ({ MissionControls: () => null }));
vi.mock("../../ApprovalsRegion.js", () => ({ ApprovalsRegion: () => null }));
vi.mock("../../SessionWelcomeHero.js", () => ({
  SessionWelcomeHero: () => <div data-vex-hero-stub />,
}));

const { SessionPanel } = await import("../../SessionPanel.js");
const { QUICK_ACTIONS } = await import("../../composer-quick-actions.js");
const { useUiStore } = await import("../../../../stores/uiStore.js");

// Raw stylesheet source — jsdom cannot compute CSS rules, so the growth
// transition contract is pinned against the file (the composer-console.test
// idiom: fs read anchored on the vitest project cwd, because the Tailwind
// transform rewrites the stylesheet a `?raw` import would see). globals.css
// is a thin manifest since the global-css/ split — concatenate ALL partials
// in manifest order so cross-partial assertions (composer growth in
// chronos-motion.css, console radius in console.css) scan one buffer.
const STYLES_DIR = join(process.cwd(), "src/renderer/styles");
const manifestCss = readFileSync(join(STYLES_DIR, "globals.css"), "utf8");
const partialPaths =
  manifestCss.match(/(?<=@import ")\.\/global-css\/[^"]+\.css(?=";)/g) ?? [];
if (partialPaths.length === 0) {
  throw new Error("globals.css manifest contains no global-css partial imports");
}
const GLOBALS_CSS = partialPaths
  .map((partialPath) => readFileSync(join(STYLES_DIR, partialPath), "utf8"))
  .join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmitChat.isPending = false;
  useUiStore.setState({
    activeSessionId: null,
    createSessionInitialTurn: null,
  });
});

function renderWelcome(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SessionPanel />
    </QueryClientProvider>,
  );
}

function crownOf(container: HTMLElement): HTMLElement {
  const crown = container.querySelector<HTMLElement>("[data-vex-hero-stub]");
  expect(crown).not.toBeNull();
  return crown as HTMLElement;
}

function bandOf(container: HTMLElement): HTMLElement {
  const band = container.querySelector<HTMLElement>(
    "[data-vex-composer-dock]",
  );
  expect(band).not.toBeNull();
  return band as HTMLElement;
}

function seatOf(container: HTMLElement): HTMLElement {
  const seat = container.querySelector<HTMLElement>(
    "[data-vex-composer-seat]",
  );
  expect(seat).not.toBeNull();
  return seat as HTMLElement;
}

/** The full anchor contract on the current DOM — reused across the cycle. */
function expectAnchoredStructure(container: HTMLElement): void {
  const crown = crownOf(container);
  const band = bandOf(container);
  const seat = seatOf(container);
  // Siblings inside the resident seat — the crown is never inside the box
  // that grows, and the growth band is never inside the crown.
  expect(band.contains(crown)).toBe(false);
  expect(crown.contains(band)).toBe(false);
  expect(crown.parentElement).toBe(band.parentElement);
  expect(seat.contains(crown)).toBe(true);
  expect(seat.contains(band)).toBe(true);
  // Crown DIRECTLY above the band in document order (growth expands
  // downward, away from the crown — nothing re-centrable sits between).
  expect(crown.nextElementSibling).toBe(band);
  // The band is inside the scrollport the shell flex-centres in hero phase;
  // the fixed height that keeps growth downward is asserted against the
  // stylesheet below (it is a phase-scoped rule, not a class).
  expect(
    container
      .querySelector("[data-vex-conversation-scroll]")
      ?.contains(seat),
  ).toBe(true);
  // The growing instrument lives INSIDE the band; its field slot wears the
  // transitioned-height class.
  const field = screen.getByLabelText("Session draft");
  expect(band.contains(field)).toBe(true);
  const slot = container.querySelector(".vex-composer-grow");
  expect(slot).not.toBeNull();
  expect(slot?.contains(field)).toBe(true);
}

describe("SessionPanel welcome - crown anchored above a downward growth band", () => {
  it("seats the crown zone as a sibling ABOVE the fixed-height composer band", () => {
    const { container } = renderWelcome();
    expectAnchoredStructure(container);
  });

  it("keeps the anchor, on the same nodes, across empty → chip-seeded long draft → cleared draft", async () => {
    const { container } = renderWelcome();
    const crown = crownOf(container);
    const band = bandOf(container);
    const initialCrownClass = crown.className;
    const initialBandClass = band.className;

    // Chip pick seeds the long starter prompt (the owner-reported chaos
    // trigger) and hides the chips row.
    fireEvent.click(
      screen.getByRole("button", { name: /hunt trending memecoins/i }),
    );
    const field = screen.getByLabelText(
      "Session draft",
    ) as HTMLTextAreaElement;
    expect(field.value).toBe(QUICK_ACTIONS[0]?.prompt);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /hunt trending memecoins/i }),
      ).toBeNull(),
    );
    // Same nodes (no remount), same classes: the crown zone and the band
    // are untouched by the draft — only content INSIDE the band changed.
    expect(crownOf(container)).toBe(crown);
    expect(bandOf(container)).toBe(band);
    expect(crown.className).toBe(initialCrownClass);
    expect(band.className).toBe(initialBandClass);
    expectAnchoredStructure(container);

    // Clearing the draft brings the chips back — and still moves nothing.
    fireEvent.change(field, { target: { value: "" } });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /hunt trending memecoins/i }),
      ).not.toBeNull(),
    );
    expect(crownOf(container)).toBe(crown);
    expect(bandOf(container)).toBe(band);
    expect(crown.className).toBe(initialCrownClass);
    expect(band.className).toBe(initialBandClass);
    expectAnchoredStructure(container);
  });

  it("a chip pick is one gesture: the field is focused with the caret at the end of the seeded draft", () => {
    renderWelcome();
    fireEvent.click(
      screen.getByRole("button", { name: /hunt trending memecoins/i }),
    );
    const field = screen.getByLabelText(
      "Session draft",
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
  });
});

describe("composer growth glide - globals.css contract (raw scan)", () => {
  /** First rule block for a selector (the composer-console.test helper). */
  function blockFor(selector: string): string {
    const start = GLOBALS_CSS.indexOf(`${selector} {`);
    expect(
      start,
      `selector missing from globals.css: ${selector}`,
    ).toBeGreaterThan(-1);
    const end = GLOBALS_CSS.indexOf("}", start);
    return GLOBALS_CSS.slice(start, end);
  }

  it("pins the hero growth band's fixed height, so pill growth overflows downward", () => {
    // The invariant the structural cases above cannot express in jsdom: with
    // a FIXED band height the flex-centred stack's leftover is constant, so
    // the crown cannot move opposite to the growth. 140px = mt-6 (24) +
    // resting pill (56) + starter-chip slot (60).
    const dock = blockFor(
      '[data-vex-area="session-panel"][data-phase="hero"] [data-vex-composer-dock]',
    );
    expect(dock).toContain("height: 140px");
    expect(dock).toContain("overflow: visible");
  });

  it("centres the hero stack with FLEX, never a transform", () => {
    // A transform on the scroll body would make it the containing block for
    // every `position: fixed` descendant (menus, dialogs), silently shrinking
    // them to this column. Flex centring has no such side effect.
    // Whitespace-tolerant: the selector spans two lines after formatting, so
    // this scans for the rule rather than an exact `selector {` prefix.
    const heroBody =
      /\[data-phase="hero"\]\s*>\s*\[data-vex-conversation-scroll\]\s*\{([^}]*)\}/.exec(
        GLOBALS_CSS,
      );
    expect(heroBody, "hero scroll-body centring rule missing").not.toBeNull();
    expect(heroBody?.[1]).toContain("justify-content: center");
    expect(heroBody?.[1]).not.toContain("transform");
  });

  it("transitions the field slot's measured height on the console's 220ms clock, with a clip mask", () => {
    const grow = blockFor(".vex-composer-grow");
    // The curve rides the ONE easing family token, not a hand-written
    // cubic-bezier (R2-D2 consolidation).
    expect(grow).toContain("transition: height 220ms var(--vex-ease-out)");
    expect(grow).toContain("overflow: clip");
    // No keyframe loop — a property transition, stilled by the global
    // reduced-motion catch-all.
    expect(grow).not.toContain("animation");
  });

  it("the capsule holds a CONSTANT r22 radius - no border-radius relax left to sync with", () => {
    // The height glide above used to share its 220ms clock with a radius
    // relax once; the capsule (catalog geometry) is a constant 22px surface,
    // so that second moving part stays gone: the radius is a static value
    // and nothing transitions it.
    const host = blockFor(".vex-composer-card");
    expect(host).toContain("border-radius: 22px");
    expect(host).not.toContain("transition");
  });
});
