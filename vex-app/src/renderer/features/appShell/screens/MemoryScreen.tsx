/**
 * Memory screen - the Memory page (docs/design/R3-MINIMAL.md sections 9.6 and
 * 12): a lead line, the advisory-only guarantee in its own card, "How memory
 * works" one click away (static repo markdown, `?raw` + article-variant
 * MarkdownContent), then the read-only MemoryPanel register. Both sidebars
 * stand.
 *
 * In H3 (docs/design/H3-DESKTOP.md sections 1.9 and 4.9; no Memory plate) the
 * page follows the page frame: the header's title cell names the page, so the
 * page draws no head of its own (the h1 stays for assistive tech), and its
 * card, its disclosure and each register list are H3 cells (`memory.css`).
 * Memory has no single refresh time (each register section reads on its
 * own), so the frame draws no tabs row rather than a stamp it cannot back.
 *
 * THE LOOK IS VEX CLOUD'S BUILT MEMORY PAGE (owner decision 2026-11-09,
 * H3-DESKTOP section 4.9: Cloud's built pages are the plates, look only;
 * Cloud's `MemoryPage`, W5 8b3ed699): the lead, then from a 760 page two
 * columns, the register at the left and a 300 side column at the right, 16
 * apart. The side column holds the advisory-only guarantee as a framed box on
 * the card ground, where Cloud keeps its controls box; it comes first in the
 * reading order, so a reader meets the guarantee before the register. The
 * register's lists stand on the card ground, rows 16 in. What the page holds
 * stays desktop's: the guarantee, the explainer and the seven sections.
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
    <ShellScreen title="Memory" origin={origin} onClose={onClose} chapter={null}>
      <p className="vex-mem-lead">{MEMORY_LEAD}</p>
      <div className="vex-mem-page">
        <div className="vex-mem-g">
          <aside className="vex-mem-side" aria-label="About memory">
            <section className="vex-mem-card" aria-label={MEMORY_ADVISORY_TITLE}>
              <h2 className="vex-mem-card__head">
                <Swatch state="done" size={10} className="text-accent-primary" />
                {MEMORY_ADVISORY_TITLE}
              </h2>
              <p className="vex-mem-card__text">{MEMORY_ADVISORY_TEXT}</p>
            </section>
          </aside>
          <div className="vex-mem-main">
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
          </div>
        </div>
      </div>
    </ShellScreen>
  );
}
