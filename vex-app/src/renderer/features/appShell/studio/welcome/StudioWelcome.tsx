/**
 * THE STUDIO WELCOME - what fills the centre column while no project is
 * selected (docs/design/R3-MINIMAL.md section 9.5 and the Studio welcome
 * reference). A start screen on paper, a 660 column from 54 below the title
 * bar:
 *
 *   - "Vex Studio" in the serif display register (52 / 1.02, blue, left set);
 *   - three lines of copy and no more (`studio-copy.ts`): what a project is
 *     (15.5 / 1.55 ink), what creating one does (14.5 / 1.55 ink 2), and the
 *     way back to the agent shell (14 muted);
 *   - the Start row: "New project" as the one blue fill, then "Open {first}"
 *     as the quiet key;
 *   - "Projects" (15 / 600) with the count at the right, over a 1px rule, then
 *     the rows (`WelcomeProjectRow`);
 *   - the host's own line at the foot when the title bar has read it: "Vex
 *     Studio is serving your projects. 2 of 8 connections in use."
 *
 * The way back to the agent shell is the left sidebar's nav (its Chat row);
 * the Agent and Studio capsule that used to sit under a wordmark here is gone.
 *
 * ## Two things this screen deliberately does NOT have
 *
 * 1. THE CREATE CTA IS CONDITIONAL. It renders only when a caller supplies a
 *    real handler; a button wired to nothing would be a lie about what the app
 *    can do.
 *
 * 2. NO PER-AGENT STATE OF ANY KIND (owner decision 2026-08-31). Vex does not
 *    detect agent CLIs: the user SELECTS agents in the project creator, the
 *    installer writes their MCP files, and the selection is changed in the
 *    project settings. Per-agent file state is a PROJECT fact and lives where
 *    the project does - the row's drift state and the settings and repair
 *    views - never on a screen that has no project.
 *
 *    THE BRIDGE READINESS PANEL IS NOT AN EXCEPTION TO THIS. It reports
 *    whether this INSTALLATION has a `vex-mcp` binary, which is one fact about
 *    Vex itself and is true or false before any project exists.
 */

import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import { LineFolder, LinePlus } from "../../../../components/icons/line/index.js";
import { Button } from "../../../../components/ui/button.js";
import { Swatch } from "../../../../components/ui/swatch.js";
import { useProjects } from "../../../../lib/api/projects.js";
import { studioKeys } from "../../../../lib/api/queryKeys.js";
import { studioHostStatusView } from "../../StudioHostStatusWord.js";
import { StudioBridgeReadinessPanel } from "./StudioBridgeReadinessPanel.js";
import { WelcomeProjectRow } from "./WelcomeProjectRow.js";
import {
  STUDIO_WELCOME_AGENT_POINTER,
  STUDIO_WELCOME_CREATE_LABEL,
  STUDIO_WELCOME_LEAD,
  STUDIO_WELCOME_NEXT,
  STUDIO_WELCOME_RECENT_EMPTY,
  STUDIO_WELCOME_RECENT_ERROR,
  STUDIO_WELCOME_RECENT_LOADING,
  STUDIO_WELCOME_RECENT_TITLE,
  STUDIO_WELCOME_TITLE,
  studioWelcomeOpenLabel,
  studioWelcomeProjectCount,
} from "../studio-copy.js";

export interface StudioWelcomeProps {
  /**
   * Open the project creator. OPTIONAL on purpose - see the module note. When
   * absent the CTA is not rendered at all.
   */
  readonly onCreateProject?: () => void;
  readonly onSelectProject: (projectId: string) => void;
}

export function StudioWelcome({
  onCreateProject,
  onSelectProject,
}: StudioWelcomeProps): JSX.Element {
  const query = useProjects();
  const projects: readonly ProjectDto[] =
    query.data !== undefined && query.data.ok ? query.data.data : [];
  // "We could not look" is a different fact from "you have none", and BOTH
  // ways the read can fail have to reach it: a settled Result that says
  // `ok: false`, and a REJECTED call that leaves no Result at all (the preload
  // bridge throwing, the window tearing down mid-call). A failed refetch that
  // still has a good earlier list is NOT this state - the rows on screen are
  // real, so `query.isError` alone would be a lie in the other direction.
  const readFailed =
    query.data === undefined ? query.isError : !query.data.ok;
  // The second action opens the project the LIST returned first. The handler
  // owns that order (see the rows below); picking a different one here would be
  // a second answer to "which project is the recent one".
  const firstProject = projects[0] ?? null;
  const showCount = !query.isLoading && !readFailed && projects.length > 0;

  return (
    <section
      data-vex-area="studio-welcome"
      aria-label={STUDIO_WELCOME_TITLE}
      className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto px-10 pb-12"
    >
      <div className="mx-auto w-full max-w-[660px] pt-[54px]">
        <h1 className="m-0 mb-3.5 font-serif text-[52px] leading-[1.02] font-normal tracking-[-0.012em] text-accent-primary">
          {STUDIO_WELCOME_TITLE}
        </h1>
        <p className="m-0 text-[15.5px] leading-[1.55] text-ink-primary">
          {STUDIO_WELCOME_LEAD}
        </p>
        <p className="m-0 mt-2.5 text-[14.5px] leading-[1.55] text-ink-secondary">
          {STUDIO_WELCOME_NEXT}
        </p>
        <p className="m-0 mt-2.5 text-[14px] leading-[1.5] text-ink-tertiary">
          {STUDIO_WELCOME_AGENT_POINTER}
        </p>

        {/* THE BRIDGE DIAGNOSTIC, above the actions on purpose (B1.6).
          *
          * A project created without a bridge gets no coding-agent config
          * files at all, so the fact that the bridge is missing has to be
          * readable BEFORE the button that creates one, not underneath the
          * project list. The panel renders nothing while the check is in
          * flight and nothing when the bridge is there, so on a healthy
          * installation this position costs no space. */}
        <div className="mt-5 empty:hidden">
          <StudioBridgeReadinessPanel />
        </div>

        {/* The Start row: the primary action, and the one that opens what the
          * user already has. Both are absent when they would be dishonest -
          * no creator handler, no create button; no projects, nothing to
          * open. */}
        {onCreateProject !== undefined || firstProject !== null ? (
          <div className="mt-[22px] mb-[30px] flex flex-wrap items-center gap-2.5">
            {onCreateProject !== undefined ? (
              // THE PRIMARY ACTION, marked so the centre's focus seam can find
              // it by name rather than by "the first button on the screen".
              <Button
                variant="primary"
                data-vex-studio-welcome-action="primary"
                onClick={onCreateProject}
              >
                <LinePlus size={16} />
                {STUDIO_WELCOME_CREATE_LABEL}
              </Button>
            ) : null}
            {firstProject !== null ? (
              <Button
                variant="quiet"
                // The primary action when there is no creator handler: the
                // marker names the row's FIRST control, whichever it is.
                data-vex-studio-welcome-action={
                  onCreateProject === undefined ? "primary" : undefined
                }
                onClick={() => onSelectProject(firstProject.id)}
              >
                <LineFolder size={16} />
                {studioWelcomeOpenLabel(firstProject.name)}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="mt-[30px]" />
        )}

        <section aria-labelledby="studio-welcome-projects">
          <div className="flex items-baseline justify-between border-b border-rule pb-2">
            <h2
              id="studio-welcome-projects"
              className="m-0 text-[15px] leading-[1.3] font-semibold text-ink-primary"
            >
              {STUDIO_WELCOME_RECENT_TITLE}
            </h2>
            {showCount ? (
              <span className="text-[12.5px] text-ink-tertiary">
                {studioWelcomeProjectCount(projects.length)}
              </span>
            ) : null}
          </div>
          <ol className="m-0 list-none p-0">
            {query.isLoading ? (
              <li className="flex items-center gap-2 py-3 text-[13.5px] leading-[1.5] text-ink-tertiary">
                <Swatch state="listening" size={10} />
                {STUDIO_WELCOME_RECENT_LOADING}
              </li>
            ) : readFailed ? (
              <li
                role="status"
                className="py-3 text-[13.5px] leading-[1.5] text-ink-primary"
              >
                {STUDIO_WELCOME_RECENT_ERROR}
              </li>
            ) : projects.length === 0 ? (
              <li className="py-3 text-[13.5px] leading-[1.5] text-ink-tertiary">
                {STUDIO_WELCOME_RECENT_EMPTY}
              </li>
            ) : (
              // The order the list returns, never re-sorted here: the handler
              // owns it and a second ordering would be a second answer.
              projects.map((project) => (
                <li key={project.id}>
                  <WelcomeProjectRow
                    project={project}
                    onSelect={() => onSelectProject(project.id)}
                  />
                </li>
              ))
            )}
          </ol>
        </section>

        <StudioHostLine />
      </div>
    </section>
  );
}

/**
 * The host's own line at the foot, from the status the title bar already
 * reads and keeps live. A PASSIVE read of that cache (`enabled: false`): this
 * screen never asks main and never subscribes, because the host status event
 * has one subscriber per window and it is the title bar's. Until the title bar
 * has an answer there is no line; it says the state there.
 */
function StudioHostLine(): JSX.Element | null {
  const query = useQuery<Result<StudioHostStatus>>({
    queryKey: studioKeys.hostStatus(),
    queryFn: () => window.vex.studio.getHostStatus(),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const result = query.data;
  if (result === undefined || !result.ok) return null;
  const view = studioHostStatusView(result.data);
  return (
    <p
      data-vex-studio-host-line=""
      className="m-0 mt-4 flex items-center gap-2 text-[12.5px] leading-[1.45] text-ink-tertiary"
    >
      <span className={view.tone === "lit" ? "flex text-accent-primary" : "flex text-ink-primary"}>
        <Swatch state={view.dot} size={10} />
      </span>
      <span>
        {view.headline}
        {view.reason === null ? null : ` ${view.reason}`}
      </span>
    </p>
  );
}
