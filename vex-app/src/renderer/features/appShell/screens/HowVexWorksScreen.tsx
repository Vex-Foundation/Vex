/**
 * "How Vex works" screen - the five-minute tour of the whole app, written
 * for a smart ten-year-old (risk/approval wording stays literal). Static
 * repo markdown (`how-vex-works-content.md`, imported `?raw`) rendered
 * through the article variant of MarkdownContent: sans section heads at
 * 20 / 500 under the serif page head, and local bundled protocol logos
 * (`/protocols/*`, `/logo/*` from public/).
 *
 * A page in the centre column, both sidebars standing (docs/design/R3-MINIMAL.md
 * sections 9.6 and 12): a 680 reading column and, beside it, "On this page",
 * the section heads as keys with the one in view in the blue. The list is read
 * from the rendered article, so it can never name a section the text does not
 * have; a key scrolls its section to the top of the page.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";
import { ShellScreen } from "./ShellScreen.js";
import howVexWorksMd from "./how-vex-works-content.md?raw";

/** How far under the sheet's top a section head counts as "in view". */
const IN_VIEW_OFFSET_PX = 96;

function headingsOf(article: HTMLElement | null): readonly HTMLElement[] {
  return article === null ? [] : [...article.querySelectorAll<HTMLElement>("h2")];
}

export function HowVexWorksScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  const articleRef = useRef<HTMLElement | null>(null);
  const [titles, setTitles] = useState<readonly string[]>([]);
  const [active, setActive] = useState(0);

  // The contents are the article's own h2s, read once it has rendered.
  useLayoutEffect(() => {
    setTitles(headingsOf(articleRef.current).map((node) => node.textContent ?? ""));
  }, []);

  // The section in view: the last head that has reached the top of the sheet.
  useEffect(() => {
    const article = articleRef.current;
    const scroller = article?.closest<HTMLElement>(".vex-ov__scroll") ?? null;
    if (scroller === null) return;
    const update = (): void => {
      const line = scroller.getBoundingClientRect().top + IN_VIEW_OFFSET_PX;
      let current = 0;
      headingsOf(articleRef.current).forEach((node, index) => {
        if (node.getBoundingClientRect().top <= line) current = index;
      });
      setActive(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", update);
    };
  }, [titles.length]);

  const jump = useCallback((index: number): void => {
    const node = headingsOf(articleRef.current)[index];
    if (node === undefined) return;
    if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start" });
    setActive(index);
  }, []);

  return (
    <ShellScreen title="How Vex works" origin={origin} onClose={onClose} width="wide">
      <div className="vex-article" data-vex-screen="how-vex-works">
        <article
          ref={articleRef}
          className="vex-article__col pb-6 text-[15px] leading-[1.65] text-ink-secondary"
        >
          <MarkdownContent text={howVexWorksMd} variant="article" />
        </article>
        {titles.length === 0 ? null : (
          <nav className="vex-article__toc" aria-label="On this page">
            <p className="vex-article__eyebrow">On this page</p>
            <ul className="vex-article__list">
              {titles.map((title, index) => (
                <li key={`${String(index)}-${title}`}>
                  <button
                    type="button"
                    aria-current={index === active ? "true" : undefined}
                    onClick={() => jump(index)}
                  >
                    {title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </ShellScreen>
  );
}
