/**
 * Settings screen: the in-shell Settings page (docs/design/R3-MINIMAL.md
 * section 9.6). ONE surface with one nav: the sections by name in four
 * groups with their status words (`SettingsScreen/SettingsRegister.tsx`) on
 * the left, and the open section on the right. Preferences, the App group's
 * row, is where the page lands; every other row hosts the SAME wizard step
 * form in `flowMode="back-edit"` or its own integration view
 * (`SettingsScreen/SettingsSectionView.tsx`; per-chain private-key export
 * lives ONLY in its Wallets branch). The `settings` ShellRoute carries an
 * optional deep-link `section`; none lands on Preferences.
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
import type {
  SettingsSection,
  ShellScreenOrigin,
} from "../../../stores/uiStore.js";
import { EASE_STANDARD } from "../../../lib/motion/index.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import { useSuperboardKey } from "../../../lib/api/superboard-key.js";
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
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  /** Deep-linked section from the route; null lands on Preferences. */
  readonly section: SettingsSection | null;
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
  const select = (id: SettingsNavId): void => {
    setSection(id === "preferences" ? null : id);
  };

  return (
    <ShellScreen title="Settings" origin={origin} onClose={onClose} chapter={null} fill>
      <div className="vex-set" data-vex-settings-page>
        <SettingsRegister
          env={env}
          superboard={superboard}
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
                    completedSteps={completedSteps}
                    onReturn={() => setSection(null)}
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
