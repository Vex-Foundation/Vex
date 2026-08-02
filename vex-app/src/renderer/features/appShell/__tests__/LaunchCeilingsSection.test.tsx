/**
 * The host-authored launch-ceilings editor (§C6 / §C6b).
 *
 * What must hold, and why:
 *   - The renderer sends the spend ceiling as the DECIMAL ETH STRING the user
 *     typed. If this test ever sees a wei number leave the renderer, the
 *     conversion has moved to the side of the boundary that must never do it
 *     (rule 90 — a decimals slip in the UI is a thousandfold spend error).
 *   - A blank field CLEARS the ceiling (`null`), and the copy says an absent
 *     ceiling refuses rather than meaning "unlimited".
 *   - Saving invalidates acceptance, and the user is told so.
 *   - A started mission shows the ceilings but offers no editor: its run
 *     enforces the ceilings frozen in its own contract snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

const { LaunchCeilingsSection } = await import(
  "../MissionContractModal/LaunchCeilingsSection.js"
);

const SESSION = "00000000-0000-4000-8000-00000000dddd";
const MISSION = "mission-1";

const setLaunchCeilings = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setLaunchCeilings.mockResolvedValue({
    ok: true,
    data: {
      outcome: "updated",
      maxLaunchValueRaw: "50000000000000000",
      maxLaunchValueDecimals: 18,
      maxLaunchCount: 2,
      acceptanceCleared: true,
    },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { mission: { setLaunchCeilings } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

function Wrapper(client: QueryClient) {
  return function ({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function renderSection(
  constraints: Record<string, unknown> = {},
  editable = true,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <LaunchCeilingsSection
      sessionId={SESSION}
      missionId={MISSION}
      constraints={constraints}
      editable={editable}
    />,
    { wrapper: Wrapper(client) },
  );
}

function typeInto(field: string, value: string): void {
  const input = document.querySelector(`[data-vex-field="${field}"]`);
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { value } });
}

describe("LaunchCeilingsSection", () => {
  it("sends the decimal ETH string the user typed — never a wei amount", async () => {
    renderSection();
    typeInto("max-launch-value-eth", "0.05");
    typeInto("max-launch-count", "2");
    fireEvent.click(screen.getByRole("button", { name: /save ceilings/i }));

    await waitFor(() => {
      expect(setLaunchCeilings).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        maxLaunchValueEth: "0.05",
        maxLaunchCount: 2,
      });
    });
  });

  it("clears a ceiling when its field is left blank", async () => {
    renderSection();
    typeInto("max-launch-count", "1");
    fireEvent.click(screen.getByRole("button", { name: /save ceilings/i }));

    await waitFor(() => {
      expect(setLaunchCeilings).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        maxLaunchValueEth: null,
        maxLaunchCount: 1,
      });
    });
  });

  it("says an absent ceiling REFUSES rather than leaving it ambiguous", () => {
    renderSection();
    expect(
      document.querySelector('[data-vex-field="stored-max-launch-value"]')
        ?.textContent,
    ).toContain("autonomous launches refuse");
    expect(
      document.querySelector('[data-vex-field="stored-max-launch-count"]')
        ?.textContent,
    ).toContain("autonomous launches refuse");
  });

  it("shows the stored value ceiling raw, without rescaling it for display", () => {
    renderSection({
      maxLaunchValueRaw: "50000000000000000",
      maxLaunchValueDecimals: 18,
      maxLaunchCount: 3,
    });
    expect(
      document.querySelector('[data-vex-field="stored-max-launch-value"]')
        ?.textContent,
    ).toBe("50000000000000000 raw @ 18 decimals");
    expect(
      document.querySelector('[data-vex-field="stored-max-launch-count"]')
        ?.textContent,
    ).toBe("3");
  });

  it("refuses a malformed amount locally and never dispatches it", () => {
    renderSection();
    typeInto("max-launch-value-eth", "0,05 eth");
    expect(
      (screen.getByRole("button", { name: /save ceilings/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "plain decimal amount of ETH",
    );
    expect(setLaunchCeilings).not.toHaveBeenCalled();
  });

  it("tells the user acceptance was invalidated by the save", async () => {
    renderSection();
    typeInto("max-launch-count", "1");
    fireEvent.click(screen.getByRole("button", { name: /save ceilings/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "accept it again before starting",
      );
    });
  });

  it("surfaces the engine's refusal instead of silently doing nothing", async () => {
    setLaunchCeilings.mockResolvedValue({
      ok: true,
      data: { outcome: "blocked_status", status: "running" },
    });
    renderSection();
    typeInto("max-launch-count", "1");
    fireEvent.click(screen.getByRole("button", { name: /save ceilings/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("running");
    });
  });

  it("offers NO editor once the mission has started (the run is frozen)", () => {
    renderSection({ maxLaunchCount: 2 }, false);
    expect(screen.queryByRole("button", { name: /save ceilings/i })).toBeNull();
    expect(
      document.querySelector('[data-vex-field="max-launch-value-eth"]'),
    ).toBeNull();
    expect(screen.getByText(/frozen when it/i)).toBeTruthy();
  });
});
