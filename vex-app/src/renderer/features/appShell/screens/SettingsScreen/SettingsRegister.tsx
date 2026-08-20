/**
 * The Settings landing register: six section rows in the profile-menu
 * grammar (round hairline icon badge, name, hint, Doto status word,
 * chevron) followed by the Preferences group.
 */

import { type JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import {
  IconChevronRight,
  VexIcon,
} from "../../../../components/icons/index.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";
import { cn } from "../../../../lib/utils.js";
import { WIZARD_STEP_META } from "../../../wizard/index.js";
import {
  SETTINGS_SECTIONS,
  settingsSectionStatus,
  type SettingsStatusTone,
} from "./settings-sections.js";
import { SettingsPreferences } from "./SettingsPreferences.js";

/** Status = colored WORD (design law) - success / tertiary / warning. */
const STATUS_TONE_CLASS: Readonly<Record<SettingsStatusTone, string>> = {
  success: "text-success",
  neutral: "text-ink-tertiary",
  warning: "text-warning",
};

export function SettingsRegister({
  env,
  onOpenSection,
}: {
  readonly env: EnvState | null;
  readonly onOpenSection: (section: SettingsSection) => void;
}): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[680px]">
      <p className="mb-6 text-[13px] leading-[20px] text-ink-secondary">
        Everything Vex runs on lives in these six sections - keys, wallets,
        and the model. Changes save to this machine only.
      </p>
      <ul className="flex flex-col" data-vex-settings-register>
        {SETTINGS_SECTIONS.map((meta) => {
          const status = settingsSectionStatus(meta.id, env);
          return (
            <li key={meta.id} className="border-b border-line-1 last:border-b-0">
              <button
                type="button"
                onClick={() => onOpenSection(meta.id)}
                data-vex-settings-row={meta.id}
                className="flex w-full items-center gap-4 rounded-xl px-3 py-4 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line-2 text-ink-secondary">
                  <VexIcon
                    icon={WIZARD_STEP_META[meta.stepId].icon}
                    size={17}
                    aria-hidden
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14px] leading-[22px] text-ink-primary">
                    {meta.name}
                  </span>
                  <span className="truncate text-[12px] leading-[18px] text-ink-tertiary">
                    {meta.hint}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 font-doto text-[11px] uppercase tracking-[0.14em]",
                    STATUS_TONE_CLASS[status.tone],
                  )}
                >
                  {status.word}
                </span>
                <IconChevronRight size={14} className="shrink-0 text-ink-tertiary" />
              </button>
            </li>
          );
        })}
      </ul>
      <SettingsPreferences />
    </div>
  );
}
