/**
 * The welcome's Vex Inference notice: "AI is now paid in VEX", under the
 * greeting, with "Use Vex Inference" (opens the provider setting in Settings)
 * and "Not now" (dismisses it for good).
 *
 * Shown only while the env read is known and names a provider other than
 * Vex Inference (internally `vexcloud`) or none: never while the read is
 * loading or failed, so it cannot flash at someone already on it. The
 * dismissal is a UI preference (`vexInferenceNoticeDismissed`, persisted);
 * it grants or changes nothing about the provider, and "Use Vex Inference"
 * only navigates: nothing is saved until the provider step saves.
 *
 * A labelled region (its title names it), two native keys, no motion. On
 * "Not now" the card leaves and the caret goes to the composer, so keyboard
 * focus never falls to the page.
 */

import { useId, type JSX } from "react";
import { Button } from "../../components/ui/button.js";
import { useEnvState } from "../../lib/api/onboarding.js";
import { useUiStore } from "../../stores/uiStore.js";
import { focusAgentComposer } from "./composer-focus.js";

export const VEX_INFERENCE_NOTICE_COPY = {
  title: "AI is now paid in VEX",
  body: "Vex Inference runs the agent on top models and charges your VEX balance per request. 3% comes back as cashback.",
  use: "Use Vex Inference",
  dismiss: "Not now",
} as const;

export function VexInferenceNotice(): JSX.Element | null {
  const titleId = useId();
  const dismissed = useUiStore((s) => s.vexInferenceNoticeDismissed);
  const setDismissed = useUiStore((s) => s.setVexInferenceNoticeDismissed);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const envQuery = useEnvState();
  const env = envQuery.data?.ok === true ? envQuery.data.data : null;

  if (dismissed || env === null || env.provider.name === "vexcloud") return null;

  return (
    <section
      aria-labelledby={titleId}
      className="vex-welcome__notice"
      data-vex-welcome-notice="vex-inference"
    >
      <h2 id={titleId} className="vex-welcome__notice-title">
        {VEX_INFERENCE_NOTICE_COPY.title}
      </h2>
      <p className="vex-welcome__notice-body">{VEX_INFERENCE_NOTICE_COPY.body}</p>
      <div className="vex-welcome__notice-actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShellRoute({ kind: "settings", origin: null, section: "model" })}
        >
          {VEX_INFERENCE_NOTICE_COPY.use}
        </Button>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => {
            setDismissed(true);
            focusAgentComposer();
          }}
        >
          {VEX_INFERENCE_NOTICE_COPY.dismiss}
        </Button>
      </div>
    </section>
  );
}
