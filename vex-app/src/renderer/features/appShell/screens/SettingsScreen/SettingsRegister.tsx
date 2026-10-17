/**
 * The Settings landing register: the section index (italic numerals, name,
 * hint, a mono status word with its fill swatch, docs/design/V10-SPREAD.md
 * sections 1 and 2) followed by the Preferences group.
 */

import { type JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { Swatch, type SwatchState } from "../../../../components/ui/swatch.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";
import { useSuperboardKey } from "../../../../lib/api/superboard-key.js";
import { useIsNativeRuntime } from "../../../../lib/api/system.js";
import { useNativeRuntimeStatus } from "../../../runtime/bootstrap/useNativeRuntimeStatus.js";
import {
  settingsSectionStatus,
  visibleSettingsSections,
  type SettingsStatusTone,
} from "./settings-sections.js";
import { SettingsPreferences } from "./SettingsPreferences.js";

/** Status is a fill, not a hue: set is solid, neutral an outline, attention a target. */
const STATUS_SWATCH: Readonly<Record<SettingsStatusTone, SwatchState>> = {
  success: "done",
  neutral: "idle",
  warning: "warning",
};

/** The index numeral: two digits in parentheses, a stable ordinal of the row. */
function numeral(index: number): string {
  return `(${String(index + 1).padStart(2, "0")})`;
}

export function SettingsRegister({
  env,
  onOpenSection,
}: {
  readonly env: EnvState | null;
  readonly onOpenSection: (section: SettingsSection) => void;
}): JSX.Element {
  const superboardQuery = useSuperboardKey();
  const superboard = superboardQuery.data?.ok === true ? superboardQuery.data.data : null;
  const native = useIsNativeRuntime();
  // Main's live runtime status; `idle` and unused outside the native runtime.
  const { status: runtimeStatus } = useNativeRuntimeStatus();
  const sections = visibleSettingsSections(native);
  return (
    <div className="w-full">
      <p className="mb-6 max-w-[56ch] text-[13px] leading-[19px] text-ink-secondary">
        Everything Vex runs on lives in these sections - keys, wallets, the
        model, the Superboard key, and Lighter points. Changes save to this
        machine only.
      </p>
      <ul className="vex-reg" data-vex-settings-register>
        {sections.map((meta, index) => {
          const status = settingsSectionStatus(meta.id, env, superboard, runtimeStatus);
          return (
            <li key={meta.id} className="vex-reg__item">
              <button
                type="button"
                onClick={() => onOpenSection(meta.id)}
                data-vex-settings-row={meta.id}
                className="vex-reg__row"
              >
                <span aria-hidden className="vex-reg__num">
                  {numeral(index)}
                </span>
                <span className="min-w-0">
                  <span className="vex-reg__name">{meta.name}</span>
                  <span className="vex-reg__hint">{meta.hint}</span>
                </span>
                <span className="vex-reg__status">
                  <Swatch state={STATUS_SWATCH[status.tone]} size={9} />
                  {status.word}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <SettingsPreferences />
    </div>
  );
}
