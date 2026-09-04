/**
 * Shared row-strip placeholder used by the loading / error / empty states of
 * the session list. Collapses to an icon-only centered strip when the sidebar
 * is closed; shows the icon plus a truncating label when open.
 *
 * Extracted verbatim from `SessionRows.tsx`. Purely presentational.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";

export function ListPlaceholder({
  sidebarOpen,
  text,
  tone,
  register = "registry",
  icon,
}: {
  readonly sidebarOpen: boolean;
  readonly text: string;
  readonly tone?: "error";
  /**
   * Which type register the line speaks in.
   *
   * `registry` is the session rail's mono-uppercase micro-type and stays the
   * default, so every existing call site renders exactly what it did.
   * `sentence` is the plain secondary voice: the Studio rail's placeholders sit
   * beside sentence-case welcome copy, and "NO PROJECTS YET." in caps shouts a
   * fact that is not urgent.
   */
  readonly register?: "registry" | "sentence";
  readonly icon: JSX.Element;
}): JSX.Element {
  const sentence = register === "sentence";
  return (
    <div
      className={cn(
        // Registry micro-type; error messages keep their sentence case (an
        // uppercase transform on a long IPC message would shout).
        "flex items-center gap-2 p-3",
        sentence
          ? "text-[12px] leading-[18px]"
          : "font-mono text-[10px] tracking-[0.16em]",
        tone === "error"
          ? "text-destructive"
          : cn(!sentence && "uppercase", "text-[var(--vex-text-2)]"),
        !sidebarOpen && "justify-center px-0",
      )}
    >
      <span aria-hidden className="shrink-0">
        {icon}
      </span>
      {sidebarOpen ? <p className="min-w-0 truncate">{text}</p> : null}
    </div>
  );
}
