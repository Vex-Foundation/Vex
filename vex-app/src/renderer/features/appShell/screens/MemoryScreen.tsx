/**
 * Memory screen - the Memory page (docs/design/R3-MINIMAL.md sections 9.6 and
 * 12): the serif page head from the sheet, a lead line, the advisory-only
 * guarantee in its own card, "How memory works" one click away (static repo
 * markdown, `?raw` + article-variant MarkdownContent), then the read-only
 * MemoryPanel register. Both sidebars stand.
 */

import type { JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { LineChevronRight } from "../../../components/icons/line/index.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";
import { MemoryPanel } from "../MemoryPanel.js";
import { ShellScreen } from "./ShellScreen.js";
import {
  MEMORY_ADVISORY_TEXT,
  MEMORY_ADVISORY_TITLE,
  MEMORY_LEAD,
  MEMORY_MORE_TITLE,
} from "./memory-explainer.js";
import memoryExplainerMd from "./memory-explainer-content.md?raw";

export function MemoryScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ShellScreen title="Memory" origin={origin} onClose={onClose}>
      <p className="vex-mem-lead">{MEMORY_LEAD}</p>
      <section className="vex-mem-card" aria-label={MEMORY_ADVISORY_TITLE}>
        <h2 className="vex-mem-card__head">
          <Swatch state="done" size={10} className="text-accent-primary" />
          {MEMORY_ADVISORY_TITLE}
        </h2>
        <p className="vex-mem-card__text">{MEMORY_ADVISORY_TEXT}</p>
      </section>
      <details className="vex-mem-more">
        <summary>
          <LineChevronRight size={14} className="vex-mem-more__chev" />
          {MEMORY_MORE_TITLE}
        </summary>
        <div className="vex-mem-more__body">
          <MarkdownContent text={memoryExplainerMd} variant="article" />
        </div>
      </details>
      <MemoryPanel />
    </ShellScreen>
  );
}
