import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import { VEX_PRIVACY_DOC_URL } from "@shared/docs-links.js";
import type {
  ShareTokenAttempt,
  SuperboardKeyStatus,
} from "@shared/schemas/superboard-key.js";
import { SuperboardKeySection } from "../SuperboardKeySection.js";

const SHARE = "S".repeat(43);
const getSuperboardKey = vi.fn();
const generateSuperboardKey = vi.fn();
const rotateSuperboardKey = vi.fn();
const writeText = vi.fn<(text: string) => Promise<void>>();

function renderSection(
  client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  }),
): { client: QueryClient } & ReturnType<typeof render> {
  const rendered = render(
    <QueryClientProvider client={client}>
      <SuperboardKeySection />
    </QueryClientProvider>,
  );
  return { client, ...rendered };
}

function ok(data: SuperboardKeyStatus) {
  return { ok: true as const, data };
}

function registered(overrides: Record<string, unknown> = {}) {
  return ok({
    kind: "registered",
    shareToken: SHARE,
    rotation: { kind: "available" },
    rotatedAt: null,
    ...overrides,
  } as SuperboardKeyStatus);
}

function failedAttempt(overrides: Record<string, unknown> = {}): ShareTokenAttempt {
  return {
    kind: "failed",
    at: new Date(Date.now() - 30_000).toISOString(),
    failure: { kind: "transport", reason: "timeout" },
    detail: "VexError: Request timed out after 15000ms",
    correlationId: "corr-1",
    durationMs: 15012,
    ...overrides,
  } as ShareTokenAttempt;
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

function rootAttributes(container: HTMLElement): {
  readonly kind: string | null;
  readonly attempt: string | null;
} {
  const root = container.querySelector("[data-vex-superboard-key]");
  if (root === null) throw new Error("Superboard key root is not rendered");
  return {
    kind: root.getAttribute("data-vex-superboard-kind"),
    attempt: root.getAttribute("data-vex-superboard-attempt"),
  };
}

function statusRow(): HTMLElement {
  const rows = screen.queryAllByRole("status");
  expect(rows).toHaveLength(1);
  return rows[0] as HTMLElement;
}

beforeEach(() => {
  getSuperboardKey.mockReset();
  generateSuperboardKey.mockReset();
  rotateSuperboardKey.mockReset();
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
        rotateSuperboardKey,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SuperboardKeySection", () => {
  it("shows loading, then the linked row once the key arrives", async () => {
    const { promise, resolve: resolveRead } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    getSuperboardKey.mockReturnValue(promise);
    const { container } = renderSection();
    expect(statusRow().textContent).toBe("Loading Superboard key…");
    expect(screen.queryByText(/Connect AgentScan first/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(rootAttributes(container)).toEqual({ kind: "loading", attempt: "none" });
    resolveRead(registered());
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(statusRow().textContent).toBe("Linked to AgentScan");
    expect(rootAttributes(container)).toEqual({ kind: "registered", attempt: "none" });
  });

  it.each(["result", "rejection"])("shows a %s read failure and retries only the read", async (failure) => {
    if (failure === "result") getSuperboardKey.mockResolvedValueOnce(readFailure());
    else getSuperboardKey.mockRejectedValueOnce(new Error("private /vault/path"));
    const { promise, resolve: resolveRetry } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    getSuperboardKey.mockReturnValueOnce(promise);
    renderSection();
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the Superboard key.");
    expect(statusRow().textContent).toBe("");
    expect(screen.queryByText(/Connect AgentScan first/)).toBeNull();
    expect(screen.queryByText(/private \/vault\/path/)).toBeNull();
    if (failure === "result") {
      expect(screen.getByRole("alert").textContent).toContain("The local vault is unavailable.");
      expect(screen.getByRole("alert").textContent).toContain("ref key-read-ref");
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getSuperboardKey).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    const retry = screen.queryByRole("button", { name: "Retry" });
    if (retry !== null) expect(retry).toHaveProperty("disabled", true);
    expect(generateSuperboardKey).not.toHaveBeenCalled();
    resolveRetry(registered());
    const copy = await screen.findByRole("button", { name: "Copy" });
    expect(copy).toHaveProperty("disabled", false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["result", "rejection"])("shows a %s generation failure and reloads status before another write", async (failure) => {
    getSuperboardKey.mockResolvedValueOnce(ok({ kind: "missing" }));
    if (failure === "result") generateSuperboardKey.mockResolvedValueOnce(readFailure());
    else generateSuperboardKey.mockRejectedValueOnce(new Error("private /vault/path"));
    getSuperboardKey.mockResolvedValueOnce(registered());
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

  it("disables generation until its result arrives and then copies the pending key", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    const { promise, resolve: resolveGenerate } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    generateSuperboardKey.mockReturnValue(promise);
    const { container } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    const generating = await screen.findByRole("button", { name: "Generating…" });
    expect(generating).toHaveProperty("disabled", true);
    expect(statusRow().textContent).toBe("Linking to AgentScan...");
    fireEvent.click(generating);
    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
    resolveGenerate(ok({ kind: "pending", shareToken: SHARE, attempt: { kind: "none" } }));
    const copy = await screen.findByRole("button", { name: "Copy" });
    expect(copy).toHaveProperty("disabled", false);
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(SHARE));
    expect(statusRow().textContent).toBe("Linking to AgentScan...");
    expect(rootAttributes(container)).toEqual({ kind: "pending", attempt: "none" });
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(getSuperboardKey).toHaveBeenCalledTimes(1);
  });

  it("shows Generate when the key is missing", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    const { container } = renderSection();
    expect(await screen.findByRole("button", { name: "Generate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(statusRow().textContent).toBe("");
    expect(rootAttributes(container)).toEqual({ kind: "missing", attempt: "none" });
  });

  it("enables Copy when registered and never offers Regenerate", async () => {
    getSuperboardKey.mockResolvedValue(registered());
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
    const privacy = screen.getByText("Your data stays yours").closest("a");
    expect(privacy).not.toBeNull();
    // The anchor and main's allowlist share one declaration; the href here is
    // the URL `docs-links.test.ts` proves the allowlist admits.
    expect(privacy?.getAttribute("href")).toBe(VEX_PRIVACY_DOC_URL);
  });

  it.each([
    {
      failure: { kind: "transport", reason: "timeout" },
      detail: "VexError: Request timed out after 15000ms",
      primary: "AgentScan didn't answer in time.",
      reassurance: "Your key is valid; only the link to AgentScan is missing.",
    },
    {
      failure: { kind: "http", status: 400, code: "validation_failed" },
      detail: "HTTP 400 validation_failed",
      primary: "AgentScan refused this key.",
      reassurance: null,
    },
    {
      failure: { kind: "conflict" },
      detail: "conflict",
      primary: "This key couldn't be linked.",
      reassurance:
        "AgentScan already holds a different key for this install. Retrying resends this same key; share the ref below when asking for help.",
    },
  ])("renders a failed link once: $primary", async ({ failure, detail, primary, reassurance }) => {
    getSuperboardKey.mockResolvedValue(
      ok({
        kind: "pending",
        shareToken: SHARE,
        attempt: failedAttempt({ failure, detail, correlationId: "corr-9" }),
      }),
    );
    const { container } = renderSection();
    expect((await screen.findByText(primary)).textContent).toBe(primary);
    expect(statusRow().textContent).toBe(primary);
    // A failed attempt is a warning, never an error: the key is still valid.
    expect(statusRow().querySelector('.vex-state-dot[data-state="warning"]')).not.toBeNull();
    expect(statusRow().querySelector('.vex-state-dot[data-state="error"]')).toBeNull();
    expect(rootAttributes(container)).toEqual({ kind: "pending", attempt: "failed" });
    const detailLine = await screen.findByText(/ref corr-9/);
    expect(detailLine.textContent).toBe(`${detail} · just now · ref corr-9`);
    expect(screen.getAllByText(primary)).toHaveLength(1);
    if (reassurance === null) {
      expect(screen.queryByText(/Your key is valid/)).toBeNull();
    } else {
      expect(screen.getByText(reassurance).textContent).toBe(reassurance);
    }
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy).toHaveProperty("disabled", false);
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(SHARE));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("resolves the sentence from the failure kind, never by parsing the detail", async () => {
    getSuperboardKey.mockResolvedValue(
      ok({
        kind: "pending",
        shareToken: SHARE,
        attempt: failedAttempt({
          failure: { kind: "transport", reason: "timeout" },
          detail: "HTTP 404 not_found",
          correlationId: "corr-7",
        }),
      }),
    );
    renderSection();
    expect(await screen.findByText("AgentScan didn't answer in time.")).toBeTruthy();
    expect(statusRow().textContent).toBe("AgentScan didn't answer in time.");
    expect(await screen.findByText("HTTP 404 not_found · just now · ref corr-7")).toBeTruthy();
  });

  it("retries a failed link through generate and replays the entrance on the new attempt", async () => {
    getSuperboardKey.mockResolvedValue(
      ok({
        kind: "pending",
        shareToken: SHARE,
        attempt: failedAttempt({ correlationId: "corr-1" }),
      }),
    );
    generateSuperboardKey.mockResolvedValue(
      ok({
        kind: "pending",
        shareToken: SHARE,
        attempt: failedAttempt({
          failure: { kind: "conflict" },
          detail: "conflict",
          correlationId: "corr-2",
        }),
      }),
    );
    renderSection();
    expect(await screen.findByText("AgentScan didn't answer in time.")).toBeTruthy();
    expect(statusRow().textContent).toBe("AgentScan didn't answer in time.");
    const firstSettle = statusRow().querySelector(".vex-animate-status-settle");
    expect(firstSettle).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("This key couldn't be linked.")).toBeTruthy();
    expect(statusRow().textContent).toBe("This key couldn't be linked.");
    const secondSettle = statusRow().querySelector(".vex-animate-status-settle");
    expect(secondSettle).not.toBeNull();
    expect(secondSettle).not.toBe(firstSettle);
    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
    expect(rotateSuperboardKey).not.toHaveBeenCalled();
  });

  it("labels Retry while its attempt is in flight", async () => {
    getSuperboardKey.mockResolvedValue(
      ok({
        kind: "pending",
        shareToken: SHARE,
        attempt: failedAttempt({ correlationId: "corr-1" }),
      }),
    );
    const { promise, resolve } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    generateSuperboardKey.mockReturnValue(promise);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const retrying = await screen.findByRole("button", { name: "Retrying..." });
    expect(retrying).toHaveProperty("disabled", true);
    resolve(ok({ kind: "pending", shareToken: SHARE, attempt: { kind: "none" } }));
    expect(await screen.findByText("Linking to AgentScan...")).toBeTruthy();
    expect(statusRow().textContent).toBe("Linking to AgentScan...");
  });

  it("replaces the failed link row with the flight while Retry runs, then brings it back", async () => {
    const flight = "Linking to AgentScan...";
    const reassurance = "Your key is valid; only the link to AgentScan is missing.";
    const failed: Result<SuperboardKeyStatus> = ok({
      kind: "pending",
      shareToken: SHARE,
      attempt: failedAttempt({ correlationId: "corr-1" }),
    });
    getSuperboardKey.mockResolvedValue(failed);
    const { promise, resolve } = Promise.withResolvers<Result<SuperboardKeyStatus>>();
    generateSuperboardKey.mockReturnValue(promise);
    renderSection();
    expect(await screen.findByText("AgentScan didn't answer in time.")).toBeTruthy();
    expect(screen.getByText(reassurance)).toBeTruthy();
    expect(screen.getByText(/ref corr-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retrying = await screen.findByRole("button", { name: "Retrying..." });
    expect(retrying).toHaveProperty("disabled", true);
    expect(statusRow().textContent).toBe(flight);
    expect(statusRow().querySelector('.vex-state-matrix[data-state="ongoing"]')).not.toBeNull();
    expect(screen.queryByText("AgentScan didn't answer in time.")).toBeNull();
    expect(screen.queryByText(reassurance)).toBeNull();
    expect(screen.queryByText(/ref corr-1/)).toBeNull();
    resolve(failed);
    expect(await screen.findByText("AgentScan didn't answer in time.")).toBeTruthy();
    expect(statusRow().textContent).toBe("AgentScan didn't answer in time.");
    expect(screen.getByText(reassurance)).toBeTruthy();
    expect(screen.getByText(/ref corr-1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty("disabled", false);
    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
    expect(rotateSuperboardKey).not.toHaveBeenCalled();
  });

  it("hides Generate when not ready and keeps the row empty", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "not_ready" }));
    const { container } = renderSection();
    expect(await screen.findByRole("heading", { name: "Superboard key" })).toBeTruthy();
    const line = await screen.findByText(
      "Connect AgentScan first. The Superboard key is minted against that identity.",
    );
    expect(line.querySelector('.vex-state-dot[data-state="warning"]')).not.toBeNull();
    expect(statusRow().textContent).toBe("");
    expect(rootAttributes(container)).toEqual({ kind: "not_ready", attempt: "none" });
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("does not refetch getSuperboardKey after Generate succeeds", async () => {
    getSuperboardKey.mockResolvedValue(ok({ kind: "missing" }));
    generateSuperboardKey.mockResolvedValue(registered());
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(getSuperboardKey).toHaveBeenCalledTimes(1);
    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
  });

  it("masks the secret again after Hide", async () => {
    getSuperboardKey.mockResolvedValue(registered());
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    expect(screen.getByText(SHARE)).toBeTruthy();
    expect(screen.getByText(SHARE).className).toContain("vex-superboard-key-swap");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(SHARE)).toBeNull();
    expect(screen.getByText("••••••••••••••••••••••••")).toBeTruthy();
  });

  it("never offers key rotation, even when AgentScan advertises it", async () => {
    // Superboard stores the pasted code and cannot edit it, so a rotated key
    // would silently stop syncing there. The trigger is not offered at all;
    // the IPC channel survives but nothing in this section reaches it.
    getSuperboardKey.mockResolvedValue(registered({ rotation: { kind: "available" } }));
    const { container } = renderSection();
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate new key" })).toBeNull();
    expect(screen.queryByText(/key rotation/i)).toBeNull();
    expect(statusRow().textContent).toBe("Linked to AgentScan");
    expect(rootAttributes(container)).toEqual({ kind: "registered", attempt: "none" });
    expect(rotateSuperboardKey).not.toHaveBeenCalled();
  });

  it("keeps the linked row settled for an install that rotated before the trigger went away", async () => {
    getSuperboardKey.mockResolvedValue(
      registered({ rotation: { kind: "available" }, rotatedAt: new Date().toISOString() }),
    );
    renderSection();
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(statusRow().textContent).toBe("Linked to AgentScan");
  });

});
