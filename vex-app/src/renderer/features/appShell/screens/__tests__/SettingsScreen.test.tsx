/**
 * SettingsScreen — the in-shell Settings ShellScreen (Phase 2b; the
 * reconfigure-wizard "Edit infrastructure" surface is retired).
 *
 * Pins:
 *   - `shellRoute = { kind: "settings", section: null }` mounts the screen
 *     through ShellScreens as a titled modal dialog ("Settings") showing
 *     the eight-row landing register,
 *   - status WORDS derive from envState (success / neutral / warning
 *     vocabulary — "Protected", "Both chains", "Jupiter missing", …),
 *   - clicking a row slides to that section's sub-view hosting the wizard
 *     step form in `flowMode="back-edit"`, with the "← Settings" back
 *     affordance returning to the register,
 *   - a route `section` deep-links straight into a sub-view (the welcome
 *     Portfolio "Add wallet" path),
 *   - a step form's save (`onAdvance`) returns to the register,
 *   - per-chain private-key export lives ONLY in the Wallets sub-view,
 *     gated on the chain actually existing,
 *   - Escape closes back to `{ kind: "none" }`.
 *
 * The wizard step forms are mocked through the `features/wizard` public
 * gate — their behavior belongs to the wizard suites; this suite owns the
 * register, routing, and status-word derivation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";

// Vitest 4 can expose Node's incomplete localStorage shim when the inherited
// NODE_OPTIONS contains --localstorage-file without a path. Give Zustand's
// persisted UI store the Storage contract this focused jsdom suite needs.
const localStorageState = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageState.set(key, value),
    removeItem: (key: string) => localStorageState.delete(key),
    clear: () => localStorageState.clear(),
  },
});
const { useUiStore } = await import("../../../../stores/uiStore.js");

// Sibling screens pull heavy registers; only the settings branch is under test.
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
vi.mock("../AssetsScreen.js", () => ({ AssetsScreen: () => null }));
vi.mock("../AgentScanScreen.js", () => ({ AgentScanScreen: () => null }));
vi.mock("../TokenHistoryScreen.js", () => ({ TokenHistoryScreen: () => null }));

// The wizard public gate — step-form stubs expose exactly the contract the
// screen drives: flowMode + the save-returns-to-register wire (onAdvance).
type StepStubProps = {
  readonly flowMode: string;
  readonly onAdvance: (next: string) => void;
};
function stepStub(name: string) {
  return ({ flowMode, onAdvance }: StepStubProps) => (
    <div data-vex-step-stub={name} data-vex-step-flow={flowMode}>
      <button type="button" onClick={() => onAdvance("review")}>
        Save {name} (stub)
      </button>
    </div>
  );
}
vi.mock("../../../wizard/index.js", () => ({
  KeystoreStep: stepStub("keystore"),
  WalletsStep: stepStub("wallets"),
  ApiKeysStep: stepStub("apiKeys"),
  EmbeddingStep: stepStub("embedding"),
  AgentCoreStep: stepStub("agentCore"),
  ProviderStep: stepStub("provider"),

}));

// The export modal is a high-risk surface with its own suites — a stub
// exposing the chain prop pins the wiring without the crypto flow.
const exportModalSpy = vi.hoisted(() => vi.fn());
vi.mock("../../../wallets/ExportPrivateKeyModal.js", () => ({
  ExportPrivateKeyModal: ({
    chain,
    onClose,
  }: {
    readonly chain: string;
    readonly onClose: () => void;
  }) => {
    exportModalSpy(chain);
    return (
      <div data-vex-export-modal={chain}>
        <button type="button" onClick={onClose}>
          Close export (stub)
        </button>
      </div>
    );
  },
}));

const mockUseEnvState = vi.hoisted(() => vi.fn());
const mockGetChainEndpoints = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/chain-endpoints.js", () => ({
  getChainEndpoints: mockGetChainEndpoints,
  setChainEndpoints: vi.fn(),
}));
vi.mock("../../../../lib/api/onboarding.js", () => ({
  useEnvState: mockUseEnvState,
}));
const mockUseWizardState = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/wizard.js", () => ({
  useWizardState: mockUseWizardState,
}));
const mockUseSuperboardKey = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/superboard-key.js", () => ({
  useSuperboardKey: mockUseSuperboardKey,
  useGenerateSuperboardKey: () => ({ mutate: () => undefined, isPending: false }),
}));
vi.mock("../../../../lib/api/lighter-points.js", () => ({
  useLighterPoints: () => ({
    state: { kind: "ready", result: { rows: [], walletCount: 0 } },
    refreshing: false,
    refresh: () => undefined,
  }),
}));
// The Background row has its own suite (SettingsBackdropRow.test.tsx); this
// one owns routing and the register, so its hooks stub to "shipped artwork".
vi.mock("../../../../lib/api/shell-backdrop.js", () => ({
  useShellBackdrop: () => ({ data: { ok: true, data: { backdrop: null } } }),
  currentShellBackdrop: () => null,
  usePickShellBackdrop: () => ({ mutate: () => undefined, isPending: false }),
  useClearShellBackdrop: () => ({ mutate: () => undefined, isPending: false }),
}));

const { ShellScreens } = await import("../ShellScreens.js");

const ORIGIN = { x: 12, y: 640, width: 320, height: 40 };

function envFixture(overrides?: Partial<EnvState>): EnvState {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: true,
    apiKeys: {
      jupiterConfigured: true,
      tavilyConfigured: true,
      rettiwtConfigured: false,
      relayConfigured: false,
    },
    secrets: { vaultConfigured: true, unlocked: true },
    embeddings: {
      configured: true,
      reachable: true,
      baseUrlRedacted: "http://127.0.0.1:27134",
      allFieldsConfigured: true,
      dbReachable: true,
    },
    walletStatus: { evm: "present", solana: "present" },
    walletAddresses: { evm: "0xabc", solana: "sol1" },
    provider: {
      configured: true,
      name: "openrouter",
      modelLabel: "gpt",
      endpointTag: null,
    },
    setupCompleteFlag: true,
    ...overrides,
  };
}

function setEnv(env: EnvState): void {
  mockUseEnvState.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: env },
  });
}

function openSettings(
  section: SettingsSection | null = null,
): void {
  act(() => {
    useUiStore.setState({
      shellRoute: { kind: "settings", origin: ORIGIN, section },
    });
  });
}

beforeEach(() => {
  mockGetChainEndpoints.mockReset();
  mockGetChainEndpoints.mockResolvedValue({
    ok: true,
    data: { chainId: 4663, rpcUrl: null, blockscoutBaseUrl: null },
  });
  setEnv(envFixture());
  mockUseSuperboardKey.mockReturnValue({
    isLoading: false,
    isFetching: false,
    data: { ok: true, data: { kind: "registered", shareToken: "A".repeat(43) } },
  });
  mockUseWizardState.mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      ok: true,
      data: {
        currentStepId: "review",
        completedSteps: ["keystore", "wallets", "apiKeys", "embedding", "agentCore", "provider"],
        completed: true,
      },
    },
  });
  exportModalSpy.mockClear();
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

describe("SettingsScreen", () => {
  it("mounts through ShellScreens as the Settings dialog with the eight-row register and healthy status words", async () => {
    render(<ShellScreens />);
    openSettings();

    await screen.findByRole("dialog", { name: "Settings" });
    for (const name of [
      "Vault",
      "Wallets",
      "API keys",
      "Model",
      "Memory",
      "Tuning",
      "Superboard key",
      "Lighter Points",
    ]) {
      expect(screen.getByText(name)).not.toBeNull();
    }
    // Status = colored WORDS from envState (never a dot).
    expect(screen.getByText("Protected")).not.toBeNull();
    expect(screen.getByText("Both chains")).not.toBeNull();
    expect(screen.getByText("Configured")).not.toBeNull();
    expect(screen.getByText("Linked")).not.toBeNull();
    expect(screen.getByText("OpenRouter")).not.toBeNull();
    expect(screen.getByText("Reachable")).not.toBeNull();
    expect(screen.getByText("Saved")).not.toBeNull();
    expect(screen.getByText("Open")).not.toBeNull();
    const rows = Array.from(document.querySelectorAll("[data-vex-settings-row]"));
    expect(rows.map((row) => row.getAttribute("data-vex-settings-row"))).toEqual([
      "vault", "wallets", "apiKeys", "model", "memory", "tuning", "superboardKey", "lighterPoints",
    ]);
    for (const row of rows) {
      const icon = row.querySelector("svg");
      const slot = icon?.parentElement;
      expect(slot?.className).toBe("flex h-8 w-8 shrink-0 items-center justify-center text-ink-secondary");
      expect(slot?.className).not.toMatch(/rounded|border|overflow-hidden/);
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      if (row.getAttribute("data-vex-settings-row") !== "superboardKey") {
        expect(icon?.getAttribute("width")).toBe("20");
      }
      const section = row.getAttribute("data-vex-settings-row");
      if (section === null) throw new Error("Settings row has no section identifier");
      if (!["superboardKey", "lighterPoints"].includes(section)) {
        expect(icon?.getAttribute("viewBox")).toBe("0 0 16 16");
        expect(icon?.querySelector("[stroke]")).toBeNull();
      }
    }
    expect(mockGetChainEndpoints).not.toHaveBeenCalled();
    expect(screen.getByText(/the Superboard key, and Lighter points/)).not.toBeNull();

    const superboard = screen.getByRole("button", { name: /Superboard key/ });
    const lighter = screen.getByRole("button", { name: /Lighter Points/ });
    const superboardIcon = superboard.querySelector("svg");
    const lighterIcon = lighter.querySelector("svg");
    expect(superboardIcon?.getAttribute("viewBox")).toBe("0 0 48 31");
    expect(superboardIcon?.getAttribute("width")).toBe("28");
    expect(lighterIcon?.getAttribute("viewBox")).toBe("12 12 40 40");
    expect(lighterIcon?.getAttribute("width")).toBe("20");
    expect(superboardIcon?.parentElement?.className).toBe(lighterIcon?.parentElement?.className);
    expect(lighter.querySelector("img")).toBeNull();
    expect(screen.queryByRole("switch", { name: /Lighter integration/i })).toBeNull();
  });

  it("opens chain endpoint overrides inside API keys without another register row", async () => {
    render(<ShellScreens />);
    openSettings();

    fireEvent.click(await screen.findByRole("button", { name: /API keys/ }));
    await screen.findByText("Save apiKeys (stub)");
    expect(screen.getByRole("region", { name: "Chain endpoints" })).not.toBeNull();
    expect(screen.getByLabelText("EVM RPC URL")).not.toBeNull();
    expect(screen.getByLabelText("Blockscout base URL")).not.toBeNull();
    await waitFor(() => expect(mockGetChainEndpoints).toHaveBeenCalledWith(4663));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("button", { name: /API keys/ });
    expect(document.querySelectorAll("[data-vex-settings-row]")).toHaveLength(8);
    expect(screen.queryByRole("region", { name: "Chain endpoints" })).toBeNull();
  });

  it("deep-links API keys into its chain endpoint overrides", async () => {
    render(<ShellScreens />);
    openSettings("apiKeys");
    await screen.findByText("Save apiKeys (stub)");
    expect(screen.getByRole("region", { name: "Chain endpoints" })).not.toBeNull();
    expect(document.querySelector('[data-vex-settings-section="apiKeys"]')).not.toBeNull();
    await waitFor(() => expect(mockGetChainEndpoints).toHaveBeenCalledWith(4663));
  });

  it.each([
    [{ kind: "not_ready" }, "Not ready", "text-warning"],
    [{ kind: "missing" }, "Not set", "text-warning"],
    [{ kind: "pending", shareToken: "A".repeat(43), lastError: null }, "Linking", "text-ink-secondary"],
    [{ kind: "registered", shareToken: "A".repeat(43) }, "Linked", "text-success"],
    [null, "-", "text-ink-secondary"],
  ] satisfies ReadonlyArray<readonly [SuperboardKeyStatus | null, string, string]>)(
    "keeps the Superboard status %j independent of the Lighter entry",
    async (status, word, tone) => {
      mockUseSuperboardKey.mockReturnValue({
        data: status === null ? undefined : { ok: true, data: status },
      });
      render(<ShellScreens />);
      openSettings();
      const superboard = await screen.findByRole("button", { name: /Superboard key/ });
      expect(within(superboard).getByText(word).classList.contains(tone)).toBe(true);
      const lighter = screen.getByRole("button", { name: /Lighter Points/ });
      expect(within(lighter).getByText("Open").classList.contains("text-ink-secondary")).toBe(true);
    },
  );

  it.each([
    ["superboardKey", /Superboard key/, "[data-vex-superboard-key]", "[data-vex-lighter-points]"],
    ["lighterPoints", /Lighter Points/, "[data-vex-lighter-points]", "[data-vex-superboard-key]"],
  ] satisfies ReadonlyArray<readonly [SettingsSection, RegExp, string, string]>)(
    "opens %s from its row and returns to the register",
    async (_section, name, active, inactive) => {
      const { container } = render(<ShellScreens />);
      openSettings();
      fireEvent.click(await screen.findByRole("button", { name }));
      await screen.findByRole("button", { name: "Settings" });
      await waitFor(() => expect(container.querySelector(active)).not.toBeNull());
      expect(container.querySelector(inactive)).toBeNull();
      expect(container.querySelector("[data-vex-step-stub]")).toBeNull();
      expect(container.querySelector("[data-vex-settings-export]")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      await screen.findByRole("button", { name });
      expect(container.querySelector(active)).toBeNull();
    },
  );

  it.each([
    ["superboardKey", "[data-vex-superboard-key]"],
    ["lighterPoints", "[data-vex-lighter-points]"],
  ] satisfies ReadonlyArray<readonly [SettingsSection, string]>)(
    "deep-links directly to %s",
    async (section, selector) => {
      const { container } = render(<ShellScreens />);
      openSettings(section);
      await screen.findByRole("button", { name: "Settings" });
      expect(container.querySelector(selector)).not.toBeNull();
      expect(container.querySelector("[data-vex-settings-register]")).toBeNull();
    },
  );

  it("speaks the warning vocabulary when envState is degraded", async () => {
    setEnv(
      envFixture({
        hasKeystorePassword: false,
        apiKeys: {
          jupiterConfigured: false,
          tavilyConfigured: false,
          rettiwtConfigured: false,
          relayConfigured: false,
        },
        walletStatus: { evm: "present", solana: "missing" },
        provider: {
          configured: false,
          name: null,
          modelLabel: null,
          endpointTag: null,
        },
        embeddings: {
          configured: false,
          reachable: false,
          baseUrlRedacted: null,
          allFieldsConfigured: false,
          dbReachable: null,
        },
      }),
    );
    render(<ShellScreens />);
    openSettings();

    await screen.findByRole("dialog", { name: "Settings" });
    // vault "Not set" (warning) + model "Not set" (warning) render twice.
    expect(screen.getAllByText("Not set").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("EVM only")).not.toBeNull();
    expect(screen.getByText("Jupiter missing")).not.toBeNull();
  });

  it("row click opens the section sub-view hosting the step form in back-edit mode; ← Settings returns", async () => {
    render(<ShellScreens />);
    openSettings();

    const row = await screen.findByRole("button", { name: /Vault/ });
    fireEvent.click(row);

    const stub = await screen.findByText("Save keystore (stub)");
    expect(
      stub.closest("[data-vex-step-stub]")?.getAttribute("data-vex-step-flow"),
    ).toBe("back-edit");

    // Exact-name match: the close key is "Close Settings", the back
    // affordance is plain "Settings".
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByText("Protected");
    expect(screen.queryByText("Save keystore (stub)")).toBeNull();
  });

  it("a step form's save returns to the register", async () => {
    render(<ShellScreens />);
    openSettings("tuning");

    fireEvent.click(await screen.findByText("Save agentCore (stub)"));
    await screen.findByText("Saved");
    expect(screen.queryByText("Save agentCore (stub)")).toBeNull();
  });

  it("a route section deep-links straight into the Wallets sub-view with export gated per chain", async () => {
    setEnv(envFixture({ walletStatus: { evm: "present", solana: "missing" } }));
    render(<ShellScreens />);
    openSettings("wallets");

    await screen.findByText("Save wallets (stub)");
    const evm = screen.getByRole("button", { name: "Export EVM key" }) as HTMLButtonElement;
    const solana = screen.getByRole("button", { name: "Export Solana key" }) as HTMLButtonElement;
    expect(evm.disabled).toBe(false);
    expect(solana.disabled).toBe(true);

    fireEvent.click(evm);
    expect(exportModalSpy).toHaveBeenCalledWith("evm");
    fireEvent.click(screen.getByRole("button", { name: "Close export (stub)" }));
    expect(screen.queryByText("Close export (stub)")).toBeNull();
  });

  it("keeps export OUT of every non-Wallets sub-view", async () => {
    render(<ShellScreens />);
    openSettings("vault");
    await screen.findByText("Save keystore (stub)");
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
  });

  it("Escape closes back to { kind: 'none' }", async () => {
    render(<ShellScreens />);
    openSettings();
    await screen.findByRole("dialog", { name: "Settings" });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });
});
