/**
 * Settings screen: the in-shell Settings page (docs/design/R3-MINIMAL.md
 * section 9.6). ONE surface with one nav: the sections by name in four
 * groups with their status words (`SettingsScreen/SettingsRegister.tsx`) on
 * the left, and the open section on the right. Preferences, the App group's
 * row, is where the page lands; every other row hosts the SAME wizard step
 * form in `flowMode="back-edit"` or its own integration view
 * (`SettingsScreen/SettingsSectionView.tsx`; per-chain private-key export
 * lives ONLY in its Wallets branch). The `settings` ShellRoute carries an
 * optional deep-link `section`; none lands on Preferences. On the Inference
 * section it may also name the provider choice to show
 * (`inferenceProvider`, `inferenceSettingsRoute`), so every way into the Vex
 * Inference account lands on it without switching the provider.
 *
 * The route follows what is on screen: picking a section or a provider
 * choice replaces the route in place (the page trail never pushes a move
 * within one page), so a page opened from here (Fund) closes back to the
 * same section and choice.
 *
 * Chrome, dialog semantics, Escape and the FLIP morph belong to `ShellScreen`
 * (the page sheet, section 12); the title bar names the page, so there is no
 * in-page head or back row: the nav IS the way between sections. Vex's
 * sidebar is hidden here by default (a table page, `vexOpenPages`), because
 * the nav and the section need the width.
 *
 * Section swaps are a local slide and fade (transform and opacity only,
 * CSP-safe; reduced motion collapses the durations to zero).
 */

import { useEffect, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ProviderName } from "@shared/schemas/provider.js";
import {
  useUiStore,
  type SettingsSection,
  type ShellScreenOrigin,
} from "../../../stores/uiStore.js";
import { EASE_STANDARD } from "../../../lib/motion/index.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import { useSuperboardKey } from "../../../lib/api/superboard-key.js";
import { useUserMcpList } from "../../../lib/api/user-mcp.js";
import { useWizardState } from "../../../lib/api/wizard.js";
import { useIsNativeRuntime } from "../../../lib/api/system.js";
import { ShellScreen } from "./ShellScreen.js";
import {
  visibleSettingsSections,
  type SettingsNavId,
} from "./SettingsScreen/settings-sections.js";
import { SettingsPreferences } from "./SettingsScreen/SettingsPreferences.js";
import { SettingsRegister } from "./SettingsScreen/SettingsRegister.js";
import { SettingsSectionView } from "./SettingsScreen/SettingsSectionView.js";

/** jsdom-safe reduced-motion probe (matchMedia may be absent in jsdom). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function SettingsScreen({
  origin,
  section: initialSection,
  inferenceProvider = null,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  /** Deep-linked section from the route; null lands on Preferences. */
  readonly section: SettingsSection | null;
  /** Inference only: the provider choice to show; null shows the active provider. */
  readonly inferenceProvider?: ProviderName | null;
  readonly onClose: () => void;
}): JSX.Element {
  // null is Preferences, the page's landing section.
  const [section, setSection] = useState<SettingsSection | null>(initialSection);
  // A later deep-link into an already-open screen still lands its section.
  useEffect(() => {
    if (initialSection !== null) setSection(initialSection);
  }, [initialSection]);
  // Sampled once per mount, like ShellScreen - a live OS flip can wait.
  const [reduced] = useState(prefersReducedMotion);

  const envQuery = useEnvState();
  const env = envQuery.data?.ok === true ? envQuery.data.data : null;
  const superboardQuery = useSuperboardKey();
  const superboard = superboardQuery.data?.ok === true ? superboardQuery.data.data : null;
  const userMcpQuery = useUserMcpList();
  const userMcp = userMcpQuery.data?.ok === true ? userMcpQuery.data.data : null;
  const wizardStateQuery = useWizardState();
  const completedSteps =
    wizardStateQuery.data?.ok === true
      ? wizardStateQuery.data.data.completedSteps
      : [];

  // A section this install does not list (the native-only one elsewhere) lands
  // on Preferences, deep link or not.
  const native = useIsNativeRuntime();
  const activeMeta =
    section === null
      ? null
      : (visibleSettingsSections(native).find((s) => s.id === section) ?? null);
  const selected: SettingsNavId = activeMeta === null ? "preferences" : activeMeta.id;
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  // Same-kind route moves replace in place (page-trail.ts), so this keeps
  // the way back true without stepping through sections on close.
  const select = (id: SettingsNavId): void => {
    const next = id === "preferences" ? null : id;
    setSection(next);
    setShellRoute({ kind: "settings", origin, section: next, inferenceProvider: null });
  };
  const onInferenceChoiceChange = (choice: ProviderName): void => {
    setShellRoute({ kind: "settings", origin, section: "inference", inferenceProvider: choice });
  };

  return (
    <ShellScreen title="Settings" origin={origin} onClose={onClose} chapter={null} fill>
      <div className="vex-set" data-vex-settings-page>
        <SettingsRegister
          env={env}
          superboard={superboard}
          userMcp={userMcp}
          selected={selected}
          onSelect={select}
        />
        <div className="vex-set__body" data-vex-settings-body>
          <div className="vex-set__col">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={selected}
                initial={reduced ? false : { opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
                transition={{ duration: reduced ? 0 : 0.22, ease: EASE_STANDARD }}
              >
                {activeMeta === null ? (
                  <SettingsPreferences />
                ) : (
                  <SettingsSectionView
                    meta={activeMeta}
                    env={env}
                    superboard={superboard}
                    userMcp={userMcp}
                    completedSteps={completedSteps}
                    onReturn={() => select("preferences")}
                    inferenceProvider={inferenceProvider}
                    onInferenceChoiceChange={onInferenceChoiceChange}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </ShellScreen>
  );
}
