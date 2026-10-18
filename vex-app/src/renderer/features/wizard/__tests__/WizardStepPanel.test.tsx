/**
 * WizardStepPanel draws one step in two hosts (docs/design/R3-MINIMAL.md
 * sections 9.6 and 10.3): the wizard (serif title, the shell's lead-in above
 * it, a footer with the privacy link and the actions inside the form) and a
 * Settings section (the section head with its status word, no icon, no
 * serif). The Settings word comes from the same derivation the Settings nav
 * reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { WizardStepPanel, settingsSectionFor, settingsStatusForStep } from "../WizardStepPanel.js";
import { WizardHostContext } from "../wizard-host.js";

afterEach(() => {
  cleanup();
});

function makeEnv(overrides: Partial<EnvState> = {}): EnvState {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: true,
    apiKeys: {
      jupiterConfigured: true,
      tavilyConfigured: false,
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
    walletStatus: { evm: "present", solana: "missing" },
    provider: {
      configured: true,
      name: "openrouter",
      modelLabel: null,
      endpointTag: null,
    },
    setupCompleteFlag: true,
    ...overrides,
  };
}

const noop = (): void => undefined;

describe("WizardStepPanel in the wizard", () => {
  it("draws the serif title, the lead, and the actions in the footer inside the form", () => {
    const { container } = render(
      <WizardStepPanel
        panelDataAttr={{ kind: "keystore", value: "form" }}
        flowMode="first-pass"
        title="Set your master password"
        description="One password seals the vault."
        formProps={{ onSubmit: noop }}
        footer={<button type="submit">Save and continue</button>}
      >
        <input aria-label="Master password" />
      </WizardStepPanel>,
    );
    const root = container.querySelector('[data-vex-wizard-keystore="form"]');
    expect(root).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Set your master password" })).toBeTruthy();
    const form = container.querySelector("form");
    const foot = container.querySelector(".vex-wzp__foot");
    expect(foot).not.toBeNull();
    expect(form?.contains(foot)).toBe(true);
    expect(form?.contains(screen.getByRole("button", { name: "Save and continue" }))).toBe(true);
    const link = within(foot as HTMLElement).getByRole("link", { name: /Your data stays yours/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // No section head and no icon badge in the wizard.
    expect(container.querySelector("[data-vex-settings-head]")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("stands the shell's lead-in above the title", () => {
    render(
      <WizardHostContext.Provider
        value={{ host: "wizard", before: <p>Step 1 of 7 · Master password</p> }}
      >
        <WizardStepPanel
          panelDataAttr={{ kind: "keystore", value: "form" }}
          flowMode="first-pass"
          title="Set your master password"
          description="Lead"
          footer={null}
        >
          <span />
        </WizardStepPanel>
      </WizardHostContext.Provider>,
    );
    const lead = screen.getByText("Step 1 of 7 · Master password");
    const title = screen.getByRole("heading", { level: 1 });
    expect(lead.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the wizard composition for Review's edit path inside the wizard host", () => {
    render(
      <WizardHostContext.Provider value={{ host: "wizard" }}>
        <WizardStepPanel
          panelDataAttr={{ kind: "wallets", value: "setup" }}
          flowMode="back-edit"
          env={makeEnv()}
          title="Manage wallets"
          description="Lead"
          footer={null}
        >
          <span />
        </WizardStepPanel>
      </WizardHostContext.Provider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Manage wallets" })).toBeTruthy();
    expect(screen.queryByText("EVM only")).toBeNull();
  });
});

describe("WizardStepPanel Back (the wizard's steps 2 to 7)", () => {
  it("draws Back at the foot's left, before the privacy link, as a key that never submits the form", () => {
    const onBack = vi.fn();
    const onSubmit = vi.fn();
    const { container } = render(
      <WizardHostContext.Provider value={{ host: "wizard", onBack }}>
        <WizardStepPanel
          panelDataAttr={{ kind: "wallets", value: "ready" }}
          flowMode="first-pass"
          title="Set up wallets"
          description="Add a wallet."
          formProps={{ onSubmit }}
          footer={<button type="submit">Continue</button>}
        >
          <input aria-label="Field" />
        </WizardStepPanel>
      </WizardHostContext.Provider>,
    );
    const foot = container.querySelector(".vex-wzp__foot");
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.getAttribute("type")).toBe("button");
    expect(back.hasAttribute("data-vex-wizard-back")).toBe(true);
    expect(foot?.firstElementChild).toBe(back);
    expect(back.nextElementSibling?.textContent).toContain("Your data stays yours");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("draws no Back without one from the host (the first step, Review's edit path)", () => {
    render(
      <WizardHostContext.Provider value={{ host: "wizard" }}>
        <WizardStepPanel
          panelDataAttr={{ kind: "keystore", value: "form" }}
          flowMode="first-pass"
          title="Set your master password"
          description="One password seals the vault."
          footer={<button type="button">Save and continue</button>}
        >
          <p>body</p>
        </WizardStepPanel>
      </WizardHostContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("draws no Back in Settings", () => {
    render(
      <WizardHostContext.Provider value={{ host: "settings", onBack: noop }}>
        <WizardStepPanel
          panelDataAttr={{ kind: "wallets", value: "ready" }}
          flowMode="back-edit"
          title="Set up wallets"
          description="Add a wallet."
          footer={<button type="button">Save changes</button>}
        >
          <p>body</p>
        </WizardStepPanel>
      </WizardHostContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

describe("WizardStepPanel in Settings (back-edit, no host)", () => {
  it("draws the section head with the status word and swatch, the actions in the form", () => {
    const { container } = render(
      <WizardStepPanel
        panelDataAttr={{ kind: "apikeys", value: "form" }}
        flowMode="back-edit"
        env={makeEnv()}
        title="Connect your API keys"
        description="Each key unlocks one tool."
        formProps={{ onSubmit: noop }}
        footer={<button type="submit">Save changes</button>}
      >
        <span />
      </WizardStepPanel>,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Connect your API keys");
    const status = container.querySelector("[data-vex-settings-head-status]");
    expect(status?.textContent).toBe("Configured");
    expect(status?.querySelector('.vex-swatch[data-s="done"]')).not.toBeNull();
    const form = container.querySelector("form");
    expect(form?.contains(screen.getByRole("button", { name: "Save changes" }))).toBe(true);
    expect(container.querySelector(".vex-wzp__title")).toBeNull();
    expect(screen.getByRole("link", { name: /Your data stays yours/ })).toBeTruthy();
  });

  it("takes the section's own name and hint where the step's title is a state sentence", () => {
    const vault = settingsSectionFor("keystore");
    render(
      <WizardStepPanel
        panelDataAttr={{ kind: "keystore", value: "skip" }}
        flowMode="back-edit"
        env={makeEnv()}
        title="Master password already configured"
        description="This install already has an encrypted local vault."
        settingsTitle={vault?.name}
        settingsDescription={vault?.hint}
        footer={null}
      >
        <span />
      </WizardStepPanel>,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("VaultProtected");
    expect(screen.getByText("The master password that encrypts everything on this machine")).toBeTruthy();
  });

  it("shows Tuning's word once the env read loads and a loading read as the hyphen, as the nav does", () => {
    const tuning = render(
      <WizardStepPanel
        panelDataAttr={{ kind: "agentcore", value: "form" }}
        flowMode="back-edit"
        env={makeEnv()}
        title="Agent core tuning"
        description="Lead"
        footer={null}
      >
        <span />
      </WizardStepPanel>,
    );
    expect(
      tuning.container.querySelector("[data-vex-settings-head-status]")?.textContent,
    ).toBe("Saved");
    tuning.unmount();
    const loading = render(
      <WizardStepPanel
        panelDataAttr={{ kind: "embedding", value: "skip" }}
        flowMode="back-edit"
        env={null}
        title="Embedding configuration is set"
        description="Lead"
        footer={null}
      >
        <span />
      </WizardStepPanel>,
    );
    expect(
      loading.container.querySelector("[data-vex-settings-head-status]")?.textContent,
    ).toBe("-");
  });
});

describe("settingsStatusForStep", () => {
  it("reads the Settings nav's words for each hosted step", () => {
    const env = makeEnv();
    expect(settingsStatusForStep("keystore", env)?.word).toBe("Protected");
    expect(settingsStatusForStep("wallets", env)?.word).toBe("EVM only");
    expect(settingsStatusForStep("apikeys", env)?.word).toBe("Configured");
    expect(settingsStatusForStep("provider", env)?.word).toBe("OpenRouter");
    expect(settingsStatusForStep("embedding", env)?.word).toBe("Reachable");
    expect(settingsStatusForStep("agentcore", env)?.word).toBe("Saved");
    expect(settingsStatusForStep("review", env)).toBeNull();
  });
});
