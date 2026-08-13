/**
 * Wizard Step 3 — API keys (M9 + PR8 redesign — per-provider glass cards).
 *
 * Stores the optional API keys via `vex.onboarding.apiKeysSet`. Per
 * skill §14: secret inputs are uncontrolled DOM refs, plain-async
 * submit, refs cleared synchronously after firing the IPC. Per-field
 * status badges derive from envState booleans only — values never
 * round-trip.
 *
 * Optional-connections model: API keys are OPTIONAL. Jupiter is needed
 * to swap tokens on Solana, but the operator may defer it (and the rest)
 * to in-app Settings. Nothing on this step BLOCKS advancement anymore —
 * we warn and let the user continue.
 *
 * Skip-card semantics (codex turn 1 D3):
 *   - The skip-card ("API keys already configured") is only the right
 *     copy when JUPITER_API_KEY is already set; otherwise the form shows
 *     with a non-blocking warning alert and the user advances via "Skip
 *     optional" / "Save and continue".
 *   - Skip-card is ONLY shown in `first-pass` flow mode. In `back-edit`
 *     mode (user clicked Edit from Review) we always render the full
 *     form so they can change anything.
 *
 * Chrome lives in `WizardStepPanel` — `data-vex-wizard-apikeys`
 * forwarded onto the panel root via typed `panelDataAttr`.
 */

import { useCallback, useRef, useState, type JSX } from "react";
import { type WizardStepId } from "@shared/schemas/wizard.js";
import { RAIL_WARNING_CHROME } from "./step-chrome.js";
import { cn } from "../../../lib/utils.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import {
  setApiKeys,
  useInvalidateEnvStateAfterApiKeysWrite,
} from "../../../lib/api/api-keys.js";
import {
  useStepAdvance,
  type WizardFlowMode,
} from "../../../lib/api/wizard.js";
import { WIZARD_STEP_META } from "../wizard-icons.js";
import { WizardStepPanel } from "../WizardStepPanel.js";
import {
  buildPayload,
  clearAll,
  type FieldRefs,
} from "./api-keys/form-helpers.js";
import { statusFor } from "./api-keys/status-helpers.js";
import { ApiKeysSkipPanel } from "./api-keys/ApiKeysSkipPanel.js";
import { ApiKeysFormFooter } from "./api-keys/ApiKeysFormFooter.js";
import {
  JupiterCard,
  LighterReadOnlyCard,
  TavilyCard,
  RettiwtCard,
  RelayCard,
} from "./api-keys/ProviderCards.js";

export interface ApiKeysStepProps {
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onAdvance: (next: WizardStepId) => void;
  readonly flowMode: WizardFlowMode;
}

const JUPITER_MISSING_WARNING =
  "Without a Jupiter key, Solana swaps stay unavailable. Everything else still works — you can add the key later in Settings.";

export function ApiKeysStep({
  completedSteps,
  onAdvance,
  flowMode,
}: ApiKeysStepProps): JSX.Element {
  const envQuery = useEnvState();
  const stepAdvance = useStepAdvance();
  const invalidateEnvState = useInvalidateEnvStateAfterApiKeysWrite();

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submittedOnce, setSubmittedOnce] = useState(false);

  const refs: FieldRefs = {
    jupiter: useRef<HTMLInputElement | null>(null),
    tavily: useRef<HTMLInputElement | null>(null),
    rettiwt: useRef<HTMLInputElement | null>(null),
    relay: useRef<HTMLInputElement | null>(null),
    lighterCoreReadOnly: useRef<HTMLInputElement | null>(null),
    lighterRhcReadOnly: useRef<HTMLInputElement | null>(null),
  };

  const envState = envQuery.data?.ok === true ? envQuery.data.data : null;
  const apiKeysState = envState?.apiKeys ?? null;
  const jupiterConfigured = apiKeysState?.jupiterConfigured ?? false;
  const tavilyConfigured = apiKeysState?.tavilyConfigured ?? false;
  const rettiwtConfigured = apiKeysState?.rettiwtConfigured ?? false;
  const relayConfigured = apiKeysState?.relayConfigured ?? false;
  const lighterCoreReadOnlyConfigured =
    apiKeysState?.lighterCoreReadOnlyConfigured ?? false;
  const lighterRhcReadOnlyConfigured =
    apiKeysState?.lighterRhcReadOnlyConfigured ?? false;
  // Back-edit ALWAYS renders the full form. In setup mode the skip-card
  // stays available whenever Jupiter is already configured (the skip-card
  // copy assumes it).
  const canSkip =
    flowMode === "first-pass" && jupiterConfigured && !submittedOnce;

  const advanceToEmbedding = useCallback(async () => {
    const result = await stepAdvance.advance({
      flowMode,
      completedSteps,
      current: "apiKeys",
      forwardNext: "embedding",
      onAdvance,
    });
    if (!result.ok) setFormError(result.message);
  }, [stepAdvance, flowMode, completedSteps, onAdvance]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormError(null);
      const payload = buildPayload(refs);
      // Optional-connections model: API keys never block advancement. An
      // empty Save with Jupiter unconfigured still advances (the
      // missing-Jupiter warning alert is always visible) — if nothing was
      // entered, skip the IPC and just advance.
      if (Object.keys(payload).length === 0) {
        await advanceToEmbedding();
        return;
      }
      // Snapshot the payload, clear the inputs SYNCHRONOUSLY before
      // the await, then fire IPC. Matches M8 wallet-import contract.
      clearAll(refs);
      setSubmitting(true);
      try {
        const result = await setApiKeys(payload);
        if (!result.ok) {
          setFormError(result.error.message);
          return;
        }
        invalidateEnvState();
        setSubmittedOnce(true);
        await advanceToEmbedding();
      } finally {
        setSubmitting(false);
      }
    },
    [advanceToEmbedding, invalidateEnvState, refs],
  );

  const onSkipContinue = useCallback(async () => {
    // Optional-connections model: skipping never blocks — the Jupiter
    // warning is surfaced visually but the user advances.
    setFormError(null);
    await advanceToEmbedding();
  }, [advanceToEmbedding]);

  const meta = WIZARD_STEP_META.apiKeys;

  if (canSkip) {
    return (
      <ApiKeysSkipPanel
        icon={meta.icon}
        formError={formError}
        advancePending={stepAdvance.isPending}
        onContinue={() => {
          void onSkipContinue();
        }}
      />
    );
  }

  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "apikeys", value: "form" }}
      icon={meta.icon}
      flowMode={flowMode}
      title="Connect your API keys"
      description="Each key unlocks one tool, and every one of them is optional. Keys are stored on this machine and sent only to their own provider when a tool that needs them runs — never anywhere else."
      formProps={{
        onSubmit: (e) => {
          void onSubmit(e);
        },
        noValidate: true,
      }}
      footer={
        <ApiKeysFormFooter
          flowMode={flowMode}
          submitting={submitting}
          advancePending={stepAdvance.isPending}
          onSkip={() => {
            void onSkipContinue();
          }}
        />
      }
    >
      <div className="flex flex-col gap-4">
        {!jupiterConfigured ? (
          <p
            role="status"
            data-vex-apikeys-warning="jupiter-missing"
            className={cn(
              "py-0.5 text-sm text-[var(--color-warning)]",
              RAIL_WARNING_CHROME,
            )}
          >
            {JUPITER_MISSING_WARNING}
          </p>
        ) : null}
        <JupiterCard
          status={statusFor(jupiterConfigured)}
          configured={jupiterConfigured}
          inputRef={refs.jupiter}
        />

        <TavilyCard
          status={statusFor(tavilyConfigured)}
          inputRef={refs.tavily}
        />

        <RettiwtCard
          status={statusFor(rettiwtConfigured)}
          inputRef={refs.rettiwt}
        />

        <RelayCard
          status={statusFor(relayConfigured)}
          inputRef={refs.relay}
        />

        <LighterReadOnlyCard
          environment="rhc"
          status={statusFor(lighterRhcReadOnlyConfigured)}
          configured={lighterRhcReadOnlyConfigured}
          inputRef={refs.lighterRhcReadOnly}
        />

        <LighterReadOnlyCard
          environment="core"
          status={statusFor(lighterCoreReadOnlyConfigured)}
          configured={lighterCoreReadOnlyConfigured}
          inputRef={refs.lighterCoreReadOnly}
        />

        {formError ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {formError}
          </p>
        ) : null}
      </div>
    </WizardStepPanel>
  );
}
