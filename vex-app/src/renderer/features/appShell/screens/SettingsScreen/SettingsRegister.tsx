/**
 * The Settings landing register: section rows in the profile-menu
 * grammar (bare leading icon, name, hint, micro-label status word,
 * chevron) followed by the Preferences group.
 */

import { type JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { IconChevronRight } from "../../../../components/icons/index.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";
import { cn } from "../../../../lib/utils.js";
import { useSuperboardKey } from "../../../../lib/api/superboard-key.js";
import {
  SETTINGS_SECTIONS,
  settingsSectionStatus,
  type SettingsStatusTone,
} from "./settings-sections.js";
import { SettingsPreferences } from "./SettingsPreferences.js";

/** Status = colored WORD (design law) - success / secondary / warning. */
const STATUS_TONE_CLASS: Readonly<Record<SettingsStatusTone, string>> = {
  success: "text-success",
  neutral: "text-ink-secondary",
  warning: "text-warning",
};

export function SettingsRegister({
  env,
  onOpenSection,
}: {
  readonly env: EnvState | null;
  readonly onOpenSection: (section: SettingsSection) => void;
}): JSX.Element {
  const superboardQuery = useSuperboardKey();
  const superboard = superboardQuery.data?.ok === true ? superboardQuery.data.data : null;
  return (
    <div className="mx-auto w-full max-w-[680px]">
      <p className="mb-6 text-[13px] leading-[20px] text-ink-secondary">
        Everything Vex runs on lives in these sections - keys, wallets, the
        model, the Superboard key, and Lighter points. Changes save to this
        machine only.
      </p>
      <ul className="flex flex-col" data-vex-settings-register>
        {SETTINGS_SECTIONS.map((meta) => {
          const status = settingsSectionStatus(meta.id, env, superboard);
          const StepGlyph = meta.icon;
          return (
            <li key={meta.id} className="border-b border-line-1 last:border-b-0">
              <button
                type="button"
                onClick={() => onOpenSection(meta.id)}
                data-vex-settings-row={meta.id}
                className="flex w-full items-center gap-4 rounded-xl px-3 py-4 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center text-ink-secondary">
                  <StepGlyph size={meta.iconSize ?? 20} />
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
                    "shrink-0 vex-micro-label uppercase",
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
