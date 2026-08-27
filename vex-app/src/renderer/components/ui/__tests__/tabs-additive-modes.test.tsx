/**
 * THE TABS PRIMITIVE'S TWO ADDITIVE MODES (A10).
 *
 * `idScope` and `keepMounted` exist because the BOOK needs them: two tab sets
 * can coexist in one shell, and the Portfolio panel must not lose its state
 * every time the reader glances at the board. Both are opt-in, so the claim
 * this file protects hardest is the negative one - a consumer that passes
 * neither renders exactly what it rendered before either prop existed.
 *
 * The counter probe below is the instrument for "state survived": a component
 * that remounts loses its count, and no amount of correct markup can fake it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type JSX } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs.js";

afterEach(() => {
  cleanup();
});

/** Counts its own clicks. A remount resets it to zero. */
function Counter({ label }: { readonly label: string }): JSX.Element {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-testid={`counter-${label}`} onClick={() => setCount(count + 1)}>
      {label}:{String(count)}
    </button>
  );
}

function set(props: {
  readonly idScope?: string;
  readonly keepMounted?: boolean;
}): JSX.Element {
  return (
    <Tabs defaultValue="alpha" {...props}>
      <TabsList>
        <TabsTrigger value="alpha">Alpha</TabsTrigger>
        <TabsTrigger value="beta">Beta</TabsTrigger>
      </TabsList>
      <TabsContent value="alpha">
        <Counter label="alpha" />
      </TabsContent>
      <TabsContent value="beta">
        <Counter label="beta" />
      </TabsContent>
    </Tabs>
  );
}

describe("defaults are byte-identical to the pre-prop primitive", () => {
  it("emits the historical unscoped ids", () => {
    const { getAllByRole } = render(set({}));
    const [alpha, beta] = getAllByRole("tab");
    expect(alpha?.id).toBe("tab-alpha");
    expect(alpha?.getAttribute("aria-controls")).toBe("tabpanel-alpha");
    expect(beta?.id).toBe("tab-beta");
    const panel = document.getElementById("tabpanel-alpha");
    expect(panel?.getAttribute("aria-labelledby")).toBe("tab-alpha");
  });

  it("still unmounts the inactive panel's children, and adds no new attributes", () => {
    const { queryByTestId } = render(set({}));
    expect(queryByTestId("counter-alpha")).toBeTruthy();
    expect(queryByTestId("counter-beta")).toBeNull();
    const panel = document.getElementById("tabpanel-beta");
    expect(panel?.hasAttribute("aria-hidden")).toBe(false);
    expect(panel?.hasAttribute("inert")).toBe(false);
  });
});

describe("idScope", () => {
  it("namespaces both ids and keeps aria-controls pointing at its own panel", () => {
    const { getAllByRole } = render(set({ idScope: "book" }));
    const [alpha] = getAllByRole("tab");
    expect(alpha?.id).toBe("tab-book-alpha");
    expect(alpha?.getAttribute("aria-controls")).toBe("tabpanel-book-alpha");
    const panel = document.getElementById("tabpanel-book-alpha");
    expect(panel?.getAttribute("aria-labelledby")).toBe("tab-book-alpha");
  });

  it("lets two tab sets share VALUES without sharing ids", () => {
    render(
      <>
        {set({ idScope: "book" })}
        {set({ idScope: "modal" })}
      </>,
    );
    // The collision the unscoped ids would have produced: one `tab-alpha`
    // claimed by whichever set mounted first, with the other set's
    // `aria-controls` pointing into it.
    expect(document.querySelectorAll("#tab-book-alpha")).toHaveLength(1);
    expect(document.querySelectorAll("#tab-modal-alpha")).toHaveLength(1);
    expect(document.querySelectorAll("#tab-alpha")).toHaveLength(0);
  });
});

describe("keepMounted", () => {
  it("keeps the inactive panel in the DOM, hidden, aria-hidden and inert", () => {
    const { queryByTestId } = render(set({ keepMounted: true }));
    expect(queryByTestId("counter-beta")).toBeTruthy();
    const dormant = document.getElementById("tabpanel-beta");
    expect(dormant?.hasAttribute("hidden")).toBe(true);
    expect(dormant?.getAttribute("aria-hidden")).toBe("true");
    expect(dormant?.hasAttribute("inert")).toBe(true);

    const active = document.getElementById("tabpanel-alpha");
    expect(active?.hasAttribute("hidden")).toBe(false);
    expect(active?.hasAttribute("aria-hidden")).toBe(false);
    expect(active?.hasAttribute("inert")).toBe(false);
  });

  it("moves the three attributes with the selection", () => {
    const { getByRole } = render(set({ keepMounted: true }));
    fireEvent.click(getByRole("tab", { name: "Beta" }));
    expect(document.getElementById("tabpanel-alpha")?.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("tabpanel-beta")?.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("tabpanel-beta")?.hasAttribute("hidden")).toBe(false);
  });

  it("PRESERVES the dormant panel's state across a switch (the whole point)", () => {
    const { getByRole, getByTestId } = render(set({ keepMounted: true }));
    fireEvent.click(getByTestId("counter-alpha"));
    fireEvent.click(getByTestId("counter-alpha"));
    expect(getByTestId("counter-alpha").textContent).toBe("alpha:2");

    fireEvent.click(getByRole("tab", { name: "Beta" }));
    fireEvent.click(getByRole("tab", { name: "Alpha" }));

    // A remount would read alpha:0.
    expect(getByTestId("counter-alpha").textContent).toBe("alpha:2");
  });

  it("without it, the same round trip resets the panel", () => {
    const { getByRole, getByTestId } = render(set({}));
    fireEvent.click(getByTestId("counter-alpha"));
    expect(getByTestId("counter-alpha").textContent).toBe("alpha:1");
    fireEvent.click(getByRole("tab", { name: "Beta" }));
    fireEvent.click(getByRole("tab", { name: "Alpha" }));
    expect(getByTestId("counter-alpha").textContent).toBe("alpha:0");
  });
});

describe("roving focus survives both modes", () => {
  it("only the selected trigger is in the tab order, scoped and keep-mounted", () => {
    const { getAllByRole, getByRole } = render(
      set({ idScope: "book", keepMounted: true }),
    );
    const tabIndexes = (): readonly (string | null)[] =>
      getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"));
    expect(tabIndexes()).toEqual(["0", "-1"]);

    fireEvent.click(getByRole("tab", { name: "Beta" }));
    expect(tabIndexes()).toEqual(["-1", "0"]);
  });

  it("arrow keys still move the selection and the focus", () => {
    const { getByRole } = render(set({ idScope: "book", keepMounted: true }));
    const alpha = getByRole("tab", { name: "Alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });

    const beta = getByRole("tab", { name: "Beta" });
    expect(beta.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(beta);
    // `aria-controls` follows the scope, so the moved focus still announces
    // the panel that actually belongs to this set.
    expect(beta.getAttribute("aria-controls")).toBe("tabpanel-book-beta");
  });
});
