/**
 * One wizard step's page (docs/design/R3-MINIMAL.md sections 9.6 and 10.3).
 * The same component draws the step in both hosts (`wizard-host.ts`):
 *
 *   wizard    what the shell stands above the title (`before`), the serif
 *             title (44, blue), the lead (15, ink 2), the step's body (column
 *             max 600), and a footer at the window's foot: the privacy link at
 *             the left, the step's actions at the right (the one primary
 *             action last).
 *   settings  the Settings section head: the step's title (or the section's
 *             own name where the title is a state sentence the body repeats)
 *             at 22 / 500 with the section's status word and swatch beside
 *             it, the lead (14); the body; the actions at the right; the
 *             privacy link under them. No icon, no serif.
 *
 * Contracts kept:
 *
 *   1. `panelDataAttr` carries the exact `data-vex-wizard-${kind}={value}`
 *      attribute the step tests select on; a discriminated union, so a typo
 *      in either part fails at compile time.
 *   2. When the step needs a `<form>`, the form wraps BOTH the body AND the
 *      actions, so the submit button stays a descendant of `<form>` (Enter
 *      submits; the testing-library form selectors hold). In the wizard the
 *      footer is inside the form and sticks to the window's foot.
 *   3. The status word in Settings comes from `settingsSectionStatus`, the
 *      one pure source the Settings nav reads, from the env read the step
 *      holds (`env`), so the head and the nav row say the same word.
 *
 * Motion is NOT applied here: the shell owns `AnimatePresence` keyed by the
 * current step; this is a plain element so transitions are not doubled.
 *
 * The stylesheet (`styles/global-css/wizard.css`) loads from `globals.css`,
 * after `settings.css`, because the forms render in both hosts.
 */

import type { FormEvent, JSX, ReactNode } from "react";

import type { EnvState } from "@shared/schemas/onboarding.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import { VEX_PRIVACY_DOC_LABEL, VEX_PRIVACY_DOC_URL } from "@shared/docs-links.js";

import { Swatch } from "../../components/ui/swatch.js";
import type { WizardFlowMode } from "../../lib/api/wizard.js";
// The Settings nav's status words and the section rows: the step head in
// Settings reads the same pure derivation, so the head and the nav row can
// never disagree.
import {
  SETTINGS_SECTIONS,
  settingsSectionStatus,
  settingsStatusSwatch,
  type SectionMeta,
  type SettingsStatus,
} from "../appShell/screens/SettingsScreen/settings-sections.js";
import { useWizardHost } from "./wizard-host.js";

export type WizardPanelDataAttr =
  | { readonly kind: "keystore"; readonly value: "form" | "skip" }
  | { readonly kind: "wallets"; readonly value: "loading" | "ready" | "setup" }
  | { readonly kind: "apikeys"; readonly value: "form" | "skip" }
  | { readonly kind: "embedding"; readonly value: "form" | "skip" }
  | { readonly kind: "agentcore"; readonly value: "form" }
  | { readonly kind: "provider"; readonly value: "form" | "skip" }
  | { readonly kind: "review"; readonly value: "loading" | "form" };

export interface WizardStepPanelFormProps {
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly noValidate?: boolean;
  /**
   * ProviderStep carries `data-vex-wizard-provider-form="openrouter"` on its
   * `<form>`; forwarded verbatim when present.
   */
  readonly providerFormAttr?: "openrouter";
}

export interface WizardStepPanelProps {
  readonly title: string;
  readonly description: ReactNode;
  readonly panelDataAttr: WizardPanelDataAttr;
  readonly footer: ReactNode;
  readonly children: ReactNode;
  readonly formProps?: WizardStepPanelFormProps;
  /**
   * The hosting flow. Without a host context (`wizard-host.ts`), `back-edit`
   * draws the Settings composition and `first-pass` the wizard's. Defaults to
   * the wizard journey.
   */
  readonly flowMode?: WizardFlowMode;
  /**
   * Settings: the env read the section's status word derives from. Omitted,
   * or null while it loads, the word is the derivation's own hyphen (the nav
   * shows the same).
   */
  readonly env?: EnvState | null;
  /**
   * Settings: the head's title and lead when the step's own title is a state
   * sentence the body repeats (the vault's "Master password already
   * configured" becomes the section's name and hint, `settingsSectionFor`).
   */
  readonly settingsTitle?: string;
  readonly settingsDescription?: ReactNode;
}

type PanelKind = WizardPanelDataAttr["kind"];

/** The panel's kind as the canonical step id. */
const PANEL_KIND_TO_STEP_ID: Readonly<Record<PanelKind, WizardStepId>> = {
  keystore: "keystore",
  wallets: "wallets",
  apikeys: "apiKeys",
  embedding: "embedding",
  agentcore: "agentCore",
  provider: "provider",
  review: "review",
};

/** The Settings section a step hosts (its name, hint and id); none for Review. */
export function settingsSectionFor(kind: PanelKind): SectionMeta | undefined {
  const stepId = PANEL_KIND_TO_STEP_ID[kind];
  return SETTINGS_SECTIONS.find((meta) => meta.stepId === stepId);
}

/** The status word of the Settings section a step hosts; null for Review. */
export function settingsStatusForStep(
  kind: PanelKind,
  env: EnvState | null,
): SettingsStatus | null {
  const section = settingsSectionFor(kind);
  if (section === undefined) return null;
  return settingsSectionStatus(section.id, env);
}

function PrivacyLink({ className }: { readonly className: string }): JSX.Element {
  return (
    <a
      href={VEX_PRIVACY_DOC_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {VEX_PRIVACY_DOC_LABEL}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export function WizardStepPanel({
  title,
  description,
  panelDataAttr,
  footer,
  children,
  formProps,
  flowMode = "first-pass",
  env,
  settingsTitle,
  settingsDescription,
}: WizardStepPanelProps): JSX.Element {
  const host = useWizardHost(flowMode);
  const dataAttrKey = `data-vex-wizard-${panelDataAttr.kind}` as const;
  // One dynamic-key spread keeps the composition identical between the seven
  // steps; the type system guarantees the (kind, value) pair is valid.
  const dataAttrs = { [dataAttrKey]: panelDataAttr.value };
  const formExtraAttrs = formProps?.providerFormAttr
    ? { "data-vex-wizard-provider-form": formProps.providerFormAttr }
    : {};

  if (host.host === "settings") {
    const status = settingsStatusForStep(panelDataAttr.kind, env ?? null);
    const actions = footer ? <div className="vex-wzs__actions">{footer}</div> : null;
    return (
      <div {...dataAttrs} className="vex-wzs">
        <header className="vex-set__head" data-vex-settings-head>
          <h2 className="vex-set__title">
            {settingsTitle ?? title}
            {status === null ? null : (
              <span className="vex-set__stw" data-vex-settings-head-status>
                <Swatch state={settingsStatusSwatch(status.tone)} size={10} />
                {status.word}
              </span>
            )}
          </h2>
          <p className="vex-set__lead">{settingsDescription ?? description}</p>
        </header>
        {formProps ? (
          <form
            onSubmit={formProps.onSubmit}
            noValidate={formProps.noValidate ?? false}
            {...formExtraAttrs}
            className="flex flex-col"
          >
            {children}
            {actions}
          </form>
        ) : (
          <>
            {children}
            {actions}
          </>
        )}
        <PrivacyLink className="vex-wzs__meta" />
      </div>
    );
  }

  const head = (
    <header className="vex-wzp__head">
      {host.before}
      <h1 className="vex-wzp__title">{title}</h1>
      <p className="vex-wzp__lead">{description}</p>
    </header>
  );
  const foot = (
    <div className="vex-wzp__foot">
      <PrivacyLink className="vex-wzp__meta" />
      <span className="vex-wzp__sp" />
      {footer ? <div className="vex-wzp__actions">{footer}</div> : null}
    </div>
  );

  if (formProps) {
    return (
      <div {...dataAttrs} className="vex-wzp">
        {head}
        <form
          onSubmit={formProps.onSubmit}
          noValidate={formProps.noValidate ?? false}
          {...formExtraAttrs}
          className="vex-wzp__form"
        >
          <div className="vex-wzp__content">{children}</div>
          {foot}
        </form>
      </div>
    );
  }

  return (
    <div {...dataAttrs} className="vex-wzp">
      {head}
      <div className="vex-wzp__content">{children}</div>
      {foot}
    </div>
  );
}
