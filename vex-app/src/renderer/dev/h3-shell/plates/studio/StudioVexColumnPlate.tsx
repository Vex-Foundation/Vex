/**
 * VEX'S COLUMN IN STUDIO, approved as our H3 plate (S8-01, for S8-06), now
 * laid out as D2 lays her panel (docs/design/H3-DESKTOP.md section 6.3):
 * her portrait card, the state row, THIS PROJECT, the console's top block,
 * Open activity and her bars, over the chat's top right.
 *
 * REAL WHERE IT EXISTS. The state row, the console's top block (Needs you,
 * its decision row and the missions row) and Open activity are the product's
 * own components (`VexColumn.tsx`, `VexConsole.tsx`), over the stand-in
 * bridge's fixtures, so they read exactly as the shell's do. The column's box
 * and its rules are the shell's `.vex-vs` and `.vex-col`.
 *
 * DRAWN WHERE IT DOES NOT:
 *   - her portrait card: the card's box (`.vex-col__card`, `.vex-kimm-panel
 *     --card`) on the harness's stand-in still, hidden with the column.
 *   - THIS PROJECT, the console's Studio block (S8-06), on the sample
 *     project: the access as its sentence (the project dialog's own words)
 *     and "Change in project settings"; three facts on 40 rows (Agents,
 *     Wallet, Folder); and PROJECT ASSETS with its arrow.
 */

import type { JSX } from "react";
import { OpenActivityKey, VexConsoleTop } from "../../../../features/vex/VexConsole.js";
import { VexStateRow } from "../../../../features/vex/VexColumn.js";
import { TaglineCell } from "../../../../features/vex/TaglineCell.js";
import { useAllMissions, useVexPresence } from "../../../../features/vex/useVexPresence.js";
import { KIMM_STANDINS } from "../../standins/manifest.js";
import { SAMPLE_PROJECT } from "./studio-sample.js";

/** The project's access as This project states it: the project dialog's own words. */
const ACCESS_SENTENCE = {
  full: "Full access: agents execute supported Vex wallet actions without per-call approval.",
  restricted: "Restricted: Vex asks for approval before executing wallet actions with this project's wallets.",
} as const;

/** Her portrait card (D2, section 6.3), on the stand-in still. */
function PortraitCardPlate(): JSX.Element {
  return (
    <div className="vex-col__card" data-vex-plate-part="portrait-card">
      <div aria-hidden className="vex-kimm-panel vex-kimm-panel--card">
        <div className="vex-kimm-panel__ground" />
        <img
          alt=""
          className="vex-kimm-panel__figure"
          src={KIMM_STANDINS.sections.hi.src}
          width={KIMM_STANDINS.sections.hi.width}
          height={KIMM_STANDINS.sections.hi.height}
        />
      </div>
    </div>
  );
}

/** THIS PROJECT: the open project's access, three facts and its assets (S8-06). */
function ThisProjectPlate(): JSX.Element {
  return (
    <section aria-label="This project" className="vex-console__section" data-vex-plate-part="this-project">
      <h3 className="vex-console__head vex-console__head--section">
        <span className="vex-console__label">This project</span>
      </h3>
      <div className="vex-console__permission">
        <p className="vex-console__permission-sentence">{ACCESS_SENTENCE[SAMPLE_PROJECT.permission]}</p>
        <p className="vex-console__permission-origin">
          <span className="vex-plate-tp__link">Change in project settings</span>
        </p>
      </div>
      <dl className="vex-plate-tp__facts">
        <div className="vex-plate-tp__fact">
          <dt>Agents</dt>
          <dd>{SAMPLE_PROJECT.agents}</dd>
        </div>
        <div className="vex-plate-tp__fact">
          <dt>Wallet</dt>
          <dd>
            {SAMPLE_PROJECT.wallet}{" "}
            <span className="vex-plate-tp__muted vex-num">{SAMPLE_PROJECT.walletAddress}</span>
          </dd>
        </div>
        <div className="vex-plate-tp__fact">
          <dt>Folder</dt>
          <dd className="vex-num">{SAMPLE_PROJECT.displayPath}</dd>
        </div>
      </dl>
      <span className="vex-console__open">
        <span className="vex-console__open-word">Project assets</span>
        <span aria-hidden className="vex-console__arrow">
          →
        </span>
      </span>
    </section>
  );
}

export function StudioVexColumnPlate({
  open,
  band,
}: {
  /** She shows: hidden, the panel is empty and the chat's ground shows. */
  readonly open: boolean;
  /** Under 1024: the band under the header. */
  readonly band: boolean;
}): JSX.Element {
  const presence = useVexPresence();
  const missions = useAllMissions();
  return (
    <aside
      className="vex-vs"
      data-vex-plate-part="vex-column"
      data-vex-vex-open="true"
      data-vex-seat={band ? "band" : "column"}
      data-vex-shown={open ? "true" : "false"}
      aria-label="Vex"
    >
      {band ? (
        <div className="vex-vs__body">
          <VexConsoleTop needsYou={presence.needsYou} missions={missions} />
          {open ? (
            <div aria-hidden className="vex-plate-kimm-well">
              <img
                alt=""
                src={KIMM_STANDINS.sections.hi.src}
                width={KIMM_STANDINS.sections.hi.width}
                height={KIMM_STANDINS.sections.hi.height}
              />
            </div>
          ) : null}
        </div>
      ) : open ? (
        <div className="vex-vs__body">
          <div className="vex-col">
            <PortraitCardPlate />
            <VexStateRow state={presence.state} word={presence.word} timerStartedAt={presence.timerStartedAt} />
            <ThisProjectPlate />
            <VexConsoleTop needsYou={presence.needsYou} missions={missions} />
            <div className="vex-col__foot">
              <OpenActivityKey />
            </div>
            <div className="vex-col__bars">
              <TaglineCell words={false} />
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
