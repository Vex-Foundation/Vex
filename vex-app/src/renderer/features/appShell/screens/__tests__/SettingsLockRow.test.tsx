/**
 * SettingsLockRow - the "Lock Vex" row under the Vault section's step form
 * (docs/design/R3-MINIMAL.md section 9.6).
 *
 * Pins:
 *   - the Vault section shows the row: the name, the help, the chord (the one
 *     constant the profile menu shows) and a quiet "Lock Vex" key,
 *   - a press calls the existing lock request exactly once, and nothing else,
 *   - while a lock is in flight the key is disabled and reads "Locking Vex...",
 *   - no other section carries it, and it follows `LOCK_BUTTON` like the menu,
 *   - the row adds no vault reset door ("Forgot the password?" stays on the
 *     unlock screen behind its acknowledgement).
 *
 * The lock request owner (`LockVexControl`, its own suite) is stubbed here to
 * a recorded request; the wizard step forms are stubbed through the
 * `features/wizard` public gate, as the Settings suite does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SectionMeta } from "../SettingsScreen/settings-sections.js";

const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock("@shared/lock-button.js", () => ({
  get LOCK_BUTTON() {
    return feature.enabled;
  },
}));

const lockState = vi.hoisted(() => ({
  pending: false,
  requestLock: vi.fn<() => void>(),
}));
vi.mock("../../LockVexControl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../LockVexControl.js")>()),
  useLockVexControl: () => lockState,
}));

vi.mock("../../../wizard/index.js", () => ({
  KeystoreStep: () => <div data-vex-step-stub="keystore" />,
  WalletsStep: () => <div data-vex-step-stub="wallets" />,
  ApiKeysStep: () => <div data-vex-step-stub="apiKeys" />,
  EmbeddingStep: () => <div data-vex-step-stub="embedding" />,
  AgentCoreStep: () => <div data-vex-step-stub="agentCore" />,
  ProviderStep: () => <div data-vex-step-stub="provider" />,
}));
vi.mock("../../../wallets/WalletRemovalSection.js", () => ({ WalletRemovalSection: () => null }));
vi.mock("../../../wallets/ExportPrivateKeyModal.js", () => ({ ExportPrivateKeyModal: () => null }));
vi.mock("../SettingsScreen/ChainEndpointsSection.js", () => ({ ChainEndpointsSection: () => null }));
vi.mock("../SettingsScreen/UserMcpSection.js", () => ({ UserMcpSection: () => null }));
vi.mock("../SettingsScreen/SuperboardKeySection.js", () => ({ SuperboardKeySection: () => null }));
vi.mock("../SettingsScreen/LighterSection.js", () => ({ LighterSection: () => null }));
vi.mock("../SettingsScreen/LocalRuntimeSection.js", () => ({ LocalRuntimeSection: () => null }));
vi.mock("../../../vexCloud/VexCloudAccountPanel.js", () => ({ VexCloudAccountPanel: () => null }));
vi.mock("../../../runtime/bootstrap/useNativeRuntimeStatus.js", () => ({
  useNativeRuntimeStatus: () => ({ status: null, retry: () => {} }),
}));

const { SETTINGS_SECTIONS } = await import("../SettingsScreen/settings-sections.js");
const { SettingsSectionView } = await import("../SettingsScreen/SettingsSectionView.js");
const { LOCK_VEX_SHORTCUT } = await import("../../LockVexControl.js");

function meta(id: SectionMeta["id"]): SectionMeta {
  const found = SETTINGS_SECTIONS.find((section) => section.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
}

function renderSection(id: SectionMeta["id"]): ReturnType<typeof render> {
  return render(
    <SettingsSectionView
      meta={meta(id)}
      env={null}
      superboard={null}
      completedSteps={[]}
      onReturn={() => undefined}
    />,
  );
}

beforeEach(() => {
  feature.enabled = true;
  lockState.pending = false;
  lockState.requestLock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SettingsLockRow", () => {
  it("shows in the Vault section, after the step form, with its help, the chord and a quiet key", () => {
    renderSection("vault");
    const row = document.querySelector("[data-vex-settings-lock]");
    if (!(row instanceof HTMLElement)) throw new Error("lock row missing");
    expect(row.previousElementSibling?.hasAttribute("data-vex-step-stub")).toBe(true);
    expect(row.className).toContain("vex-pref");
    expect(row.querySelector(".vex-pref__title")?.textContent).toBe("Lock Vex");
    expect(row.querySelector(".vex-pref__help")?.textContent).toBe(
      "Require your password to return. Also in the profile menu.",
    );
    // The chord is the profile menu's own constant.
    expect(row.querySelector(".vex-pref__chord")?.textContent).toBe(LOCK_VEX_SHORTCUT);
    const key = screen.getByRole("button", { name: "Lock Vex" });
    expect(key.getAttribute("data-vex-button")).toBe("quiet");
    expect(key.getAttribute("data-vex-button-size")).toBe("sm");
    expect((key as HTMLButtonElement).disabled).toBe(false);
  });

  it("spells the chord as the profile menu does, never a second spelling", () => {
    expect(LOCK_VEX_SHORTCUT).toMatch(/^(⇧⌘L|Ctrl\+Shift\+L)$/);
  });

  it("a press asks for the lock exactly once and does nothing else", () => {
    renderSection("vault");
    fireEvent.click(screen.getByRole("button", { name: "Lock Vex" }));
    expect(lockState.requestLock).toHaveBeenCalledTimes(1);
    expect(lockState.requestLock).toHaveBeenCalledWith();
  });

  it("is disabled and reads Locking Vex... while a lock is in flight", () => {
    lockState.pending = true;
    renderSection("vault");
    const key = screen.getByRole("button", { name: "Locking Vex..." }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Lock Vex" })).toBeNull();
    fireEvent.click(key);
    expect(lockState.requestLock).not.toHaveBeenCalled();
  });

  it("offers no vault reset door beside it", () => {
    renderSection("vault");
    expect(screen.queryByText(/Forgot the password/i)).toBeNull();
    expect(screen.queryByText(/new vault/i)).toBeNull();
  });

  it("is not in any other section", () => {
    for (const section of SETTINGS_SECTIONS) {
      if (section.id === "vault") continue;
      const view = renderSection(section.id);
      expect(
        document.querySelector("[data-vex-settings-lock]"),
        `section ${section.id}`,
      ).toBeNull();
      view.unmount();
    }
    renderSection("apiKeys");
    expect(screen.queryByRole("button", { name: "Lock Vex" })).toBeNull();
  });

  it("does not exist while LOCK_BUTTON is off, like the profile menu's row", () => {
    feature.enabled = false;
    renderSection("vault");
    expect(document.querySelector("[data-vex-settings-lock]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Lock/ })).toBeNull();
    expect(document.querySelector("[data-vex-step-stub='keystore']")).not.toBeNull();
  });
});
