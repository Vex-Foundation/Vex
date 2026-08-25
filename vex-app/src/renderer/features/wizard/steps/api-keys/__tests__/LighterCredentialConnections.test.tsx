import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { LighterCredentialConnection } from "@shared/schemas/lighter-integration.js";

const PRIMARY = "0x1111111111111111111111111111111111111111";
const STRAY = "0x2222222222222222222222222222222222222222";
const mockInspect = vi.fn();
const mockForget = vi.fn();
const mockInvalidate = vi.fn();

vi.mock("../../../../../lib/api/lighter-integration.js", () => ({
  inspectStoredLighterConnections: () => mockInspect(),
  forgetStoredLighterConnection: (input: unknown) => mockForget(input),
}));

vi.mock("../../../../../lib/api/api-keys.js", () => ({
  useInvalidateEnvStateAfterApiKeysWrite: () => mockInvalidate,
}));

const { LighterCredentialConnections } = await import(
  "../LighterCredentialConnections.js"
);

const connections: readonly LighterCredentialConnection[] = [
  {
    walletAddress: PRIMARY,
    protected: true,
    scopes: [
      { environment: "core", accountIndex: 737810, apiKeyIndex: 4, managed: true },
      { environment: "rhc", accountIndex: 10231, apiKeyIndex: 4, managed: true },
    ],
  },
  {
    walletAddress: STRAY,
    protected: false,
    scopes: [
      { environment: "core", accountIndex: 736778, apiKeyIndex: 7, managed: true },
      { environment: "rhc", accountIndex: 1171, apiKeyIndex: 7, managed: true },
    ],
  },
];

beforeEach(() => {
  mockInspect.mockReset();
  mockForget.mockReset();
  mockInvalidate.mockReset();
});

afterEach(() => cleanup());

describe("LighterCredentialConnections", () => {
  it("protects the primary wallet and offers removal only for the stray connection", async () => {
    mockInspect.mockResolvedValue({ ok: true, data: { connections } });
    const view = render(<LighterCredentialConnections />);

    fireEvent.click(view.getByRole("button", { name: "Review connections" }));

    await waitFor(() => {
      expect(view.getByText(PRIMARY)).toBeTruthy();
      expect(view.getByText(STRAY)).toBeTruthy();
    });
    expect(view.getByText("Primary Vex wallet · protected")).toBeTruthy();
    expect(view.getByText("Not primary")).toBeTruthy();
    expect(view.getByText("Cannot forget")).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Forget access" })).toHaveLength(1);
  });

  it("binds confirmation to the stray wallet's exact reviewed scopes", async () => {
    mockInspect.mockResolvedValue({ ok: true, data: { connections } });
    mockForget.mockResolvedValue({
      ok: true,
      data: {
        walletAddress: STRAY,
        removedScopes: connections[1]!.scopes,
      },
    });
    const view = render(<LighterCredentialConnections />);

    fireEvent.click(view.getByRole("button", { name: "Review connections" }));
    await waitFor(() => expect(view.getByText(STRAY)).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Forget access" }));

    expect(view.getByText("Forget Lighter access?")).toBeTruthy();
    expect(view.getByText("account 736778 · key 7")).toBeTruthy();
    expect(view.getByText("account 1171 · key 7")).toBeTruthy();
    fireEvent.click(view.getByText("Forget local access"));

    await waitFor(() => {
      expect(mockForget).toHaveBeenCalledWith({
        walletAddress: STRAY,
        scopes: connections[1]!.scopes,
      });
    });
    expect(mockForget).not.toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: PRIMARY }),
    );
    await waitFor(() => {
      expect(view.getByRole("status").textContent).toContain(
        "Forgot 2 local Lighter credential scopes.",
      );
    });
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps the review surface recoverable when live verification fails", async () => {
    mockInspect.mockResolvedValue({
      ok: false,
      error: {
        message: "Vex could not verify every stored Lighter credential. Nothing was removed.",
      },
    });
    const view = render(<LighterCredentialConnections />);

    fireEvent.click(view.getByRole("button", { name: "Review connections" }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("Nothing was removed");
    });
    expect(view.getByRole("button", { name: "Review connections" })).toBeTruthy();
    expect(mockForget).not.toHaveBeenCalled();
  });
});
