/**
 * SettingsScreen - the in-shell Settings page (docs/design/R3-MINIMAL.md
 * section 9.6; the reconfigure-wizard "Edit infrastructure" surface is
 * retired).
 *
 * Pins:
 *   - `shellRoute = { kind: "settings", section: null }` mounts the page
 *     through ShellScreens as a titled modal dialog ("Settings") with ONE nav:
 *     four groups (App, Security and wallets, The agent, Connections), nine
 *     rows, the page landing on Preferences,
 *   - status WORDS derive from envState (success / neutral / warning
 *     vocabulary - "Protected", "Both chains", "Jupiter missing", ...), each
 *     beside a fill swatch, Preferences has none,
 *   - clicking a nav row opens that section beside the nav (the selected row
 *     says so with `aria-current`), hosting the wizard step form in
 *     `flowMode="back-edit"`; the Preferences row returns,
 *   - a route `section` deep-links straight into a section (the welcome
 *     Portfolio "Add wallet" path),
 *   - a step form's save (`onAdvance`) returns to Preferences,
 *   - Superboard key and Lighter draw their own head (name, status word, lead),
 *   - per-chain private-key export lives ONLY in the Wallets section, gated on
 *     the chain actually existing,
 *   - Vex's sidebar is hidden by default on this page (a table page),
 *   - Escape closes back to `{ kind: "none" }`.
 *
 * The wizard step forms are mocked through the `features/wizard` public
 * gate - their behavior belongs to the wizard suites; this suite owns the
 * nav, routing, and status-word derivation.
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
const { useUiStore, selectVexOpen, vexPageClass } = await import("../../../../stores/uiStore.js");

// Sibling screens pull heavy registers; only the settings branch is under test.
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
vi.mock("../AssetsScreen.js", () => ({ AssetsScreen: () => null }));
vi.mock("../AgentScanScreen.js", () => ({ AgentScanScreen: () => null }));
vi.mock("../TokenHistoryScreen.js", () => ({ TokenHistoryScreen: () => null }));

// The wizard public gate - step-form stubs expose exactly the contract the
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

vi.mock("../../../wallets/WalletRemovalSection.js", () => ({ WalletRemovalSection: () => <div>Remove a wallet</div> }));

// The export modal is a high-risk surface with its own suites - a stub
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
  useRotateSuperboardKey: () => ({ mutate: () => undefined, isPending: false }),
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
    data: {
      ok: true,
      data: {
        kind: "registered",
        shareToken: "A".repeat(43),
        rotation: { kind: "available" },
        rotatedAt: null,
      },
    },
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

/** The nav row of one section. */
function navRow(id: string): HTMLElement {
  const row = document.querySelector(`[data-vex-settings-row="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`nav row ${id} missing`);
  return row;
}

describe("SettingsScreen", () => {
  it("mounts through ShellScreens as the Settings dialog with one nav of four groups and healthy status words", async () => {
    render(<ShellScreens />);
    openSettings();

    await screen.findByRole("dialog", { name: "Settings" });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.hasAttribute("data-vex-settings-register")).toBe(true);
    expect(
      within(nav)
        .getAllByRole("group")
        .map((group) => group.firstElementChild?.textContent),
    ).toEqual(["App", "Security and wallets", "The agent", "Connections"]);
    for (const name of [
      "Preferences",
      "Vault",
      "Wallets",
      "API keys",
      "Model",
      "Memory",
      "Tuning",
      "Superboard key",
      "Lighter",
    ]) {
      expect(within(nav).getByRole("button", { name: new RegExp(name) })).not.toBeNull();
    }
    // Status = a fill and a WORD from envState (never a dot, never a hue).
    expect(within(navRow("vault")).getByText("Protected")).not.toBeNull();
    expect(within(navRow("wallets")).getByText("Both chains")).not.toBeNull();
    expect(within(navRow("apiKeys")).getByText("Configured")).not.toBeNull();
    expect(within(navRow("superboardKey")).getByText("Linked")).not.toBeNull();
    expect(within(navRow("model")).getByText("OpenRouter")).not.toBeNull();
    expect(within(navRow("memory")).getByText("Reachable")).not.toBeNull();
    expect(within(navRow("tuning")).getByText("Saved")).not.toBeNull();
    expect(within(navRow("lighterPoints")).getByText("Open")).not.toBeNull();
    const rows = Array.from(document.querySelectorAll("[data-vex-settings-row]"));
    expect(rows.map((row) => row.getAttribute("data-vex-settings-row"))).toEqual([
      "preferences",
      "vault",
      "wallets",
      "apiKeys",
      "model",
      "memory",
      "tuning",
      "superboardKey",
      "lighterPoints",
    ]);
    // No numerals: a line icon per row (decorative), and a fill swatch beside
    // every status word except Preferences, which has none.
    rows.forEach((row) => {
      expect(row.querySelector(".vex-reg__num")).toBeNull();
      expect(row.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      const swatch = row.querySelector(".vex-set__word .vex-swatch");
      if (row.getAttribute("data-vex-settings-row") === "preferences") {
        expect(swatch).toBeNull();
        return;
      }
      expect(swatch?.getAttribute("aria-hidden")).toBe("true");
      expect(swatch?.getAttribute("data-s")).toMatch(/^(done|idle|warning)$/);
    });
    // The page lands on Preferences, its row selected; no chain read runs.
    expect(navRow("preferences").getAttribute("aria-current")).toBe("page");
    expect(document.querySelector("[data-vex-settings-preferences]")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Preferences" })).not.toBeNull();
    expect(mockGetChainEndpoints).not.toHaveBeenCalled();
    // The page draws no back row and no second nav of its own.
    expect(document.querySelector("[data-vex-settings-back]")).toBeNull();
    expect(screen.queryByRole("switch", { name: /Lighter integration/i })).toBeNull();
  });

  it("opens chain endpoint overrides inside API keys without another nav row", async () => {
    render(<ShellScreens />);
    openSettings();

    fireEvent.click(await screen.findByRole("button", { name: /API keys/ }));
    await screen.findByText("Save apiKeys (stub)");
    expect(screen.getByRole("region", { name: "Chain endpoints" })).not.toBeNull();
    expect(screen.getByLabelText("EVM RPC URL")).not.toBeNull();
    expect(screen.getByLabelText("Blockscout base URL")).not.toBeNull();
    await waitFor(() => expect(mockGetChainEndpoints).toHaveBeenCalledWith(4663));
    expect(navRow("apiKeys").getAttribute("aria-current")).toBe("page");
    expect(navRow("preferences").getAttribute("aria-current")).toBeNull();

    fireEvent.click(navRow("preferences"));
    await waitFor(() =>
      expect(document.querySelector("[data-vex-settings-preferences]")).not.toBeNull(),
    );
    expect(document.querySelectorAll("[data-vex-settings-row]")).toHaveLength(9);
    expect(screen.queryByRole("region", { name: "Chain endpoints" })).toBeNull();
  });

  it("deep-links API keys into its chain endpoint overrides", async () => {
    render(<ShellScreens />);
    openSettings("apiKeys");
    await screen.findByText("Save apiKeys (stub)");
    expect(screen.getByRole("region", { name: "Chain endpoints" })).not.toBeNull();
    expect(document.querySelector('[data-vex-settings-section="apiKeys"]')).not.toBeNull();
    expect(navRow("apiKeys").getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(mockGetChainEndpoints).toHaveBeenCalledWith(4663));
  });

  it.each([
    [{ kind: "not_ready" }, "Not ready", "warning"],
    [{ kind: "missing" }, "Not set", "warning"],
    [{ kind: "pending", shareToken: "A".repeat(43), attempt: { kind: "none" } }, "Linking", "idle"],
    [
      {
        kind: "pending",
        shareToken: "A".repeat(43),
        attempt: {
          kind: "failed",
          at: "2026-09-08T12:00:00.000Z",
          failure: { kind: "transport", reason: "timeout" },
          detail: "VexError: Request timed out after 15000ms",
          correlationId: "corr-1",
          durationMs: 15012,
        },
      },
      "Not linked",
      "warning",
    ],
    [{ kind: "registered", shareToken: "A".repeat(43), rotation: { kind: "available" }, rotatedAt: null }, "Linked", "done"],
    [{ kind: "registered", shareToken: "A".repeat(43), rotation: { kind: "unavailable", reason: "server" }, rotatedAt: null }, "Linked", "done"],
    [{ kind: "registered", shareToken: "A".repeat(43), rotation: { kind: "pending", attempt: { kind: "none" } }, rotatedAt: null }, "Rotating", "idle"],
    [null, "-", "idle"],
  ] satisfies ReadonlyArray<readonly [SuperboardKeyStatus | null, string, string]>)(
    "keeps the Superboard status %j independent of the Lighter entry",
    async (status, word, tone) => {
      mockUseSuperboardKey.mockReturnValue({
        data: status === null ? undefined : { ok: true, data: status },
      });
      render(<ShellScreens />);
      openSettings();
      await screen.findByRole("dialog", { name: "Settings" });
      // Status is a fill, not a hue: the swatch beside the word carries the tone.
      expect(
        within(navRow("superboardKey")).getByText(word).querySelector(".vex-swatch")?.getAttribute("data-s"),
      ).toBe(tone);
      expect(
        within(navRow("lighterPoints")).getByText("Open").querySelector(".vex-swatch")?.getAttribute("data-s"),
      ).toBe("idle");
    },
  );

  it.each([
    ["superboardKey", "Superboard key", "Linked", "[data-vex-superboard-key]", "[data-vex-lighter-points]"],
    ["lighterPoints", "Lighter", "Open", "[data-vex-lighter-points]", "[data-vex-superboard-key]"],
  ] satisfies ReadonlyArray<readonly [SettingsSection, string, string, string, string]>)(
    "opens %s from its row under its own head and returns to Preferences",
    async (section, name, word, active, inactive) => {
      const { container } = render(<ShellScreens />);
      openSettings();
      fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
      await waitFor(() => expect(container.querySelector(active)).not.toBeNull());
      expect(container.querySelector(inactive)).toBeNull();
      expect(container.querySelector("[data-vex-step-stub]")).toBeNull();
      expect(container.querySelector("[data-vex-settings-export]")).toBeNull();
      // The section's head: the name, its status word beside a swatch, a lead.
      const head = container.querySelector("[data-vex-settings-head]");
      expect(head?.querySelector("h2")?.firstChild?.textContent).toBe(name);
      const status = head?.querySelector("[data-vex-settings-head-status]");
      expect(status?.textContent).toBe(word);
      expect(status?.querySelector(".vex-swatch")).not.toBeNull();
      expect(head?.querySelector("p")?.textContent).toBe(
        section === "superboardKey"
          ? "One code, generated once. Paste it in Superboard."
          : "Robinhood Chain points, and the trading setup the agent reads: capital share and leverage per market",
      );
      fireEvent.click(navRow("preferences"));
      await waitFor(() => expect(container.querySelector(active)).toBeNull());
      expect(container.querySelector("[data-vex-settings-preferences]")).not.toBeNull();
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
      await screen.findByRole("dialog", { name: "Settings" });
      expect(container.querySelector(selector)).not.toBeNull();
      expect(container.querySelector("[data-vex-settings-preferences]")).toBeNull();
      expect(navRow(section).getAttribute("aria-current")).toBe("page");
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

  it("a row click opens the section hosting the step form in back-edit mode; Preferences returns", async () => {
    render(<ShellScreens />);
    openSettings();

    fireEvent.click(await screen.findByRole("button", { name: /Vault/ }));

    const stub = await screen.findByText("Save keystore (stub)");
    expect(
      stub.closest("[data-vex-step-stub]")?.getAttribute("data-vex-step-flow"),
    ).toBe("back-edit");
    expect(navRow("vault").getAttribute("aria-current")).toBe("page");
    // The nav stays: the way between sections is never behind a back row.
    expect(within(navRow("vault")).getByText("Protected")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Preferences/ }));
    await waitFor(() => expect(screen.queryByText("Save keystore (stub)")).toBeNull());
    expect(document.querySelector("[data-vex-settings-preferences]")).not.toBeNull();
  });

  it("a step form's save returns to Preferences", async () => {
    render(<ShellScreens />);
    openSettings("tuning");

    fireEvent.click(await screen.findByText("Save agentCore (stub)"));
    await waitFor(() => expect(screen.queryByText("Save agentCore (stub)")).toBeNull());
    expect(document.querySelector("[data-vex-settings-preferences]")).not.toBeNull();
    expect(navRow("preferences").getAttribute("aria-current")).toBe("page");
  });

  it("a route section deep-links straight into the Wallets section with export gated per chain", async () => {
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

  it("keeps export OUT of every non-Wallets section", async () => {
    render(<ShellScreens />);
    openSettings("vault");
    await screen.findByText("Save keystore (stub)");
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
  });

  it("hides Vex's sidebar by default on the page, and the nav needs no Vex", async () => {
    render(<ShellScreens />);
    openSettings();
    await screen.findByRole("dialog", { name: "Settings" });
    const state = useUiStore.getState();
    expect(vexPageClass(state)).toBe("pages");
    // The store default for the table pages: closed, whatever chats do.
    expect(state.vexOpenPages).toBe(false);
    expect(selectVexOpen(state)).toBe(false);
  });

  it("Escape closes back to { kind: 'none' }", async () => {
    render(<ShellScreens />);
    openSettings();
    await screen.findByRole("dialog", { name: "Settings" });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });
});
