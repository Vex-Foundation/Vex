/**
 * The Settings nav (docs/design/R3-MINIMAL.md section 9.6): one column of
 * sections by name in four groups (App, Security and wallets, The agent,
 * Connections), each row a line icon, the name and, at the right, its status
 * word with the fill swatch. The selected row follows the open section
 * (`aria-current`); Preferences, the App group's one row, has no status.
 * Status is a fill and a word, never a hue.
 */

import { useId, type JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { LineIcon } from "../../../../components/icons/line/index.js";
import { Swatch } from "../../../../components/ui/swatch.js";
import { useIsNativeRuntime } from "../../../../lib/api/system.js";
import { useNativeRuntimeStatus } from "../../../runtime/bootstrap/useNativeRuntimeStatus.js";
import type { UserMcpListDto } from "@shared/schemas/user-mcp.js";
import {
  settingsNav,
  settingsSectionStatus,
  settingsStatusSwatch,
  type SettingsNavId,
} from "./settings-sections.js";

export function SettingsRegister({
  env,
  superboard,
  userMcp = null,
  selected,
  onSelect,
}: {
  readonly env: EnvState | null;
  readonly superboard: SuperboardKeyStatus | null;
  /** The Tools (MCP) list, for its status word; `null` until it loads. */
  readonly userMcp?: UserMcpListDto | null;
  readonly selected: SettingsNavId;
  readonly onSelect: (id: SettingsNavId) => void;
}): JSX.Element {
  const idBase = useId();
  const native = useIsNativeRuntime();
  // Main's live runtime status; `idle` and unused outside the native runtime.
  const { status: runtimeStatus } = useNativeRuntimeStatus();
  return (
    <nav className="vex-set__nav" aria-label="Settings sections" data-vex-settings-register>
      {settingsNav(native).map((group, index) => {
        const headId = `${idBase}-${index}`;
        return (
          <div key={group.name} role="group" aria-labelledby={headId}>
            <div id={headId} className="vex-set__group">
              {group.name}
            </div>
            {group.items.map((item) => {
              const status =
                item.id === "preferences"
                  ? null
                  : settingsSectionStatus(item.id, env, superboard, runtimeStatus, userMcp);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-current={selected === item.id ? "page" : undefined}
                  data-vex-settings-row={item.id}
                  className="vex-set__item"
                >
                  <LineIcon name={item.icon} size={16} className="vex-set__icon" />
                  <span className="vex-set__name">{item.name}</span>
                  {status === null ? null : (
                    <span className="vex-set__word">
                      <Swatch state={settingsStatusSwatch(status.tone)} size={9} />
                      {status.word}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
