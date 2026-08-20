/**
 * Open page section for each wizard step — AMENDMENT A3 (boxless
 * composition): the screen-level card is retired. Content sits DIRECTLY
 * on the hosting surface (cobalt plate in the wizard, ShellScreen glass
 * in Settings): quiet hairline icon badge + serif sentence-case title +
 * one human description, then the step content in flow, then actions
 * right-aligned in flow, then a quiet trailing meta line. Separation is
 * spacing and at most a hairline divider — no borders-as-boxes, no
 * grain overlay, no inner scroll well (the page scrolls).
 *
 * Three important contracts:
 *
 *   1. `panelDataAttr` carries the exact `data-vex-wizard-${kind}={value}`
 *      attribute that the step's tests rely on (grep
 *      `vex-app/src/renderer/features/wizard/steps/**\/__tests__/`).
 *      It is a discriminated union so a typo in either the key or
 *      the value fails at compile time (codex round 2 BLOCKED #1).
 *
 *   2. When the step needs a `<form>` (KeystoreStep, ApiKeysStep,
 *      EmbeddingStep, AgentCoreStep, ProviderStep), the form wraps
 *      BOTH the body AND the actions row so the submit button stays a
 *      descendant of `<form>` — preserves Enter-submit and the
 *      existing testing-library form selectors (codex round 1 BLOCKED #2).
 *
 *   3. The trailing meta ("Step X / 7 · Your data stays yours →") is
 *      derived from `panelDataAttr.kind` via a typed `PANEL_KIND_TO_STEP_ID`
 *      map; the step counter renders only in the first-pass wizard flow
 *      (`flowMode`), never when the same form hosts in Settings/back-edit.
 *
 * Motion is NOT applied here — the outer `WizardShell` owns
 * `AnimatePresence` keyed by the current step id; this section is a
 * plain `<div>` so transitions are not double-wrapped.
 */

import type { ComponentType, FormEvent, JSX, ReactNode } from "react";

import {
  IconArrowUpRight,
  type GlyphProps,
} from "../../components/icons/index.js";
import {
  WIZARD_STEP_IDS,
  type WizardStepId,
} from "@shared/schemas/wizard.js";

import type { WizardFlowMode } from "../../lib/api/wizard.js";
import { cn } from "../../lib/utils.js";

type IconDescriptor = ComponentType<GlyphProps>;

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
   * Some steps (currently only ProviderStep) carry an additional
   * `data-vex-wizard-provider-form="openrouter"` attribute on their
   * `<form>`. Forwarded verbatim onto the form element when present.
   */
  readonly providerFormAttr?: "openrouter";
}

export interface WizardStepPanelProps {
  readonly icon: IconDescriptor;
  readonly title: string;
  readonly description: ReactNode;
  readonly panelDataAttr: WizardPanelDataAttr;
  readonly footer: ReactNode;
  readonly children: ReactNode;
  readonly formProps?: WizardStepPanelFormProps;
  /**
   * The hosting flow. In `"back-edit"` the trailing meta omits the
   * "Step X / 7" counter — the same form components host inside the
   * in-shell Settings screen (and Review back-edit), where a wizard
   * step counter is meaningless. Defaults to the wizard journey.
   */
  readonly flowMode?: WizardFlowMode;
}

type PanelKind = WizardPanelDataAttr["kind"];

/**
 * Typed map from `WizardPanelDataAttr.kind` (lowercase / kebab-ish
 * naming used in the test attrs) to the canonical `WizardStepId`
 * (camelCase, from `WIZARD_STEP_IDS`). Keeping both forms in one
 * place avoids ad-hoc string mangling at the call site.
 */
const PANEL_KIND_TO_STEP_ID: Readonly<Record<PanelKind, WizardStepId>> = {
  keystore: "keystore",
  wallets: "wallets",
  apikeys: "apiKeys",
  embedding: "embedding",
  agentcore: "agentCore",
  provider: "provider",
  review: "review",
};

const TOTAL_WIZARD_STEPS = WIZARD_STEP_IDS.length;

function stepIndexFor(kind: PanelKind): number {
  return WIZARD_STEP_IDS.indexOf(PANEL_KIND_TO_STEP_ID[kind]);
}

/* Quiet hairline icon circle — a glyph badge, not an accent tile. The
 * serif title is the section's one statement; everything else stays
 * quiet. */
const ICON_CIRCLE_CHROME = cn(
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
  "border border-[var(--color-border)] text-ink-primary",
);

const META_CHROME = cn(
  "flex items-center gap-3 vex-micro text-ink-tertiary",
);

function TrailingMeta({
  kind,
  showStepCount,
}: {
  kind: PanelKind;
  showStepCount: boolean;
}): JSX.Element {
  const stepIndex = stepIndexFor(kind);
  return (
    <div className={META_CHROME}>
      {showStepCount ? (
        <>
          <span>
            Step {stepIndex + 1} / {TOTAL_WIZARD_STEPS}
          </span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <a
        href="https://docs.vex.ai/security/local-vault"
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex items-center gap-1 text-ink-secondary transition-colors",
          "hover:text-ink-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        )}
      >
        Your data stays yours
        <IconArrowUpRight size={10} />
      </a>
    </div>
  );
}

export function WizardStepPanel({
  icon: Icon,
  title,
  description,
  panelDataAttr,
  footer,
  children,
  formProps,
  flowMode = "first-pass",
}: WizardStepPanelProps): JSX.Element {
  const dataAttrKey = `data-vex-wizard-${panelDataAttr.kind}` as const;
  // Mapping the discriminated union to a single dynamic-key spread keeps
  // the rest of the component identical between the seven steps; the
  // type system guarantees the (kind, value) pair is valid.
  const dataAttrs = { [dataAttrKey]: panelDataAttr.value };

  // `vex-step-header` / `vex-step-lede` are STYLE HOOKS, not styles: they
  // carry declarations only inside the `[data-vex-gate]` scope
  // (global-css/chronos-gate.css), where the header becomes a centered stack
  // and the lede goes up to 18px. In Settings — which renders this same
  // component — they match nothing, so the left-aligned composition below
  // is what ships there. Keep the Tailwind classes as the Settings truth.
  const headerNode = (
    <header className="vex-step-header flex items-start gap-4">
      <span aria-hidden className={ICON_CIRCLE_CHROME}>
        <Icon size={20} />
      </span>
      <div className="flex flex-col gap-1.5 pt-0.5">
        <h1 className="font-serif text-2xl font-normal leading-tight text-ink-primary">
          {title}
        </h1>
        <p className="vex-step-lede text-sm leading-relaxed text-ink-secondary">
          {description}
        </p>
      </div>
    </header>
  );

  // Same hook contract as the header: right-aligned in Settings, centered in
  // the pre-shell so the step's actions sit under the centered header on the
  // same axis as every SetupFrame screen's CTA.
  const actionsNode = footer ? (
    <div className="vex-step-actions mt-8 flex items-center justify-end gap-3">
      {footer}
    </div>
  ) : null;

  const metaNode = (
    <div className="mt-6 border-t border-[var(--color-border)] pt-4">
      <TrailingMeta
        kind={panelDataAttr.kind}
        showStepCount={flowMode !== "back-edit"}
      />
    </div>
  );

  if (formProps) {
    const { onSubmit, noValidate, providerFormAttr } = formProps;
    const formExtraAttrs = providerFormAttr
      ? { "data-vex-wizard-provider-form": providerFormAttr }
      : {};
    return (
      <div {...dataAttrs} className="flex w-full flex-col">
        {headerNode}
        <form
          onSubmit={onSubmit}
          noValidate={noValidate ?? false}
          {...formExtraAttrs}
          className="mt-7 flex flex-col"
        >
          {children}
          {actionsNode}
        </form>
        {metaNode}
      </div>
    );
  }

  return (
    <div {...dataAttrs} className="flex w-full flex-col">
      {headerNode}
      <div className="mt-7 flex flex-col">{children}</div>
      {actionsNode}
      {metaNode}
    </div>
  );
}
