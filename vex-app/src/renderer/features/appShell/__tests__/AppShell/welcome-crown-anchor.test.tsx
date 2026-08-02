/**
 * Welcome crown anchor — the owner-decreed "total smoothness" pass
 * (2026-07-22): the crown (logo-row zone) must NOT move when the composer
 * pill grows or shrinks, and a starter-chip pick must read as ONE gesture
 * (chips fade + pill grows + caret lands at the end of the seeded draft).
 *
 * WHY STRUCTURE, NOT PIXELS: jsdom has no layout engine — every element
 * reports offsetTop 0 and the textarea's scrollHeight is 0, so a numeric
 * "crown offsetTop is constant" assertion would pass vacuously even with
 * the co-centered-flex bug present. Instead this suite pins the STRUCTURE
 * that mathematically guarantees the invariant in a real browser:
 *
 *   - the crown zone (`[data-vex-welcome-crown]`) and the composer growth
 *     band (`[data-vex-composer-band]`) are SIBLINGS, crown first — the
 *     crown is never a child of the element that grows;
 *   - the band carries a FIXED layout height (h-[140px], the resting
 *     composer stack: mt-6 24px + 56px pill + 60px chips slot) + shrink-0,
 *     so the flex-1 leftover the crown zone shares is a CONSTANT — pill
 *     auto-grow overflows the band DOWNWARD instead of re-centering the
 *     column (the old bug: [flex-1 crown][auto composer][flex-1 spacer]
 *     re-split the leftover on every height delta, moving the crown
 *     opposite to growth);
 *   - both facts hold, on the SAME nodes (no remount), across the exact
 *     owner-reported chaos path: empty draft → chip-seeded long draft →
 *     cleared draft;
 *   - the field slot wears `.vex-composer-grow`, whose globals.css rule
 *     transitions the measured height on the SAME 220ms clock/curve as
 *     `.vex-console`'s border-radius relax (raw-source scan — the
 *     composer-console.test idiom, since jsdom cannot compute stylesheet
 *     rules).
 *
 * Mount: real SessionPanel + real SessionComposer/ComposerQuickActions
 * (the growth mechanics under test); heavy session-branch children and the
 * hero are stubbed (the crown ZONE div under test belongs to SessionPanel,
 * not the hero) — the SessionPanel-enter-animation harness idiom.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));

// The proven icon set for a real-SessionComposer mount (copied from
// composer-console.test.tsx — the quick-action chips consume FireIcon/
// ChartLineData01Icon/PercentSquareIcon, the send/stop key the arrows).
vi.mock("../../../../components/icons/icon-glyphs.js", () => ({
  Add01Icon: "Add01Icon",
  CheckmarkCircle02Icon: "CheckmarkCircle02Icon",
  Download01Icon: "Download01Icon",
  ArrowDown01Icon: "ArrowDown01Icon",
  ArrowUp01Icon: "ArrowUp01Icon",
  ArrowRight01Icon: "ArrowRight01Icon",
  Wallet01Icon: "Wallet01Icon",
  MapPinIcon: "MapPinIcon",
  AiBrain05Icon: "AiBrain05Icon",
  StopCircleIcon: "StopCircleIcon",
  FireIcon: "FireIcon",
  RocketIcon: "RocketIcon",
  ChartLineData01Icon: "ChartLineData01Icon",
  PercentSquareIcon: "PercentSquareIcon",
}));

const mockSubmitChat = {
  isPending: false as boolean,
  mutateAsync: vi.fn(),
  stop: vi.fn(),
};
vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => mockSubmitChat,
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
  const crown = container.querySelector<HTMLElement>(
    "[data-vex-welcome-crown]",
  );
  expect(crown).not.toBeNull();
  return crown as HTMLElement;
}

function bandOf(container: HTMLElement): HTMLElement {
  const band = container.querySelector<HTMLElement>(
    "[data-vex-composer-band]",
  );
  expect(band).not.toBeNull();
  return band as HTMLElement;
}

/** The full anchor contract on the current DOM — reused across the cycle. */
function expectAnchoredStructure(container: HTMLElement): void {
  const crown = crownOf(container);
  const band = bandOf(container);
  // Siblings — the crown is never inside the element that grows, and the
  // growth band is never inside the crown zone.
  expect(band.contains(crown)).toBe(false);
  expect(crown.contains(band)).toBe(false);
  expect(crown.parentElement).toBe(band.parentElement);
  // Crown DIRECTLY above the band in document order (growth expands
  // downward, away from the crown — nothing re-centerable sits between).
  expect(crown.nextElementSibling).toBe(band);
  // FIXED layout height: h-[140px] (the resting composer stack) + shrink-0.
  // This is what makes the flex leftover — and the crown position —
  // independent of pill height in a real browser.
  expect(band.className).toContain("h-[140px]");
  expect(band.className).toContain("shrink-0");
  // The growing instrument lives INSIDE the band; its field slot wears the
  // transitioned-height class.
  const field = screen.getByLabelText("Session draft");
  expect(band.contains(field)).toBe(true);
  const slot = container.querySelector(".vex-composer-grow");
  expect(slot).not.toBeNull();
  expect(slot?.contains(field)).toBe(true);
}

describe("SessionPanel welcome — crown anchored above a downward growth band", () => {
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

describe("composer growth glide — globals.css contract (raw scan)", () => {
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

  it("transitions the field slot's measured height on the console's 220ms clock, with a clip mask", () => {
    const grow = blockFor(".vex-composer-grow");
    expect(grow).toContain("transition: height 220ms cubic-bezier(0.25, 1, 0.5, 1)");
    expect(grow).toContain("overflow: clip");
    // No keyframe loop — a property transition, stilled by the global
    // reduced-motion catch-all.
    expect(grow).not.toContain("animation");
  });

  it("the console holds a CONSTANT radius — no border-radius relax left to sync with", () => {
    // The height glide above used to share its 220ms clock with the pill's
    // rounded-full ⇄ rounded-[28px] relax, so the two moved as one gesture.
    // The rebuilt console (owner decree 2026-07-29) is a constant rounded-2xl
    // surface, so that second moving part is gone. Assert its ABSENCE: a
    // reintroduced relax would otherwise silently drift off this clock.
    const host = blockFor(".vex-console");
    expect(host).not.toContain("border-radius");
  });
});
