/**
 * Settings screen - the in-shell Settings ShellScreen. Two registers in
 * one surface: the landing register (six section rows + the Preferences
 * group - see `SettingsScreen/SettingsRegister.tsx`) and the section
 * sub-view hosting the SAME wizard step form in `flowMode="back-edit"`
 * (`SettingsScreen/SettingsSectionView.tsx`; per-chain private-key export
 * lives ONLY in its Wallets branch). The `settings` ShellRoute carries an
 * optional deep-link `section`. Chrome, dialog semantics, and the FLIP
 * morph belong to `ShellScreen` - this screen adds no glass of its own.
 * Sub-view swaps are a local slide/fade (transform/opacity only,
 * CSP-safe; reduced motion collapses durations to zero).
 */

import { useEffect, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconChevronLeft } from "../../../components/icons/index.js";
import type {
  SettingsSection,
  ShellScreenOrigin,
} from "../../../stores/uiStore.js";
import { EASE_STANDARD } from "../../../lib/motion/index.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import { useWizardState } from "../../../lib/api/wizard.js";
import { ShellScreen } from "./ShellScreen.js";
import { SETTINGS_SECTIONS } from "./SettingsScreen/settings-sections.js";
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
  /** Deep-linked section from the route; null lands on the register. */
  readonly section: SettingsSection | null;
  readonly onClose: () => void;
}): JSX.Element {
  const [section, setSection] = useState<SettingsSection | null>(initialSection);
  // A later deep-link into an already-open screen still lands its section.
  useEffect(() => {
    if (initialSection !== null) setSection(initialSection);
  }, [initialSection]);
  // Sampled once per mount, like ShellScreen - a live OS flip can wait.
  const [reduced] = useState(prefersReducedMotion);

  const envQuery = useEnvState();
  const env = envQuery.data?.ok === true ? envQuery.data.data : null;
  const wizardStateQuery = useWizardState();
  const completedSteps =
    wizardStateQuery.data?.ok === true
      ? wizardStateQuery.data.data.completedSteps
      : [];

  const activeMeta =
    section === null
      ? null
      : (SETTINGS_SECTIONS.find((s) => s.id === section) ?? null);

  return (
    <ShellScreen
      title="Settings"
      origin={origin}
      onClose={onClose}
      {...(activeMeta !== null
        ? {
            header: (
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setSection(null)}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-line-2 px-4 text-[13px] leading-[20px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                  data-vex-settings-back
                >
                  <IconChevronLeft size={14} />
                  Settings
                </button>
                <span className="vex-micro-label uppercase text-ink-secondary">
                  {activeMeta.name}
                </span>
              </div>
            ),
          }
        : {})}
    >
      <AnimatePresence mode="wait" initial={false}>
        {activeMeta === null ? (
          <motion.div
            key="register"
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: EASE_STANDARD }}
          >
            <SettingsRegister env={env} onOpenSection={setSection} />
          </motion.div>
        ) : (
          <motion.div
            key={activeMeta.id}
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: EASE_STANDARD }}
          >
            <SettingsSectionView
              meta={activeMeta}
              env={env}
              completedSteps={completedSteps}
              onReturn={() => setSection(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </ShellScreen>
  );
}
