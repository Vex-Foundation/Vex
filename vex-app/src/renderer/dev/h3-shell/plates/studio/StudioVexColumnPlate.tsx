/**
 * VEX'S COLUMN IN STUDIO, as our H3 plate draws it (S8-01, for S8-06).
 *
 * REAL WHERE IT EXISTS. The console's top block (Needs you, its decision row
 * and the missions row) and its recent activity with Open activity are the
 * product's own components (`VexConsole.tsx`), over the stand-in bridge's
 * fixtures, so they read exactly as the shell's do. The column's box and its
 * rules are the shell's `.vex-vs`.
 *
 * DRAWN WHERE IT DOES NOT, YET:
 *   - her section: S4's box (docs/design/H3-DESKTOP.md section 1.5), from
 *     the top block's foot (y 224 at 1440 x 900) to one pixel above the
 *     bottom row, on the harness's stand-in crops. Closed, it folds to the 56
 *     strip with SHOW VEX in the corner; open, HIDE VEX.
 *   - THIS PROJECT, the console's Studio block (S8-06): where a chat's AI
 *     PERMISSION stands, since a project's access is its permission. A 44
 *     head; the access as its sentence (the project dialog's own words) and
 *     "Change in project settings", which is true here: a project's access
 *     can be changed, a chat's cannot; three facts on 40 rows (Agents,
 *     Wallet, Folder); and PROJECT ASSETS with its arrow. The Studio host's
 *     state is not here: it is the header's cell, so it stays in view while
 *     she is open (`StudioHeaderTitle`).
 *
 * Under 1024 the column is the band (section 1.10): the top block across it,
 * and her portrait well at the right while she is open. The band has no room
 * for the console's rest, so This project is not shown there; the header's
 * line keeps the project's name and access.
 */

import type { JSX } from "react";
import { LineChevronDown, LineClose } from "../../../../components/icons/line/index.js";
import { VexConsoleActivity, VexConsoleTop } from "../../../../features/vex/VexConsole.js";
import { useAllMissions, useVexPresence } from "../../../../features/vex/useVexPresence.js";
import { KIMM_STANDINS } from "../../standins/manifest.js";
import { SAMPLE_PROJECT } from "./studio-sample.js";

/** The project's access as This project states it: the project dialog's own words. */
const ACCESS_SENTENCE = {
  full: "Full access: agents execute supported Vex wallet actions without per-call approval.",
  restricted: "Restricted: Vex asks for approval before executing wallet actions with this project's wallets.",
} as const;

/** Her section in S4's geometry, on the stand-in art. */
function KimmSectionPlate({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <div className="vex-plate-kimm" data-open={open ? "true" : "false"} data-vex-plate-part="kimm-section">
      <div aria-hidden className="vex-plate-kimm__ground" />
      {open ? (
        <img
          alt=""
          className="vex-plate-kimm__figure"
          src={KIMM_STANDINS.sections.hi.src}
          width={KIMM_STANDINS.sections.hi.width}
          height={KIMM_STANDINS.sections.hi.height}
        />
      ) : (
        <img
          alt=""
          className="vex-plate-kimm__strip"
          src={KIMM_STANDINS.strip.src}
          width={KIMM_STANDINS.strip.width}
          height={KIMM_STANDINS.strip.height}
        />
      )}
      <span className="vex-plate-kimm__key">
        <span>{open ? "Hide Vex" : "Show Vex"}</span>
        {open ? <LineClose size={16} /> : <LineChevronDown size={16} />}
      </span>
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
  /** Her section is open. */
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
      aria-label="Vex"
    >
      <div className="vex-vs__body">
        <VexConsoleTop needsYou={presence.needsYou} missions={missions} />
        {band ? (
          open ? (
            <div aria-hidden className="vex-plate-kimm-well">
              <img
                alt=""
                src={KIMM_STANDINS.sections.hi.src}
                width={KIMM_STANDINS.sections.hi.width}
                height={KIMM_STANDINS.sections.hi.height}
              />
            </div>
          ) : null
        ) : (
          <>
            <KimmSectionPlate open={open} />
            <div className="vex-vs__rest" data-vex-area="vex-console-rest">
              <ThisProjectPlate />
              <VexConsoleActivity />
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
