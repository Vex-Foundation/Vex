/**
 * "How Vex works" screen — the five-minute tour of the whole app, written
 * for a smart ten-year-old (risk/approval wording stays literal). Static
 * repo markdown (`how-vex-works-content.md`, imported `?raw`) rendered
 * through the article variant of MarkdownContent: serif h2s and local
 * bundled protocol logos (`/protocols/*`, `/logo/*` from public/).
 */

import type { JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";
import { ShellScreen } from "./ShellScreen.js";
import howVexWorksMd from "./how-vex-works-content.md?raw";

export function HowVexWorksScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ShellScreen title="How Vex works" origin={origin} onClose={onClose}>
      {/* Editorial reading measure: ~72ch column, generous line-height. */}
      <article className="mx-auto w-full max-w-[72ch] pb-6 text-[15px] leading-[1.75] text-ink-secondary">
        <MarkdownContent text={howVexWorksMd} variant="article" />
      </article>
    </ShellScreen>
  );
}
