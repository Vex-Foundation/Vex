/**
 * The agent's capital ceiling, and the one refusal it must never swallow.
 *
 * The property under test is deepseek-harness's revisioned-settings stance: a
 * write that carries a stale revision is REFUSED and the person is told, rather
 * than applied over whoever saved first. Here that means the conflict copy plus
 * a reload action, and a Save that carries the revision the field was seeded
 * with.
 *
 * RED ON REVERT: drop `expectedRevision` from the Save call and the "carries
 * the revision it read" test fails; render the conflict as an ordinary save
 * failure and the conflict test fails by name.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LighterCapitalShareCard } from "../LighterCapitalShareCard.js";
import {
  CAPITAL_SHARE_CONFLICT,
  CAPITAL_SHARE_HELPER,
  CAPITAL_SHARE_INVALID,
  CAPITAL_SHARE_LABEL,
  CAPITAL_SHARE_LOADING,
  CAPITAL_SHARE_RELOAD,
} from "../lighter-trading-setup-copy.js";

afterEach(cleanup);

function field(): HTMLInputElement {
  return screen.getByLabelText(CAPITAL_SHARE_LABEL) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

it("says it is still reading rather than showing an empty ceiling", () => {
  render(
    <LighterCapitalShareCard
      read={{ kind: "loading" }}
      write={{ kind: "idle" }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(CAPITAL_SHARE_LOADING);
  expect(field().disabled).toBe(true);
  expect(saveButton().disabled).toBe(true);
});

it("seeds the field from the saved value and shows its revision", () => {
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 3 }}
      write={{ kind: "idle" }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(field().value).toBe("40");
  expect(screen.getByRole("status").textContent).toBe("Saved: 40% (revision 3)");
  // Nothing typed yet is nothing to write.
  expect(saveButton().disabled).toBe(true);
});

it("shows no limit for a null share and states the enforcement", () => {
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: null, revision: 1 }}
      write={{ kind: "idle" }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(field().value).toBe("");
  expect(screen.getByRole("status").textContent).toBe("Saved: No limit (revision 1)");
  expect(document.body.textContent).toContain(CAPITAL_SHARE_HELPER);
});

it("carries the revision it read on Save", () => {
  const onSave = vi.fn();
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 3 }}
      write={{ kind: "idle" }}
      onSave={onSave}
      onReload={vi.fn()}
    />,
  );
  fireEvent.change(field(), { target: { value: "25" } });
  fireEvent.click(saveButton());
  expect(onSave).toHaveBeenCalledWith(25, 3);
});

it("writes null, not zero, when the field is cleared", () => {
  const onSave = vi.fn();
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 2 }}
      write={{ kind: "idle" }}
      onSave={onSave}
      onReload={vi.fn()}
    />,
  );
  fireEvent.change(field(), { target: { value: "" } });
  fireEvent.click(saveButton());
  expect(onSave).toHaveBeenCalledWith(null, 2);
});

it("refuses an out-of-range share before it reaches main", () => {
  const onSave = vi.fn();
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 2 }}
      write={{ kind: "idle" }}
      onSave={onSave}
      onReload={vi.fn()}
    />,
  );
  fireEvent.change(field(), { target: { value: "150" } });
  expect(screen.getByRole("status").textContent).toBe(CAPITAL_SHARE_INVALID);
  expect(saveButton().disabled).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
});

it("tells the person about a stale revision and offers a reload, never a silent overwrite", () => {
  const onReload = vi.fn();
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 3 }}
      write={{ kind: "conflict" }}
      onSave={vi.fn()}
      onReload={onReload}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(CAPITAL_SHARE_CONFLICT);
  const reload = screen.getByRole("button", { name: CAPITAL_SHARE_RELOAD });
  fireEvent.click(reload);
  expect(onReload).toHaveBeenCalledTimes(1);
});

it("names a save failure instead of collapsing it into the conflict", () => {
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 3 }}
      write={{ kind: "failed", reason: "Vex is locked." }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Vex could not save the share: Vex is locked.",
  );
  expect(screen.queryByRole("button", { name: CAPITAL_SHARE_RELOAD })).toBeNull();
});

it("re-seeds the field when a reload brings a newer revision", () => {
  const { rerender } = render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 3 }}
      write={{ kind: "idle" }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  fireEvent.change(field(), { target: { value: "25" } });
  rerender(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 60, revision: 4 }}
      write={{ kind: "idle" }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(field().value).toBe("60");
});

it("says nothing is saved yet for a null revision, and the first write carries null", () => {
  const onSave = vi.fn();
  render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: null, revision: null }}
      write={{ kind: "idle" }}
      onSave={onSave}
      onReload={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Nothing saved yet, so the agent has no ceiling on this account.",
  );
  // Nothing stored and nothing typed is nothing to write.
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(field(), { target: { value: "30" } });
  fireEvent.click(saveButton());
  expect(onSave).toHaveBeenCalledWith(30, null);
});

it("does not wipe a value being typed when the card merely re-renders", () => {
  const { rerender } = render(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 3 }}
      write={{ kind: "idle" }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  fireEvent.change(field(), { target: { value: "25" } });
  rerender(
    <LighterCapitalShareCard
      read={{ kind: "ready", percent: 40, revision: 3 }}
      write={{ kind: "idle" }}
      onSave={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(field().value).toBe("25");
});
