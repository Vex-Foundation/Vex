/**
 * THE STUDIO WELCOME SCREEN - what fills the centre column while no project is
 * selected.
 *
 * VS Code's `welcomeGettingStarted` page is the shape this follows: a short
 * statement of what the surface is, the primary "start something" action, and a
 * list of what you already have, rendered as the same rows the rest of the app
 * uses (`gettingStarted.ts:1036`, `buildRecentlyOpenedList`). Its watermark
 * treatment is the one `editorGroupWatermark.ts` gives an empty editor group;
 * ours is the `VexMark` at low opacity, placed exactly as the terminal's own
 * watermark is (`studio/terminal/XtermHost.tsx`).
 *
 * ## Two things this screen deliberately does NOT have
 *
 * 1. THE CREATE CTA IS CONDITIONAL. The ProjectCreator is stage B4b's. A button
 *    wired to nothing, or wearing roadmap copy, would be a lie about what the
 *    app can do, so the CTA renders only when a caller supplies a real handler.
 *    B4a passes none and the screen simply has no CTA; B4b passes the real one
 *    and the CTA appears with no change here.
 *
 * 2. NO PER-AGENT INSTALL STATE. The plan names it, and it cannot be rendered
 *    honestly yet: the bridge exposes no agent-detection capability on
 *    `window.vex.projects` or `window.vex.studio`, so every value on such a
 *    panel would be invented. It is excluded rather than stubbed - a placeholder
 *    for a fact we do not have is worse than its absence.
 */

import type { JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { VexMark } from "../../../../components/common/VexMark.js";
import { Button } from "../../../../components/ui/button.js";
import { RailGroup } from "../../../../components/ui/rail-list.js";
import { IconPlus } from "../../../../components/icons/index.js";
import { useProjects } from "../../../../lib/api/projects.js";
import { ProjectRailRow } from "../sidebar/ProjectRailRow.js";
import {
  STUDIO_WELCOME_CREATE_LABEL,
  STUDIO_WELCOME_RECENT_EMPTY,
  STUDIO_WELCOME_RECENT_ERROR,
  STUDIO_WELCOME_RECENT_LOADING,
  STUDIO_WELCOME_RECENT_TITLE,
  STUDIO_WELCOME_SENTENCES,
  STUDIO_WELCOME_TITLE,
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

  return (
    <section
      data-vex-area="studio-welcome"
      aria-label={STUDIO_WELCOME_TITLE}
      className="relative flex h-full min-h-0 w-full flex-col items-center overflow-y-auto px-8 py-12"
    >
      {/* Brand backdrop, placed as the terminal's watermark is: decoration
        * under the content, never in the accessible tree, never clickable. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <VexMark size={200} className="text-brand-mark opacity-[0.06]" />
      </div>

      <div className="relative z-10 flex w-full max-w-lg flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[26px] leading-[34px] font-medium tracking-[-0.01em] text-ink-primary">
            {STUDIO_WELCOME_TITLE}
          </h1>
          {STUDIO_WELCOME_SENTENCES.map((sentence) => (
            <p key={sentence} className="text-[14px] leading-[22px] text-ink-secondary">
              {sentence}
            </p>
          ))}
        </div>

        {onCreateProject !== undefined ? (
          <div>
            <Button variant="accent" onClick={onCreateProject}>
              <IconPlus size={15} />
              {STUDIO_WELCOME_CREATE_LABEL}
            </Button>
          </div>
        ) : null}

        <RailGroup
          title={STUDIO_WELCOME_RECENT_TITLE}
          headingId="studio-welcome-projects"
        >
          {query.isLoading ? (
            <li className="px-2 py-1 text-[13px] leading-[20px] text-ink-tertiary">
              {STUDIO_WELCOME_RECENT_LOADING}
            </li>
          ) : query.data !== undefined && !query.data.ok ? (
            <li
              role="status"
              className="px-2 py-1 text-[13px] leading-[20px] text-warning"
            >
              {STUDIO_WELCOME_RECENT_ERROR}
            </li>
          ) : projects.length === 0 ? (
            <li className="px-2 py-1 text-[13px] leading-[20px] text-ink-tertiary">
              {STUDIO_WELCOME_RECENT_EMPTY}
            </li>
          ) : (
            // The order the list returns, never re-sorted here: the handler
            // owns it and a second ordering would be a second answer.
            projects.map((project) => (
              <li key={project.id}>
                <ProjectRailRow
                  project={project}
                  selected={false}
                  onSelect={() => onSelectProject(project.id)}
                />
              </li>
            ))
          )}
        </RailGroup>
      </div>
    </section>
  );
}
