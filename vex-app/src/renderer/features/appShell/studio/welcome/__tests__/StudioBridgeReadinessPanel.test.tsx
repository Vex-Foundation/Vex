/**
 * The bridge diagnostic: what each state SAYS, what it must never say, and
 * that it goes away.
 *
 * Two assertions carry most of the weight, and both are absence assertions:
 * a packaged failure never mentions Go (an end user cannot act on it), and a
 * ready installation renders nothing at all (a permanent green badge teaches
 * people to stop reading the region the real failure appears in).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { StudioBridgeReadiness } from "@shared/schemas/studio-bridge-readiness.js";

const readinessMock = vi.fn<() => Promise<Result<StudioBridgeReadiness>>>();

const { StudioBridgeReadinessPanel } = await import(
  "../StudioBridgeReadinessPanel.js"
);

const PIN = "go1.27.0";

function renderPanel(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <StudioBridgeReadinessPanel />
      </QueryClientProvider>
    </StrictMode>,
  );
}

function ready(data: StudioBridgeReadiness): Result<StudioBridgeReadiness> {
  return { ok: true, data };
}

beforeEach(() => {
  readinessMock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { studio: { getBridgeReadiness: readinessMock } },
  });
});

/**
 * The panel, by the attribute that names it.
 *
 * NOT `getByRole("alert")` any more: since B2.2 the live role sits on the
 * `SetupStatusCard` inside the panel (the word, the title and the sentence ARE
 * the diagnosis) rather than on the whole section, so that a screen reader is
 * not handed two nested live regions for one appearance. Querying the section
 * keeps these assertions about everything the panel renders, guidance body
 * included.
 */
function panelOrNull(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-vex-area="studio-bridge-readiness"]');
}

async function findPanel(): Promise<HTMLElement> {
  // The card announces; this waits on the same commit through it.
  await screen.findByRole("alert");
  const node = panelOrNull();
  if (node === null) throw new Error("the bridge readiness panel is not rendered");
  return node;
}

describe("a healthy installation", () => {
  it("renders nothing at all", async () => {
    readinessMock.mockResolvedValue(ready({ kind: "ready" }));
    renderPanel();
    await waitFor(() => {
      expect(readinessMock).toHaveBeenCalled();
    });
    expect(panelOrNull()).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-check" })).toBeNull();
  });

  it("renders nothing while the first read is still in flight", () => {
    readinessMock.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    // No flash of a diagnostic that will then disappear.
    expect(panelOrNull()).toBeNull();
  });
});

describe("a packaged app with a missing bridge", () => {
  beforeEach(() => {
    readinessMock.mockResolvedValue(ready({ kind: "missing_packaged" }));
  });

  it("says the installation is damaged and to reinstall Vex", async () => {
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("missing from this installation");
    expect(alert.textContent).toContain("Reinstall Vex");
  });

  it("NEVER mentions Go, a toolchain, or a build command", async () => {
    renderPanel();
    const alert = await findPanel();
    const text = alert.textContent ?? "";
    expect(text).not.toMatch(/\bGo\b/);
    expect(text).not.toMatch(/toolchain/i);
    expect(text).not.toContain("build:bridge:dev");
    expect(text).not.toContain("go.dev");
  });
});

describe("a from-source run with no built bridge", () => {
  it("says only the build is missing when the pinned Go is installed", async () => {
    readinessMock.mockResolvedValue(
      ready({
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: PIN,
        go: { kind: "present" },
      }),
    );
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("has not been built yet");
    expect(alert.textContent).toContain(
      `Go ${PIN} is installed, so all that is missing is the build`,
    );
    expect(alert.textContent).toContain("pnpm --dir vex-app run build:bridge:dev");
    // No install guidance: nothing to install.
    expect(alert.textContent).not.toContain("go.dev/dl");
  });

  it("shows both version numbers when the toolchain is the wrong patch", async () => {
    readinessMock.mockResolvedValue(
      ready({
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: PIN,
        go: { kind: "wrong_version", found: "go1.28.1" },
      }),
    );
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("reports Go go1.28.1");
    expect(alert.textContent).toContain(`pinned to Go ${PIN}`);
    expect(alert.textContent).toContain("exact, not a minimum");
  });

  it("says no go was found when there is none", async () => {
    readinessMock.mockResolvedValue(
      ready({
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: PIN,
        go: { kind: "absent" },
      }),
    );
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("no go was found on your PATH");
  });

  it("says the toolchain did not answer, without quoting it", async () => {
    readinessMock.mockResolvedValue(
      ready({
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: PIN,
        go: { kind: "unusable" },
      }),
    );
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("did not report a version");
  });
});

describe("per-operating-system guidance, chosen by what MAIN reports", () => {
  it.each<
    [StudioBridgeReadiness extends never ? never : "darwin" | "win32" | "linux" | "other", string, string | null]
  >([
    ["win32", "Windows installer", "winget"],
    ["darwin", "macOS package", "Homebrew"],
    ["linux", "Linux tarball", "distribution's Go package"],
    ["other", "Install Go", null],
  ])("%s names its own route", async (platform, pinnedPhrase, packagedPhrase) => {
    readinessMock.mockResolvedValue(
      ready({
        kind: "missing_dev",
        platform,
        requiredGoVersion: PIN,
        go: { kind: "absent" },
      }),
    );
    renderPanel();
    const alert = await findPanel();
    const text = alert.textContent ?? "";
    expect(text).toContain(pinnedPhrase);
    // The address is an ANCHOR the user can activate, never spelled into the
    // sentence: a raw URL in prose cannot be clicked, cannot be tabbed to, and
    // is read out character by character.
    expect(text).not.toContain("https://go.dev");
    const download = screen.getByRole("link", { name: /Go downloads/ });
    expect(download.getAttribute("href")).toBe("https://go.dev/dl/");
    expect(download.getAttribute("rel")).toBe("noopener noreferrer");
    if (packagedPhrase !== null) {
      expect(text).toContain(packagedPhrase);
      // The honest caveat, not an unqualified recommendation: the pin is exact
      // and a package manager tracks its own latest.
      expect(text).toContain("may not be the pinned version");
    }
  });

  it("does not consult the renderer's own platform guess", async () => {
    // The wire value wins outright. `navigator` is jsdom's here and says
    // nothing about win32; the panel must still render Windows guidance.
    readinessMock.mockResolvedValue(
      ready({
        kind: "missing_dev",
        platform: "win32",
        requiredGoVersion: PIN,
        go: { kind: "absent" },
      }),
    );
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("Windows installer");
  });
});

describe("the two remaining states", () => {
  it("names an unsupported platform without blaming the developer", async () => {
    readinessMock.mockResolvedValue(ready({ kind: "unsupported_platform" }));
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("builds no Studio bridge for this system");
    expect(alert.textContent).not.toContain("build:bridge:dev");
  });

  it("names an incomplete checkout rather than guessing a Go version", async () => {
    readinessMock.mockResolvedValue(ready({ kind: "pin_unreadable" }));
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("REQUIRED_GO_VERSION");
    expect(alert.textContent).not.toContain(PIN);
  });
});

describe("a failed check is not a missing bridge", () => {
  it("says the check did not answer and claims nothing else", async () => {
    readinessMock.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.contract_violation",
        domain: "studio",
        message: "Internal error.",
        retryable: false,
        userActionable: false,
        redacted: true,
        correlationId: "abc",
      },
    });
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("could not check");
    expect(alert.textContent).toContain("says nothing about whether the bridge is there");
    expect(alert.textContent).not.toContain("Reinstall Vex");
  });

  it("says the same when the call rejects outright", async () => {
    readinessMock.mockRejectedValue(new Error("bridge torn down"));
    renderPanel();
    const alert = await findPanel();
    expect(alert.textContent).toContain("could not check");
    // The thrown message never reaches the screen.
    expect(alert.textContent).not.toContain("torn down");
  });
});

describe("the re-check", () => {
  it("is keyboard reachable and re-asks main", async () => {
    readinessMock.mockResolvedValue(ready({ kind: "missing_packaged" }));
    renderPanel();
    const button = await screen.findByRole("button", { name: "Re-check" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.hasAttribute("disabled")).toBe(false);
    // Reachable without a pointer: a real <button> with no negative tabindex.
    expect(button.getAttribute("tabindex")).toBeNull();

    const before = readinessMock.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() => {
      expect(readinessMock.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("makes the panel disappear once the bridge is there", async () => {
    readinessMock.mockResolvedValue(
      ready({
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: PIN,
        go: { kind: "present" },
      }),
    );
    renderPanel();
    const button = await screen.findByRole("button", { name: "Re-check" });

    readinessMock.mockResolvedValue(ready({ kind: "ready" }));
    fireEvent.click(button);

    await waitFor(() => {
      expect(panelOrNull()).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Re-check" })).toBeNull();
  });
});
