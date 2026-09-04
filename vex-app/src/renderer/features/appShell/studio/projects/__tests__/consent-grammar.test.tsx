/**
 * THE CONSENT GRAMMAR, across the surfaces that had no suite of their own.
 *
 * `DialogConsequence` is the primitive every consent dialog leads with, and the
 * three properties asserted here are the ones the strip exists for:
 *
 *   1. it is OUTSIDE the body's scroll container, so the consequence cannot be
 *      scrolled away from the button that performs it (the same property
 *      `DialogPinnedSlot` holds for the answer, asserted the same way - by the
 *      DOM marker `data-vex-dialog-body`);
 *   2. it states WHAT, TO WHAT and WHETHER IT CAN BE UNDONE;
 *   3. the register is the ACT's, not the dialog's: Repair reads in `notice`
 *      and its primary is no longer the destructive red, which is audit A10.
 *
 * RED ON REVERT: give `ProjectRepairDialog` its `variant="danger"` back and
 * "repair is not dressed as a destructive action" fails; move the strip inside
 * `DialogBody` and "the strip is outside the scroll region" fails; delete the
 * undo line from the copy table and the content assertions fail by name.
 *
 * Matchers are plain Vitest/Chai (this repository installs no jest-dom).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installStudioDomStubs, makeProject } from "../../__tests__/studio-fixtures.js";
import { StudioKeepAliveDialog } from "../../StudioKeepAliveDialog.js";
import { ProjectRepairDialog } from "../ProjectRepairDialog.js";
import {
  PROJECT_CLOSE_CONSEQUENCE_SCOPE,
  PROJECT_CLOSE_CONSEQUENCE_UNDO,
  PROJECT_CLOSE_CONSEQUENCE_WHAT,
  PROJECT_REPAIR_CONSEQUENCE_SCOPE,
  PROJECT_REPAIR_CONSEQUENCE_UNDO,
  PROJECT_REPAIR_CONSEQUENCE_WHAT,
  projectFolderLine,
} from "../projects-copy.js";

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { projects: { repairFiles: vi.fn() } },
  });
});

function strip(): HTMLElement {
  const node = document.querySelector("[data-vex-dialog-consequence]");
  if (!(node instanceof HTMLElement)) throw new Error("no consequence strip");
  return node;
}

function renderRepair(project = makeProject({ name: "atlas" })): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectRepairDialog project={project} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("the repair dialog's consent strip", () => {
  it("states what, to what and whether it can be undone", () => {
    const project = makeProject({ name: "atlas" });
    renderRepair(project);
    const text = strip().textContent ?? "";
    expect(text).toContain(PROJECT_REPAIR_CONSEQUENCE_WHAT);
    expect(text).toContain(projectFolderLine(project.displayPath));
    expect(text).toContain(PROJECT_REPAIR_CONSEQUENCE_SCOPE);
    expect(text).toContain(PROJECT_REPAIR_CONSEQUENCE_UNDO);
  });

  it("sits outside the body's scroll region", () => {
    renderRepair();
    const body = document.querySelector("[data-vex-dialog-body]");
    expect(body).not.toBeNull();
    // The whole point: a consequence painted below the fold of a scrolling
    // body is a consequence the user never read.
    expect(body?.contains(strip())).toBe(false);
  });

  it("reads in the notice register, not the destructive one (audit A10)", () => {
    renderRepair();
    expect(strip().getAttribute("data-vex-dialog-consequence")).toBe("notice");
  });

  it("does not dress repair as a destructive action", () => {
    renderRepair();
    const repair = screen.getByRole("button", { name: "Repair" });
    // `data-vex-button` carries the resolved variant (`components/ui/button
    // .tsx`). Delete keeps `danger` to itself so the tone still means
    // something; Repair rewrites files Vex maintains and can rewrite again.
    expect(repair.getAttribute("data-vex-button")).toBe("primary");
  });

  it("focuses the safer choice and routes Escape through the close intent", () => {
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <ProjectRepairDialog project={makeProject({ name: "atlas" })} onClose={onClose} />
      </QueryClientProvider>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );

    const dialog = document.querySelector("dialog");
    if (dialog === null) throw new Error("no dialog");
    // The `cancel` event IS the browser's Escape intent on a modal `<dialog>`.
    // The jsdom polyfill implements `showModal` without the UA key handling,
    // so it is dispatched directly; what is under test is
    // that the component routes that intent through the controlled path.
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the keep-alive dialog's consent strip", () => {
  const rows = [
    makeProject({ name: "atlas" }),
    makeProject({ name: "borealis" }),
  ];

  function renderKeepAlive(): { readonly onCancel: ReturnType<typeof vi.fn> } {
    const onCancel = vi.fn();
    render(
      <StudioKeepAliveDialog
        requestedProject={makeProject({ name: "cygnus" })}
        openProjects={rows}
        onCancel={onCancel}
        onCloseWorkspace={vi.fn()}
      />,
    );
    return { onCancel };
  }

  it("states the consequence once, above rows that each carry a Close button", () => {
    renderKeepAlive();
    const text = strip().textContent ?? "";
    expect(text).toContain(PROJECT_CLOSE_CONSEQUENCE_WHAT);
    expect(text).toContain(PROJECT_CLOSE_CONSEQUENCE_SCOPE);
    expect(text).toContain(PROJECT_CLOSE_CONSEQUENCE_UNDO);
    // Above the rows and outside their scroll region: the per-row terminal
    // count is OMITTED for a project this window cannot see, so the strip is
    // the only statement that holds for every button in the list.
    const body = document.querySelector("[data-vex-dialog-body]");
    expect(body?.contains(strip())).toBe(false);
  });

  it("gives every Close button a name of its own (audit I3)", () => {
    renderKeepAlive();
    const closes = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    const names = closes.filter((name): name is string => name !== null);
    // Two controls sharing one accessible name leave a screen-reader user with
    // no way to tell which project they are about to close.
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => name.includes("atlas"))).toBe(true);
    expect(names.some((name) => name.includes("borealis"))).toBe(true);
  });

  it("marks Cancel with the autofocus attribute a browser will honour", () => {
    renderKeepAlive();
    // `document.activeElement` alone was NOT sufficient evidence here and
    // passed while a browser did the opposite: React does not emit `autoFocus`
    // as a content attribute, and the jsdom stub of the day ran no focusing
    // steps. Every row above this footer holds a `Close` button that ends
    // running shells, so the platform's own fallback - the first focusable
    // descendant - is the most dangerous control in the dialog.
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("autofocus"),
    ).toBe(true);
  });

  it("focuses the safer choice and routes Escape through the cancel intent", () => {
    const { onCancel } = renderKeepAlive();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    const dialog = document.querySelector("dialog");
    if (dialog === null) throw new Error("no dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalled();
  });
});
