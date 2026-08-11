/**
 * `CardBody` - the C3 deployed-capital section of the mission contract card.
 *
 * Why this section exists: `deployedCapital` is HASH-BOUND material (contract
 * v6). Before this change the card rendered NOTHING for it, so the host was
 * asked to accept a contract covering a field the UI never showed - a blind
 * signature. These tests pin that it is visible, and pin the two rules that keep
 * it honest:
 *
 *   - The renderer NEVER converts a raw amount. `amountHuman` is derived
 *     main-side; when it is null the primary line falls back to the raw pair
 *     verbatim rather than rescaling anything (rule 90).
 *   - A null declaration renders an EXPLICIT "Not declared", never an omitted
 *     section. Absence is meaningful: it is what suppresses the measurability
 *     warnings, so the host must be able to see that nothing was declared.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MissionDraftDto } from "@shared/schemas/mission.js";

import { CardBody } from "../MissionContractCardSections.js";

const BASE_DRAFT: MissionDraftDto = {
  missionId: "mission-1",
  sessionId: "00000000-0000-4000-8000-00000000cccc",
  status: "ready",
  title: "Rebalance LP",
  goal: "Move USDC into a tighter range.",
  constraints: {},
  successCriteria: [],
  stopConditions: [],
  riskProfile: null,
  allowedChains: [],
  allowedProtocols: [],
  allowedWallets: [],
  createdAt: "2026-05-22T08:00:00.000Z",
  updatedAt: "2026-05-22T09:00:00.000Z",
  approvedAt: null,
  acceptance: null,
  deployedCapital: null,
  renewedFromMissionId: null,
};

const DECLARED = {
  amountRaw: "3044000000000000000000",
  decimals: 18,
  chainId: 4663,
  assetAddress: "0x0f9f0000000000000000000000000000000000ee",
  assetSymbol: "VEX",
  amountHuman: "3044",
};

function renderBody(
  deployedCapital: MissionDraftDto["deployedCapital"],
): HTMLElement {
  render(<CardBody draft={{ ...BASE_DRAFT, deployedCapital }} />);
  const field = document.querySelector<HTMLElement>(
    '[data-vex-field="deployed-capital"]',
  );
  expect(field).not.toBeNull();
  if (field === null) throw new Error("deployed-capital field missing");
  return field;
}

describe("CardBody deployed capital", () => {
  it("shows the human figure, symbol and chain name for a declaration", () => {
    const field = renderBody(DECLARED);
    expect(field.textContent).toContain("3044 VEX on Robinhood");
  });

  it("shows the raw amount, decimals and asset address as the detail line", () => {
    const field = renderBody(DECLARED);
    expect(field.textContent).toContain(
      "3044000000000000000000 raw @ 18 decimals",
    );
    expect(field.textContent).toContain(
      "0x0f9f0000000000000000000000000000000000ee",
    );
  });

  it("falls back to the RAW pair when main could not derive a human figure", () => {
    // The renderer must never do the base-unit shift itself; an underivable
    // amount stays raw rather than becoming a guessed decimal figure.
    const field = renderBody({ ...DECLARED, amountHuman: null });
    expect(field.textContent).toContain("3044000000000000000000 raw");
    expect(field.textContent).not.toContain("3044 VEX on");
  });

  it("labels an unknown chain id neutrally instead of blanking", () => {
    const field = renderBody({ ...DECLARED, chainId: 999_777 });
    expect(field.textContent).toContain("Chain 999777");
  });

  it("renders an explicit 'Not declared' when nothing was declared", () => {
    const field = renderBody(null);
    expect(field.textContent).toContain("Not declared");
  });

  it("drops a hostile symbol through the shared sanitizer rather than printing it", () => {
    // A token symbol is attacker-influenceable text. The sanitizer rejects
    // anything that is not a plain ASCII ticker; a rejected symbol must not
    // reach the DOM at all.
    const hostile = "V‮EX";
    const field = renderBody({ ...DECLARED, assetSymbol: hostile });
    expect(field.textContent).not.toContain(hostile);
    expect(field.textContent).toContain("3044 on Robinhood");
  });

  it("renders nothing for capital outside the section (no stray leakage)", () => {
    render(<CardBody draft={BASE_DRAFT} />);
    expect(screen.queryByText(/3044/)).toBeNull();
  });
});
