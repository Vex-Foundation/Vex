import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { SuperboardKeySection } from "../SuperboardKeySection.js";

const SHARE = "vex_share_" + "S".repeat(43);
const getSuperboardKey = vi.fn();
const generateSuperboardKey = vi.fn();
const regenerateSuperboardKey = vi.fn();
const writeText = vi.fn<(text: string) => Promise<void>>();

function renderSection(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuperboardKeySection />
    </QueryClientProvider>,
  );
}

function ok(data: SuperboardKeyStatus) {
  return { ok: true as const, data };
}

beforeEach(() => {
  getSuperboardKey.mockReset();
  generateSuperboardKey.mockReset();
  regenerateSuperboardKey.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      settings: {
        getSuperboardKey,
        generateSuperboardKey,
        regenerateSuperboardKey,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SuperboardKeySection", () => {
  it("shows Generate when the key is missing", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    renderSection();
    expect(await screen.findByRole("button", { name: "Generate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("enables Copy when registered", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "registered", shareToken: SHARE }));
    renderSection();
    const copy = (await screen.findByRole("button", { name: "Copy" })) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE));
  });

  it("disables Copy when pending", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "pending", shareToken: SHARE, lastError: null }));
    renderSection();
    const copy = (await screen.findByRole("button", { name: "Copy" })) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
  });

  it("hides Generate when not ready", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "not_ready" }));
    renderSection();
    expect(await screen.findByText("Not ready.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});
