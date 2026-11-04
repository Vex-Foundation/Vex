/**
 * STATES: THE LIGHTER DESK - the product's own desk on the stand-in bridge,
 * for side-by-side review against the owner-approved desk plates
 * (`?plate=lighter-desk`, `lighter-desk-review`, `lighter-desk-two-step` and
 * `lighter-zen`; H3-DESKTOP.md section 4.9) and for the card proof's desk
 * leg (`e2e/h3-card-proof.spec.ts`).
 *
 *   lighter-desk           BTC perp on Lighter Core, two positions, the
 *                          desk chat with one question answered, her
 *                          section open
 *   lighter-desk-review    the ticket's Review order waiting in the ticket's
 *                          place (risk medium: one press decides), her
 *                          section closed
 *   lighter-desk-two-step  Vex's deposit waiting in the desk chat (risk
 *                          high: two presses), its decision row at the
 *                          column's foot, her section closed
 *   lighter-zen            Zen, entered with the desk's own Zen key
 *
 * The reads are `fixtures/lighter-desk.ts`; the streams are delivered after
 * mount as the product receives them. The desk's market is pointed before
 * the first render (`prepare`), as a returning person's desk opens on it.
 */

import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import type { HarnessBridge } from "../bridge.js";
import { DESK_CHAT, deliverDeskStreams, lighterDeskAnswers } from "../fixtures/lighter-desk.js";
import type { HarnessState, HarnessUi } from "./types.js";

/** The desk opens on BTC perp, Lighter Core, five-minute candles. */
function pointDesk(): void {
  useLighterAnalysisStore.getState().saveDesk({ environment: "core", marketId: 1, resolution: "5m" });
}

const DESK_READY = '[data-vex-area="lighter-desk"] .lit-chart-panel';

function deskUi(vexOpen: boolean): HarnessUi {
  return {
    runtimeMode: "lighter",
    activeSessionId: DESK_CHAT.id,
    shellRoute: { kind: "none" },
    vexOpenLighter: vexOpen,
  };
}

export const lighterDesk: HarnessState = {
  id: "lighter-desk",
  title: "Lighter desk: BTC perp on Core, two positions, the desk chat in Vex's column",
  answers: () => lighterDeskAnswers("desk"),
  ui: deskUi(true),
  prepare: pointDesk,
  ready: DESK_READY,
  afterMount: deliverDeskStreams,
};

export const lighterDeskReview: HarnessState = {
  id: "lighter-desk-review",
  title: "Lighter desk: Review order waiting in the ticket's place, one press decides",
  answers: () => lighterDeskAnswers("review"),
  ui: deskUi(false),
  prepare: pointDesk,
  ready: '[data-vex-area="lighter-desk-approval"] [data-vex-area="approval-card"]',
  afterMount: deliverDeskStreams,
};

export const lighterDeskTwoStep: HarnessState = {
  id: "lighter-desk-two-step",
  title: "Lighter desk: Vex's deposit in the desk chat, two presses decide",
  answers: () => lighterDeskAnswers("two-step"),
  ui: deskUi(false),
  prepare: pointDesk,
  ready: '[data-vex-area="approvals-region"] [data-vex-area="approval-card"]',
  afterMount: deliverDeskStreams,
};

/** Zen is the desk's own key, not a stored choice: the state presses it. */
async function enterZen(bridge: HarnessBridge): Promise<void> {
  await deliverDeskStreams(bridge);
  document.querySelector<HTMLElement>('[aria-label="Enter Zen Mode"]')?.click();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export const lighterZen: HarnessState = {
  id: "lighter-zen",
  title: "Lighter Zen: the chart in the whole window",
  answers: () => lighterDeskAnswers("desk"),
  ui: deskUi(false),
  prepare: pointDesk,
  ready: '[data-vex-area="lighter-desk"][data-zen-mode]',
  afterMount: enterZen,
};
