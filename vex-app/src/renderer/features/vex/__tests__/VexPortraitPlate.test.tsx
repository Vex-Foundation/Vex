/**
 * VexPortraitPlate - Kimm's section's mount point in Vex's column
 * (docs/design/H3-DESKTOP.md sections 1.5, 1.6 and 3.4). The drawing is
 * `KimmSection`'s (its own suite); the first close's hint is
 * `kimm-hint.test.tsx`'s. What the mount owns is pinned here:
 *
 *  - her mood follows Vex's presence state, through `kimmMoodOf`;
 *  - the corner key's tooltip and `aria-keyshortcuts` spell the platform's
 *    chord (`KIMM_SHORTCUT`);
 *  - the corner key hides her through the frame's `onHide` when it is given,
 *    and otherwise writes the page class's stored choice (`setVexOpen`), as
 *    it does to show her;
 *  - her section carries the id every toggle names in `aria-controls`, and
 *    her corner key names it too, with no state attribute (EC-01); its press
 *    is said, "Vex shown." or "Vex hidden." (EC-24);
 *  - the plate is her section alone: no print, no other image, no second
 *    figure under it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useUiStore } from "../../../stores/uiStore.js";
import { kimmMoodOf } from "../kimm-mood.js";
import { VEX_STATES } from "../vex-state.js";
import { KIMM_SHORTCUT, VexPortraitPlate } from "../VexPortraitPlate.js";
import { VexSectionAnnouncer } from "../VexSectionAnnouncer.js";
import { VEX_SECTION_ID } from "../vex-section-a11y.js";

function section(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-vex-area='kimm-section']");
  if (el === null) throw new Error("her section is missing");
  return el;
}

function cornerKey(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-vex-area='kimm-key']");
  if (el === null) throw new Error("her corner key is missing");
  return el;
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    runtimeMode: "agent",
    shellRoute: { kind: "none" },
    vexOpenChat: true,
    kimmHintShown: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("VexPortraitPlate", () => {
  it("shows her mood for each presence state", () => {
    for (const state of VEX_STATES) {
      const view = render(<VexPortraitPlate state={state} open />);
      expect(section(view.container).getAttribute("data-kimm-mood")).toBe(kimmMoodOf(state));
      view.unmount();
    }
  });

  it("spells the platform's chord on her corner key", () => {
    const view = render(<VexPortraitPlate state="ready" open />);
    const key = cornerKey(view.container);
    expect(key.getAttribute("aria-keyshortcuts")).toBe(KIMM_SHORTCUT.aria);
    expect(key.getAttribute("title")).toBe(`Hide Vex (${KIMM_SHORTCUT.label})`);
  });

  it("hides her through the frame's onHide, and never writes the choice itself then", () => {
    const onHide = vi.fn();
    const view = render(<VexPortraitPlate state="ready" open onHide={onHide} />);
    fireEvent.click(cornerKey(view.container));
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
  });

  it("writes the page class's stored choice without onHide, and to show her", () => {
    const view = render(<VexPortraitPlate state="ready" open />);
    fireEvent.click(cornerKey(view.container));
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    view.rerender(<VexPortraitPlate state="ready" open={false} onHide={() => undefined} />);
    fireEvent.click(cornerKey(view.container));
    expect(useUiStore.getState().vexOpenChat).toBe(true);
  });

  it("names her section for every toggle's aria-controls, her corner key too (EC-01)", () => {
    const view = render(<VexPortraitPlate state="ready" open />);
    expect(section(view.container).id).toBe(VEX_SECTION_ID);
    const key = cornerKey(view.container);
    expect(key.getAttribute("aria-controls")).toBe(VEX_SECTION_ID);
    expect(key.hasAttribute("aria-expanded")).toBe(false);
    expect(key.hasAttribute("aria-pressed")).toBe(false);
  });

  it("says her corner key's press once, politely, as every toggle's (EC-24)", () => {
    const view = render(
      <>
        <VexPortraitPlate state="ready" open onHide={() => undefined} />
        <VexSectionAnnouncer />
      </>,
    );
    const said = (): string =>
      Array.from(document.querySelectorAll("[data-vex-area='vex-section-announcer'] [role='status']"))
        .map((r) => r.textContent)
        .join("");
    fireEvent.click(cornerKey(view.container));
    expect(said()).toBe("Vex hidden.");
    view.rerender(
      <>
        <VexPortraitPlate state="ready" open={false} onHide={() => undefined} />
        <VexSectionAnnouncer />
      </>,
    );
    fireEvent.click(cornerKey(view.container));
    expect(said()).toBe("Vex shown.");
  });

  it("is her section alone: no print window and no second figure beside it", () => {
    const view = render(<VexPortraitPlate state="working" open />);
    expect(Array.from(view.container.children)).toEqual([section(view.container)]);
    expect(view.container.querySelector("[data-vex-area='vex-portrait-plate']")).toBeNull();
  });
});
