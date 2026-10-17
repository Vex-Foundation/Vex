/**
 * Shared row-strip placeholder used by the loading, error and empty states of
 * the session list (and the Studio projects list). Collapses to an icon-only
 * centered strip when the sidebar is closed; shows the icon, if any, plus the
 * label when open.
 *
 * The `sentence` register is the R3 sidebar voice (docs/design/R3-MINIMAL.md
 * section 4): 13 / 1.5 at padding 8 10, muted, and a failure in ink beside its
 * fill, never a hue.
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
   * `registry` is the old mono-uppercase micro-type and stays the default, so
   * a call site that has not moved renders exactly what it did. `sentence` is
   * the R3 voice: the left sidebar's and the Studio rail's placeholders, where
   * "NO PROJECTS YET." in caps would shout a fact that is not urgent.
   */
  readonly register?: "registry" | "sentence";
  /** A leading mark; the R3 empty state has none. */
  readonly icon?: JSX.Element;
}): JSX.Element {
  const sentence = register === "sentence";
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        sentence
          ? "px-2.5 py-2 text-[13px] leading-[1.5]"
          : "p-3 font-mono text-[10px] tracking-[0.16em]",
        sentence
          ? tone === "error"
            ? "text-ink-primary"
            : "text-ink-tertiary"
          : tone === "error"
            ? "text-destructive"
            : "uppercase text-[var(--vex-text-2)]",
        !sidebarOpen && "justify-center px-0",
      )}
    >
      {icon === undefined ? null : (
        <span aria-hidden className="shrink-0">
          {icon}
        </span>
      )}
      {sidebarOpen ? <p className={cn("min-w-0", !sentence && "truncate")}>{text}</p> : null}
    </div>
  );
}
