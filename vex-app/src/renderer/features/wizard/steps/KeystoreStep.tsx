/**
 * Wizard Step 1 — Master password (M7; PR6 redesign — onboarding glass).
 *
 * Creates or unlocks the encrypted local secret vault via
 * `vex.onboarding.keystoreSet`. The form is uncontrolled (React Hook Form
 * `register` ref forwarding) and the inputs are cleared via
 * `form.reset()` after the IPC call succeeds — the password value
 * never lives in long-running React state and never enters Zustand
 * or persistent storage on the renderer side.
 *
 * Skip-badge: when `envState.hasKeystorePassword === true` the form
 * is hidden and a "Already configured ✓" panel with a Continue button
 * is shown instead. After a successful keystoreSet we ALSO flip a
 * local `passwordPersisted` flag so the badge appears immediately —
 * the env-state query invalidation is async and may not have refreshed
 * by the time `setWizardState` returns. Without the flag a write that
 * succeeds for the password but fails for the wizard-state advance
 * leaves the user staring at an empty form (codex turn 6 YELLOW #3).
 *
 * UX copy refers to the credential as "master password", not
 * "keystore". Concrete file paths are intentionally not surfaced in the UI.
 *
 * Chrome lives in `WizardStepPanel` — `data-vex-wizard-keystore="form"`
 * and `data-vex-wizard-keystore="skip"` are forwarded onto the panel
 * root via the typed `panelDataAttr` prop so the existing test
 * selectors keep working (codex round 2 BLOCKED #1).
 */

import { useCallback, useRef, useState, type JSX } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  keystorePasswordSchema,
  PASSWORD_CREATE_MIN,
  type KeystorePasswordInput,
  type WizardStepId,
} from "@shared/schemas/wizard.js";
import { Button } from "../../../components/ui/button.js";
import { Label } from "../../../components/ui/label.js";
import { PasswordField } from "../../../components/common/PasswordField.js";
import { StrengthMeter } from "../../../components/common/StrengthMeter.js";
import { useMasterPasswordStrength } from "./keystore/useMasterPasswordStrength.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import {
  useKeystoreSet,
  useStepAdvance,
  type WizardFlowMode,
} from "../../../lib/api/wizard.js";
import { WIZARD_STEP_META } from "../wizard-icons.js";
import { WizardStepPanel } from "../WizardStepPanel.js";

export interface KeystoreStepProps {
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onAdvance: (next: WizardStepId) => void;
  readonly flowMode: WizardFlowMode;
}

const PASSWORD_INPUT_ID = "vex-keystore-password";
const CONFIRM_INPUT_ID = "vex-keystore-confirm";
const PASSWORD_METER_ID = "vex-keystore-password-meter";
const PASSWORD_ERROR_ID = "vex-keystore-password-error";
const CONFIRM_ERROR_ID = "vex-keystore-confirm-error";

function joinIds(
  ...ids: ReadonlyArray<string | false | null | undefined>
): string | undefined {
  const filtered = ids.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return filtered.length > 0 ? filtered.join(" ") : undefined;
}

export function KeystoreStep({
  completedSteps,
  onAdvance,
  flowMode,
}: KeystoreStepProps): JSX.Element {
  const envQuery = useEnvState();
  const keystoreSet = useKeystoreSet();
  const stepAdvance = useStepAdvance();

  const [advanceError, setAdvanceError] = useState<string | null>(null);
  // Locally remember that we just persisted the password — so the skip
  // badge renders even before envState query refetches (codex turn 6
  // YELLOW #3). False until the IPC succeeds; never reset (the badge
  // is the right surface from this point on in the same session).
  const [passwordPersisted, setPasswordPersisted] = useState(false);

  const form = useForm<KeystorePasswordInput>({
    resolver: zodResolver(keystorePasswordSchema),
    defaultValues: { password: "", confirm: "" },
    mode: "onChange",
  });

  // RHF returns a `ref` callback inside register(); we ALSO take our
  // own ref so the post-submit clear in handleSubmit guarantees the
  // DOM input is wiped even if RHF state is somehow out-of-sync
  // (defense-in-depth — the value never lingers in the DOM).
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const confirmInputRef = useRef<HTMLInputElement | null>(null);
  const passwordReg = form.register("password");
  const confirmReg = form.register("confirm");

  const passwordValue = form.watch("password");
  const strength = useMasterPasswordStrength(passwordValue);
  const meetsCreateFloor = passwordValue.length >= PASSWORD_CREATE_MIN;
  const meetsStrengthGate = meetsCreateFloor && strength.meetsMinimumScore;
  const envHasPassword =
    envQuery.data?.ok === true && envQuery.data.data.hasKeystorePassword;
  const hasExisting = passwordPersisted || envHasPassword;
  const envLoading = envQuery.isLoading;

  const advanceToWallets = useCallback(async (): Promise<void> => {
    setAdvanceError(null);
    const result = await stepAdvance.advance({
      flowMode,
      completedSteps,
      current: "keystore",
      forwardNext: "wallets",
      onAdvance,
    });
    if (!result.ok) setAdvanceError(result.message);
  }, [stepAdvance, flowMode, completedSteps, onAdvance]);

  const onSubmit = form.handleSubmit(async (values) => {
    setAdvanceError(null);
    const ksResult = await keystoreSet.mutateAsync({
      password: values.password,
    });
    if (!ksResult.ok) {
      form.setError("password", {
        type: "server",
        message: ksResult.error.message,
      });
      return;
    }
    // Mark the password as persisted FIRST so any state transition
    // (advanceToWallets failing + user staying on the screen) renders
    // the skip badge instead of the empty form.
    setPasswordPersisted(true);
    // Clear DOM inputs first, then RHF state — order matters because
    // form.reset() will repopulate the input.value if anything is
    // sitting in defaultValues.
    if (passwordInputRef.current) passwordInputRef.current.value = "";
    if (confirmInputRef.current) confirmInputRef.current.value = "";
    form.reset({ password: "", confirm: "" });
    await advanceToWallets();
  });

  const meta = WIZARD_STEP_META.keystore;

  if (hasExisting && !envLoading) {
    return (
      <WizardStepPanel
        panelDataAttr={{ kind: "keystore", value: "skip" }}
        icon={meta.icon}
        flowMode={flowMode}
        title="Master password already configured"
        description="This install already has an encrypted local vault, sealed with your master password. There is nothing to redo here."
        footer={
          <Button
            onClick={() => {
              void advanceToWallets();
            }}
            disabled={stepAdvance.isPending}
          >
            {stepAdvance.isPending
              ? "Continuing…"
              : flowMode === "back-edit"
                ? "Done"
                : "Continue"}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-secondary">
            The master password can&apos;t be rotated from this screen.
            Wallet keystores keep their current encryption - they are not
            re-encrypted automatically if the password ever changes.
          </p>
          {advanceError ? (
            <p className="text-sm text-danger" role="alert">
              {advanceError}
            </p>
          ) : null}
        </div>
      </WizardStepPanel>
    );
  }

  const passwordError = form.formState.errors.password?.message;
  const confirmError = form.formState.errors.confirm?.message;
  const submitting = keystoreSet.isPending || stepAdvance.isPending;

  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "keystore", value: "form" }}
      icon={meta.icon}
      flowMode={flowMode}
      title="Set your master password"
      description="One password seals the encrypted vault on this machine - wallet keys, API keys, and the provider key you add later all live behind it. It never leaves this computer, and it can't be recovered if lost, so keep it somewhere safe."
      formProps={{
        onSubmit: (e) => {
          void onSubmit(e);
        },
        noValidate: true,
      }}
      footer={
        <Button type="submit" disabled={submitting || !meetsStrengthGate}>
          {submitting
            ? "Saving…"
            : flowMode === "back-edit"
              ? "Save changes"
              : "Save and continue"}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor={PASSWORD_INPUT_ID}>Master password</Label>
          <PasswordField
            id={PASSWORD_INPUT_ID}
            autoFocus
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={joinIds(
              PASSWORD_METER_ID,
              passwordError ? PASSWORD_ERROR_ID : undefined,
            )}
            {...passwordReg}
            ref={(el) => {
              passwordReg.ref(el);
              passwordInputRef.current = el;
            }}
          />
          <StrengthMeter
            id={PASSWORD_METER_ID}
            length={passwordValue.length}
            ready={strength.ready}
            score={strength.score}
            label={strength.label}
            blocked={!meetsStrengthGate}
            warning={strength.warning}
            suggestions={strength.suggestions}
          />
          {passwordError ? (
            <p
              id={PASSWORD_ERROR_ID}
              className="text-xs text-danger"
              role="alert"
            >
              {passwordError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={CONFIRM_INPUT_ID}>Confirm password</Label>
          <PasswordField
            id={CONFIRM_INPUT_ID}
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={joinIds(
              confirmError ? CONFIRM_ERROR_ID : undefined,
            )}
            {...confirmReg}
            ref={(el) => {
              confirmReg.ref(el);
              confirmInputRef.current = el;
            }}
          />
          {confirmError ? (
            <p
              id={CONFIRM_ERROR_ID}
              className="text-xs text-danger"
              role="alert"
            >
              {confirmError}
            </p>
          ) : null}
        </div>

        {advanceError ? (
          <p className="text-sm text-danger" role="alert">
            {advanceError}
          </p>
        ) : null}
      </div>
    </WizardStepPanel>
  );
}
