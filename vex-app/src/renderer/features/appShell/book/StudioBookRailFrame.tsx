/**
 * The Studio right rail's chrome: the shared `BookRailFrame` with the OPEN
 * PROJECT'S NAME as its headline.
 *
 * A component of its own rather than a branch inside `BookPanel`, for the
 * reason the panel's own doc gives about hooks: the panel is a router whose
 * branches must not make a hook conditional, and the project name needs a
 * query. Reading it here keeps that read inside the branch that wants it.
 *
 * The name is a LABEL. It comes from the same projects read the rail already
 * uses and grants nothing; while the read is in flight the header simply has
 * no headline rather than a placeholder claiming a project that is not
 * confirmed.
 */

import type { JSX, ReactNode } from "react";
import { useProjects } from "../../../lib/api/projects.js";
import { BookRailFrame } from "./BookRailFrame.js";

export function StudioBookRailFrame({
  projectId,
  bookOpen,
  onToggle,
  children,
}: {
  readonly projectId: string;
  readonly bookOpen: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const query = useProjects();
  const projects = query.data !== undefined && query.data.ok ? query.data.data : [];
  const name = projects.find((project) => project.id === projectId)?.name;
  return (
    <BookRailFrame
      label="Project instrument"
      headline={name}
      bookOpen={bookOpen}
      onToggle={onToggle}
    >
      {children}
    </BookRailFrame>
  );
}
