/**
 * THE PICKER'S OWN CONTRACT, at the seam rather than through a dialog.
 *
 * What it must hold, after the owner's 2026-09-01 decision that the "Not
 * supported" cards leave the picker:
 *
 *   1. the roster it renders is exactly the SELECTABLE half of the catalogue -
 *      derived from the catalogue in the assertion, so the day an agent gains
 *      support this test follows the engine mirror instead of contradicting it;
 *   2. an unsupported id has no card, no checkbox and no label anywhere in the
 *      output, so there is no event for any caller to dispatch;
 *   3. a toggle reports the id and the new checked state to its owner, and the
 *      group's `disabled` prop (a submit in flight) is the ONLY thing that
 *      disables a card.
 *
 * The catalogue's fidelity to the engine registry is `studio-agent-catalogue
 * .test.ts`'s job and is deliberately not re-asserted here.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentPicker } from "../AgentPicker.js";
import {
  SELECTABLE_STUDIO_AGENT_IDS,
  STUDIO_AGENT_PRESENTATIONS,
} from "../studio-agent-catalogue.js";

const UNSUPPORTED = STUDIO_AGENT_PRESENTATIONS.filter((agent) => !agent.supported);

describe("the roster it renders", () => {
  it("renders every selectable agent and no unsupported one", () => {
    render(
      <AgentPicker selected={[]} onToggle={vi.fn()} />,
    );
    const cards = document.querySelectorAll("[data-vex-agent]");
    expect(cards).toHaveLength(SELECTABLE_STUDIO_AGENT_IDS.length);
    expect(
      Array.from(cards).map((card) => card.getAttribute("data-vex-agent")),
    ).toEqual([...SELECTABLE_STUDIO_AGENT_IDS]);

    // The catalogue still HAS them - that is the point of the decision, the ids
    // are persisted - and this seam still renders none of them.
    expect(UNSUPPORTED.length).toBeGreaterThan(0);
    for (const agent of UNSUPPORTED) {
      expect(document.querySelector(`[data-vex-agent="${agent.id}"]`)).toBeNull();
      expect(screen.queryByText(agent.displayName)).toBeNull();
    }
    // Literal on purpose: the copy constant was deleted with the unsupported
    // branch (dead code decree); the assertion guards the words themselves.
    expect(screen.queryByText("Not supported")).toBeNull();
  });

  it("reports a toggle with the id and the new state", () => {
    const onToggle = vi.fn();
    render(<AgentPicker selected={["codex"]} onToggle={onToggle} />);

    const codex = screen.getByRole("checkbox", { name: /Codex CLI/ });
    expect((codex as HTMLInputElement).checked).toBe(true);
    fireEvent.click(codex);
    expect(onToggle).toHaveBeenCalledWith("codex", false);

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    expect(onToggle).toHaveBeenLastCalledWith("cursor", true);
  });

  it("disables every card only while the group is disabled", () => {
    const onToggle = vi.fn();
    const { unmount } = render(
      <AgentPicker selected={[]} onToggle={onToggle} />,
    );
    for (const card of screen.getAllByRole("checkbox")) {
      expect((card as HTMLInputElement).disabled).toBe(false);
    }
    unmount();

    render(<AgentPicker selected={[]} onToggle={onToggle} disabled />);
    for (const card of screen.getAllByRole("checkbox")) {
      expect((card as HTMLInputElement).disabled).toBe(true);
    }
  });
});
