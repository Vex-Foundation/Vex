/**
 * THE STUDIO SIDEBAR, as our H3 plate draws it (S8-01, for S8-04): the 248
 * chats column while Studio is open, and its 76 rail.
 *
 * Top to bottom, in the chats column's grammar (docs/design/H3-DESKTOP.md
 * section 1.4, at S5's numbers):
 *   NEW PROJECT    the 55 cell on the cell fill, where the agent shell has
 *                  NEW CHAT: Studio's one way to make something
 *   Search files   the 48 field; it finds projects and the open project's
 *                  files, as today's Studio search does
 *   the nav        FOLDED to its Studio row, with a chevron that unfolds the
 *                  nine rows in place. Nine rows on the 40 pitch would end at
 *                  552 and leave the projects and the explorer 276 at 900
 *                  high and 96 at 720 (section 4.6); folded, they keep 596
 *   PROJECTS       a 44 head, rows on the 36 pitch (the open one on the
 *                  selected row's fade, a running square and word while a
 *                  shell of its is live), "Show all 4" under three
 *   EXPLORER       a 44 head with the new file, new folder and refresh keys,
 *                  then the tree on a 30 pitch, 16 in per level
 *
 * The rail (the band, and the medium tier's default fold) keeps one key per
 * control: New project, Search, the nine nav keys, and a Projects and files
 * key that opens the same projects and explorer as a 248 drawer over the
 * centre's left edge.
 *
 * Static markup over the plate's sample (`studio-sample.ts`): no project,
 * tree or search is read.
 */

import type { JSX } from "react";
import {
  LineActivity,
  LineBoard,
  LineChat,
  LineChevronDown,
  LineChevronRight,
  LineFile,
  LineFolder,
  LineLighter,
  LineMissions,
  LinePlus,
  LinePortfolio,
  LineRefresh,
  LineSearch,
  LineSettings,
  LineStudio,
  LineWatchlist,
  type LineIconComponent,
} from "../../../../components/icons/line/index.js";
import { StateSquare } from "../../../../components/ui/state-square.js";
import {
  SAMPLE_PROJECTS,
  SAMPLE_PROJECT_TOTAL,
  SAMPLE_TREE,
  type SampleTreeRow,
} from "./studio-sample.js";

/** Desktop's nav (docs/design/H3-DESKTOP.md section 4.6), for the rail's keys. */
const NAV: readonly (readonly [label: string, Icon: LineIconComponent])[] = [
  ["Chat", LineChat],
  ["Missions", LineMissions],
  ["Watchlist", LineWatchlist],
  ["Portfolio", LinePortfolio],
  ["Agent Scan", LineActivity],
  ["Lighter", LineLighter],
  ["Studio", LineStudio],
  ["Board", LineBoard],
  ["Settings", LineSettings],
];

function TreeRow({ row }: { readonly row: SampleTreeRow }): JSX.Element {
  const folder = row.folder !== undefined;
  return (
    <li className="vex-plate-studio-side__node" style={{ paddingLeft: 24 + row.depth * 16 }}>
      <span aria-hidden className="vex-plate-studio-side__twist">
        {row.folder === "open" ? <LineChevronDown size={14} /> : null}
        {row.folder === "closed" ? <LineChevronRight size={14} /> : null}
      </span>
      {folder ? (
        <LineFolder size={14} className="vex-plate-studio-side__glyph" />
      ) : (
        <LineFile size={14} className="vex-plate-studio-side__glyph" />
      )}
      <span className="vex-plate-studio-side__name">{row.name}</span>
    </li>
  );
}

/** PROJECTS and EXPLORER: the column's body, and the rail's drawer. */
function ProjectsAndFiles(): JSX.Element {
  return (
    <>
      <h3 className="vex-plate-studio-side__head">
        <span className="vex-plate-studio-side__label">Projects</span>
      </h3>
      <ul className="vex-plate-studio-side__rows">
        {SAMPLE_PROJECTS.map((project, index) => (
          <li
            key={project.name}
            className="vex-plate-studio-side__project"
            data-selected={index === 0 ? "" : undefined}
          >
            <span className="vex-plate-studio-side__name">{project.name}</span>
            {project.running ? (
              <span className="vex-plate-studio-side__tag">
                <StateSquare state="ongoing" size={6} />
                <span>Running</span>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="vex-plate-studio-side__all">{`Show all ${String(SAMPLE_PROJECT_TOTAL)}`}</div>

      <h3 className="vex-plate-studio-side__head">
        <span className="vex-plate-studio-side__label">Explorer</span>
        <span className="vex-plate-studio-side__keys">
          <span className="vex-plate-studio-side__ikey" title="New file">
            <LineFile size={16} />
          </span>
          <span className="vex-plate-studio-side__ikey" title="New folder">
            <LineFolder size={16} />
          </span>
          <span className="vex-plate-studio-side__ikey" title="Refresh">
            <LineRefresh size={16} />
          </span>
        </span>
      </h3>
      <ul className="vex-plate-studio-side__tree" aria-label="Explorer">
        {SAMPLE_TREE.map((row) => (
          <TreeRow key={`${String(row.depth)}:${row.name}`} row={row} />
        ))}
      </ul>
    </>
  );
}

/** The 248 column. */
export function StudioSidebarPlate(): JSX.Element {
  return (
    <aside className="vex-ls vex-plate-studio-side" aria-label="Studio projects sidebar">
      <div className="vex-plate-studio-side__new">
        <LinePlus size={20} />
        <span>New project</span>
      </div>
      <div className="vex-plate-studio-side__search">
        <LineSearch size={20} />
        <span>Search files</span>
      </div>
      <div className="vex-plate-studio-side__nav">
        <div className="vex-plate-studio-side__nav-row" data-selected="">
          <LineStudio size={20} />
          <span>Studio</span>
          <LineChevronDown size={16} className="vex-plate-studio-side__more" />
        </div>
      </div>
      <ProjectsAndFiles />
    </aside>
  );
}

/**
 * The rail's drawer: the same projects and explorer, 248 wide over the
 * centre's left edge, under the band, so her band stays whole. It closes on
 * a pick, on Escape and on the rail's key.
 */
export function StudioFilesDrawerPlate(): JSX.Element {
  return (
    <aside className="vex-ls vex-plate-studio-side vex-plate-studio-drawer" aria-label="Projects and files">
      <ProjectsAndFiles />
    </aside>
  );
}

/** The 76 rail: a key per control, Studio's nav key on the selected fill. */
export function StudioRailPlate({ drawer = false }: { readonly drawer?: boolean }): JSX.Element {
  return (
    <aside className="vex-ls vex-plate-studio-rail" aria-label="Studio projects sidebar" data-rail="">
      <span className="vex-plate-studio-rail__key vex-plate-studio-rail__key--new" title="New project">
        <LinePlus size={20} />
      </span>
      <span className="vex-plate-studio-rail__key vex-plate-studio-rail__key--search" title="Search files">
        <LineSearch size={20} />
      </span>
      <div className="vex-plate-studio-rail__nav">
        {NAV.map(([label, Icon]) => (
          <span
            key={label}
            className="vex-plate-studio-rail__key vex-plate-studio-rail__key--nav"
            data-selected={label === "Studio" ? "" : undefined}
            title={label}
          >
            <Icon size={20} />
          </span>
        ))}
      </div>
      <span
        className="vex-plate-studio-rail__key vex-plate-studio-rail__key--files"
        data-open={drawer ? "" : undefined}
        title="Projects and files"
      >
        <LineFolder size={20} />
      </span>
    </aside>
  );
}
