import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { SuperboardKeySection } from "../SuperboardKeySection.js";

const SHARE = "S".repeat(43);
const getSuperboardKey = vi.fn();
const generateSuperboardKey = vi.fn();
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

function readFailure(): Result<SuperboardKeyStatus> {
  return {
    ok: false,
    error: {
      code: "internal.unexpected",
      domain: "settings",
      message: "The local vault is unavailable.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: "key-read-ref",
    },
  };
}

beforeEach(() => {
  getSuperboardKey.mockReset();
  generateSuperboardKey.mockReset();
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
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SuperboardKeySection", () => {
  it("shows loading without asking a connected user to connect AgentScan", async () => {
    const { promise, resolve: resolveRead } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    getSuperboardKey.mockReturnValue(promise);
    renderSection();
    expect(screen.getByRole("status").textContent).toBe("Loading Superboard key…");
    expect(screen.queryByText(/Connect AgentScan first/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    resolveRead(ok({ kind: "registered", shareToken: SHARE }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["result", "rejection"])("shows a %s read failure and retries only the read", async (failure) => {
    if (failure === "result") getSuperboardKey.mockResolvedValueOnce(readFailure());
    else getSuperboardKey.mockRejectedValueOnce(new Error("private /vault/path"));
    const { promise, resolve: resolveRetry } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    getSuperboardKey.mockReturnValueOnce(promise);
    renderSection();
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the Superboard key.");
    expect(screen.queryByText(/Connect AgentScan first/)).toBeNull();
    expect(screen.queryByText(/private \/vault\/path/)).toBeNull();
    if (failure === "result") {
      expect(screen.getByRole("alert").textContent).toContain("The local vault is unavailable.");
      expect(screen.getByRole("alert").textContent).toContain("ref key-read-ref");
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getSuperboardKey).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toBe("Loading Superboard key…");
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    const retry = screen.queryByRole("button", { name: "Retry" });
    if (retry !== null) expect(retry).toHaveProperty("disabled", true);
    expect(generateSuperboardKey).not.toHaveBeenCalled();
    resolveRetry(ok({ kind: "registered", shareToken: SHARE }));
    const copy = await screen.findByRole("button", { name: "Copy" });
    expect(copy).toHaveProperty("disabled", false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["result", "rejection"])("shows a %s generation failure and reloads status before another write", async (failure) => {
    getSuperboardKey.mockResolvedValueOnce(ok({ kind: "missing" }));
    if (failure === "result") generateSuperboardKey.mockResolvedValueOnce(readFailure());
    else generateSuperboardKey.mockRejectedValueOnce(new Error("private /vault/path"));
    getSuperboardKey.mockResolvedValueOnce(ok({ kind: "registered", shareToken: SHARE }));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't confirm key generation.");
    expect(screen.queryByText(/private \/vault\/path/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    if (failure === "result") {
      expect(screen.getByRole("alert").textContent).toContain("The local vault is unavailable.");
      expect(screen.getByRole("alert").textContent).toContain("ref key-read-ref");
    }
    fireEvent.click(screen.getByRole("button", { name: "Reload status" }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
    expect(getSuperboardKey).toHaveBeenCalledTimes(2);
  });

  it("disables generation until its result arrives and keeps a pending key uncopyable", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    const { promise, resolve: resolveGenerate } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    generateSuperboardKey.mockReturnValue(promise);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    const generating = await screen.findByRole("button", { name: "Generating…" });
    expect(generating).toHaveProperty("disabled", true);
    fireEvent.click(generating);
    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
    resolveGenerate(ok({ kind: "pending", shareToken: SHARE, lastError: null }));
    const copy = await screen.findByRole("button", { name: "Copy" });
    expect(copy).toHaveProperty("disabled", true);
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(getSuperboardKey).toHaveBeenCalledTimes(1);
  });

  it("shows Generate when the key is missing", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    renderSection();
    expect(await screen.findByRole("button", { name: "Generate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("enables Copy when registered and never offers Regenerate", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "registered", shareToken: SHARE }));
    renderSection();
    const copy = (await screen.findByRole("button", { name: "Copy" })) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE));
  });

  it("uses the Settings section chrome", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    renderSection();
    expect(await screen.findByRole("heading", { name: "Superboard key" })).toBeTruthy();
    expect(screen.getByText("Your data stays yours")).toBeTruthy();
  });

  it("disables Copy when pending", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "pending", shareToken: SHARE, lastError: null }));
    renderSection();
    const copy = (await screen.findByRole("button", { name: "Copy" })) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
  });

  it("shows a human pending line instead of HTTP 404 not_found", async () => {
    getSuperboardKey.mockResolvedValue(
      ok({ kind: "pending", shareToken: SHARE, lastError: "HTTP 404 not_found" }),
    );
    renderSection();
    expect(
      await screen.findByText("Couldn't link this key yet. Try again later."),
    ).toBeTruthy();
    expect(screen.queryByText("HTTP 404 not_found")).toBeNull();
    expect(screen.queryByText(/not_found/i)).toBeNull();
  });

  it("hides Generate when not ready", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "not_ready" }));
    renderSection();
    expect(await screen.findByRole("heading", { name: "Superboard key" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("does not refetch getSuperboardKey after Generate succeeds", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    generateSuperboardKey.mockResolvedValue(ok({ kind: "registered", shareToken: SHARE }));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(getSuperboardKey).toHaveBeenCalledTimes(1);
    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
  });

  it("masks the secret again after Hide", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "registered", shareToken: SHARE }));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    expect(screen.getByText(SHARE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(SHARE)).toBeNull();
    expect(screen.getByText("••••••••••••••••••••••••")).toBeTruthy();
  });
});
