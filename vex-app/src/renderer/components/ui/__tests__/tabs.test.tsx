/**
 * Tabs primitive tests — verifies the WAI-ARIA contract (roles,
 * aria-selected, roving tabindex), click + keyboard activation, and
 * controlled mode passing values through onValueChange.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { JSX } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs.js";

function harness(): JSX.Element {
  return (
    <Tabs defaultValue="alpha">
      <TabsList>
        <TabsTrigger value="alpha">Alpha</TabsTrigger>
        <TabsTrigger value="beta">Beta</TabsTrigger>
        <TabsTrigger value="gamma">Gamma</TabsTrigger>
      </TabsList>
      <TabsContent value="alpha">alpha-content</TabsContent>
      <TabsContent value="beta">beta-content</TabsContent>
      <TabsContent value="gamma">gamma-content</TabsContent>
    </Tabs>
  );
}

afterEach(() => {
  cleanup();
});

describe("Tabs primitive", () => {
  it("renders the active tab content and hides the rest (defaultValue)", () => {
    const { getByRole, queryByText, getAllByRole } = render(harness());
    expect(getByRole("tabpanel", { name: /Alpha/i })).toBeTruthy();
    // Alpha content should be visible; beta/gamma hidden.
    expect(queryByText("alpha-content")).toBeTruthy();
    expect(queryByText("beta-content")).toBeNull();
    expect(queryByText("gamma-content")).toBeNull();
    // ARIA: active trigger is aria-selected=true
    const triggers = getAllByRole("tab");
    expect(triggers[0]?.getAttribute("aria-selected")).toBe("true");
    expect(triggers[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("switches active tab via click (aria-selected updates, content swaps)", () => {
    const { getByRole, queryByText } = render(harness());
    fireEvent.click(getByRole("tab", { name: /Beta/i }));
    expect(queryByText("alpha-content")).toBeNull();
    expect(queryByText("beta-content")).toBeTruthy();
    expect(getByRole("tab", { name: /Beta/i }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("keyboard nav: ArrowRight cycles, End jumps to last", () => {
    const { getByRole, queryByText } = render(harness());
    const alpha = getByRole("tab", { name: /Alpha/i });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(queryByText("beta-content")).toBeTruthy();
    const beta = getByRole("tab", { name: /Beta/i });
    fireEvent.keyDown(beta, { key: "End" });
    expect(queryByText("gamma-content")).toBeTruthy();
    const gamma = getByRole("tab", { name: /Gamma/i });
    fireEvent.keyDown(gamma, { key: "ArrowRight" });
    // Cycle back to alpha
    expect(queryByText("alpha-content")).toBeTruthy();
  });

  it("walks every trigger in the tablist when each is wrapped with its own controls", () => {
    // A consumer may wrap a trigger with the controls that belong to its tab
    // (a close button cannot be a child of a button). The roving tabindex
    // finds the LIST, not the wrapper: through `parentElement` each trigger
    // would see only itself and ArrowRight would land where it started.
    const { getByRole, queryByText } = render(
      <Tabs defaultValue="alpha">
        <TabsList>
          <div>
            <TabsTrigger value="alpha">Alpha</TabsTrigger>
            <button type="button">close alpha</button>
          </div>
          <div>
            <TabsTrigger value="beta">Beta</TabsTrigger>
            <button type="button">close beta</button>
          </div>
        </TabsList>
        <TabsContent value="alpha">alpha-content</TabsContent>
        <TabsContent value="beta">beta-content</TabsContent>
      </Tabs>
    );
    const alpha = getByRole("tab", { name: "Alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(queryByText("beta-content")).toBeTruthy();
    expect(document.activeElement).toBe(getByRole("tab", { name: "Beta" }));
    fireEvent.keyDown(getByRole("tab", { name: "Beta" }), { key: "Home" });
    expect(queryByText("alpha-content")).toBeTruthy();
    expect(document.activeElement).toBe(alpha);
  });

  it("supports controlled mode via value + onValueChange", () => {
    const onChange = vi.fn();
    const Controlled = (): JSX.Element => (
      <Tabs value="alpha" onValueChange={onChange}>
        <TabsList>
          <TabsTrigger value="alpha">A</TabsTrigger>
          <TabsTrigger value="beta">B</TabsTrigger>
        </TabsList>
        <TabsContent value="alpha">alpha</TabsContent>
        <TabsContent value="beta">beta</TabsContent>
      </Tabs>
    );
    const { getByRole, queryByText } = render(<Controlled />);
    fireEvent.click(getByRole("tab", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("beta");
    // Still on alpha because parent didn't update value prop.
    expect(queryByText("alpha")).toBeTruthy();
  });
});
