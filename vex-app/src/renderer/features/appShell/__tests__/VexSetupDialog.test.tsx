/**
 * Renderer-side tests for the VexSetupDialog ("Personalize Vex") form.
 *
 * Mocks `window.vex.settings.getUserProfile` / `setUserProfile` (per
 * vex-testing-quality-gates §3 — never mock ipcRenderer in renderer tests).
 * The component reads/writes through `useUserProfile` / `useSetUserProfile`
 * (TanStack Query), so every render needs a `QueryClientProvider`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { UserProfile } from "@shared/schemas/user-profile.js";

const getUserProfileMock = vi.fn<() => Promise<Result<UserProfile>>>();
const setUserProfileMock = vi.fn<(profile: UserProfile) => Promise<Result<UserProfile>>>();

beforeEach(() => {
  getUserProfileMock.mockReset();
  setUserProfileMock.mockReset();
  getUserProfileMock.mockResolvedValue({
    ok: true,
    data: { displayName: null, instructionsMd: null, workDescription: null },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      settings: {
        getUserProfile: getUserProfileMock,
        setUserProfile: setUserProfileMock,
      },
    },
  });
});

const { VexSetupDialog } = await import("../VexSetupDialog.js");

function renderOpen(): { onOpenChange: ReturnType<typeof vi.fn> } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <VexSetupDialog open={true} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe("VexSetupDialog", () => {
  it("renders the labeled fields, including the Tone / Traits / Risk appetite rows", async () => {
    renderOpen();
    await waitFor(() => expect(getUserProfileMock).toHaveBeenCalled());

    expect(screen.getByText("What should Vex call you?")).not.toBeNull();
    expect(screen.getByText("What best describes your work?")).not.toBeNull();
    expect(screen.getByText("Tone")).not.toBeNull();
    expect(screen.getByText("Traits")).not.toBeNull();
    expect(screen.getByText("Risk appetite")).not.toBeNull();
    expect(screen.getByText("Instructions for Vex")).not.toBeNull();
  });

  it("saves trimmed fields, converting an empty field to null", async () => {
    setUserProfileMock.mockResolvedValueOnce({
      ok: true,
      data: { displayName: "Kuba", instructionsMd: "Be concise.", workDescription: null },
    });
    const { onOpenChange } = renderOpen();
    await waitFor(() => expect(getUserProfileMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/What should Vex call you\?/i), {
      target: { value: "  Kuba  " },
    });
    fireEvent.change(screen.getByLabelText(/Instructions for Vex/i), {
      target: { value: "  Be concise.  " },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(setUserProfileMock).toHaveBeenCalledTimes(1));
    expect(setUserProfileMock).toHaveBeenCalledWith({
      displayName: "Kuba",
      instructionsMd: "Be concise.",
      workDescription: null,
      stylePreset: null,
      characteristics: [],
      riskAppetite: null,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("includes the selected tone / traits / risk appetite in the save payload", async () => {
    setUserProfileMock.mockResolvedValueOnce({
      ok: true,
      data: {
        displayName: null,
        instructionsMd: null,
        workDescription: null,
        stylePreset: "friendly",
        characteristics: ["warm", "emoji"],
        riskAppetite: "aggressive",
      },
    });
    renderOpen();
    await waitFor(() => expect(getUserProfileMock).toHaveBeenCalled());

    const friendly = screen.getByRole("button", { name: "Friendly" });
    fireEvent.click(friendly);
    expect(friendly.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Warm" }));
    fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
    fireEvent.click(screen.getByRole("button", { name: "Aggressive" }));

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(setUserProfileMock).toHaveBeenCalledTimes(1));
    expect(setUserProfileMock).toHaveBeenCalledWith({
      displayName: null,
      instructionsMd: null,
      workDescription: null,
      stylePreset: "friendly",
      characteristics: ["warm", "emoji"],
      riskAppetite: "aggressive",
    });
  });

  it("prefills the advisory trio from the saved profile and lets tone/trait chips toggle off", async () => {
    getUserProfileMock.mockResolvedValue({
      ok: true,
      data: {
        displayName: "Kuba",
        instructionsMd: null,
        workDescription: null,
        stylePreset: "concise",
        characteristics: ["headers_lists"],
        riskAppetite: "balanced",
      },
    });
    setUserProfileMock.mockResolvedValueOnce({
      ok: true,
      data: { displayName: "Kuba", instructionsMd: null, workDescription: null },
    });
    renderOpen();

    const concise = await screen.findByRole("button", { name: "Concise" });
    await waitFor(() => expect(concise.getAttribute("aria-pressed")).toBe("true"));
    const headersLists = screen.getByRole("button", { name: "Headers & lists" });
    expect(headersLists.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Balanced" }).getAttribute("aria-pressed"),
    ).toBe("true");

    // Clicking a selected tone/trait chip clears it back to unset.
    fireEvent.click(concise);
    fireEvent.click(headersLists);

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() => expect(setUserProfileMock).toHaveBeenCalledTimes(1));
    expect(setUserProfileMock).toHaveBeenCalledWith({
      displayName: "Kuba",
      instructionsMd: null,
      workDescription: null,
      stylePreset: null,
      characteristics: [],
      riskAppetite: "balanced",
    });
  });

  it("shows a generic error line when the save fails", async () => {
    setUserProfileMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "settings",
        message: "Could not persist user profile.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });
    const { onOpenChange } = renderOpen();
    await waitFor(() => expect(getUserProfileMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/What should Vex call you\?/i), {
      target: { value: "Kuba" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Could not save. Try again."),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
