/**
 * The consent surface for a leverage change.
 *
 * The four properties asserted here are the ones this dialog exists for, and
 * they are this repository's consent grammar (see `consent-grammar.test.tsx`):
 *
 *   1. it renders MAIN'S proposal - the terms, the account, and the expiry -
 *      and Confirm sends back only the proposal id, so nothing on this side can
 *      restate what gets signed;
 *   2. the consequence sentence sits OUTSIDE the body's scroll container, so it
 *      cannot be scrolled away from the button that performs the change;
 *   3. focus opens on Cancel, not on Confirm, and Escape cancels;
 *   4. focus comes back to the control that opened the dialog, including on the
 *      unmount path the card actually uses once main answers.
 *
 * RED ON REVERT: point `DIALOG_INITIAL_FOCUS` at Confirm and the focus test
 * fails; move the consequence strip inside `DialogBody` and the scroll-region
 * test fails; send anything but `proposalId` on Confirm and the last test fails.
 *
 * The native `<dialog>` modal methods jsdom lacks - WITH the browser's focusing
 * steps - are installed for every renderer suite by `test/setup.ts`, which is
 * what makes the `document.activeElement` assertions evidence.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LighterLeverageConfirmModal } from "../LighterLeverageConfirmModal.js";
import type { LighterLeverageIssuedProposal } from "../LighterLeverageConfirmModal.js";
import {
  CONFIRM_OBSERVATION_NOTE,
  leverageConsequenceSentence,
} from "../lighter-trading-setup-copy.js";

afterEach(cleanup);

const PROPOSAL: LighterLeverageIssuedProposal = {
  kind: "proposal",
  proposalId: "proposal-7",
  environment: "rhc",
  walletAddress: "0x1111111111111111111111111111111111111111",
  accountIndex: 24_226,
  apiKeyIndex: 4,
  marketId: 1,
  symbol: "BTC",
  current: {
    initialMarginFraction: 5000,
    leverageDisplay: "2.00",
    marginMode: "cross",
    source: "market_default",
  },
  target: {
    initialMarginFraction: 400,
    leverageDisplay: "25.00",
    marginMode: "cross",
  },
  marketMinInitialMarginFraction: 200,
  openPosition: { size: "0.00020", side: "long" },
  observations: {
    liquidationPrice: "61234.5",
    openOrders: { count: 2 },
  },
  expiresAt: "2026-09-10T18:02:00.000Z",
} as LighterLeverageIssuedProposal;

function renderModal(
  overrides: Partial<React.ComponentProps<typeof LighterLeverageConfirmModal>> = {},
): { readonly onCancel: ReturnType<typeof vi.fn>; readonly onConfirm: ReturnType<typeof vi.fn> } {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <LighterLeverageConfirmModal
      proposal={PROPOSAL}
      environment="rhc"
      submitting={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onCancel, onConfirm };
}

it("renders main's proposal: the terms, the exposure, the account and the expiry", () => {
  renderModal();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Change BTC leverage");
  expect(dialog.textContent).toContain("2.00x to 25.00x");
  expect(dialog.textContent).toContain("cross to cross");
  expect(dialog.textContent).toContain("long 0.00020 BTC");
  expect(dialog.textContent).toContain("61234.5 USDG");
  expect(dialog.textContent).toContain("2 open orders");
  expect(dialog.textContent).toContain(
    "0x1111111111111111111111111111111111111111 - account 24226",
  );
  expect(dialog.textContent).toContain("This proposal expires");
});

it("labels the liquidation price and open orders as observations", () => {
  renderModal();
  expect(screen.getByRole("dialog").textContent).toContain(CONFIRM_OBSERVATION_NOTE);
});

it("says Not reported rather than a number Lighter did not give", () => {
  renderModal({
    proposal: {
      ...PROPOSAL,
      openPosition: null,
      observations: { liquidationPrice: null, openOrders: { count: 0 } },
    } as LighterLeverageIssuedProposal,
  });
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Not reported");
  expect(dialog.textContent).toContain("None");
});

it("keeps the consequence sentence outside the scrolling body", () => {
  renderModal();
  const strip = document.querySelector("[data-vex-dialog-consequence]");
  if (!(strip instanceof HTMLElement)) throw new Error("no consequence strip");
  expect(strip.textContent).toContain(leverageConsequenceSentence("BTC"));
  expect(strip.closest("[data-vex-dialog-body]")).toBeNull();
});

it("opens focus on Cancel, never on the action", () => {
  renderModal();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
});

it("cancels on Escape", () => {
  const { onCancel, onConfirm } = renderModal();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("ignores Escape while the change is in flight", () => {
  const { onCancel } = renderModal({ submitting: true });
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onCancel).not.toHaveBeenCalled();
});

it("disables both choices while the change is in flight and says so", () => {
  renderModal({ submitting: true });
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("Applying on Lighter…");
});

it("returns focus to the control that opened it when the card drops the proposal", () => {
  const trigger = document.createElement("button");
  trigger.textContent = "Apply new leverage to BTC";
  document.body.appendChild(trigger);
  trigger.focus();
  expect(document.activeElement).toBe(trigger);

  const { unmount } = render(
    <LighterLeverageConfirmModal
      proposal={PROPOSAL}
      environment="rhc"
      submitting={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("confirms by proposal id and nothing else", () => {
  const { onConfirm } = renderModal();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(onConfirm).toHaveBeenCalledWith("proposal-7");
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
