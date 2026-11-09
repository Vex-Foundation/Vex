/**
 * Fenced code block, as VEX Cloud draws one (`.md-code-block`): the well in
 * the 1px rule, under a sticky 40 bar on the card ground that holds the
 * language in caps 11 muted, then Wrap and Copy as 40 cells, each with its
 * left rule. The code is set in the mono on the same code-token palette the
 * Studio viewer's shiki theme writes (`--vex-alias-code-*`); Wrap folds its
 * long lines (a press, `aria-pressed`). Styles: `.vex-code-block` in
 * chat-transcript.css. The copy button writes the token's RAW string via
 * the clipboard API; it never re-enters the React tree, so the no-HTML-sink
 * invariant is untouched.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { LineCheck, LineCopy } from "../../../components/icons/line/index.js";
import { LineSvg } from "../../../components/icons/line/LineSvg.js";

/** The wrap glyph: a line that runs on and turns back under itself. */
function WrapGlyph(): JSX.Element {
  return (
    <LineSvg size={16}>
      <path d="M2.5 4.5h11M2.5 8.5h9a2 2 0 0 1 0 4h-3M10 11l-1.5 1.5L10 14M2.5 12.5h3" />
    </LineSvg>
  );
}
import { highlightLines } from "../highlight.js";

const KIND_CLASS = {
  plain: undefined,
  keyword: "vex-code-keyword",
  string: "vex-code-string",
  number: "vex-code-number",
  comment: "vex-code-comment",
  property: "vex-code-property",
} as const;

/**
 * Classed runs for a known language, the raw string otherwise. React nodes
 * only — the highlighter never produces HTML.
 */
function highlightedCode(code: string, lang: string): ReactNode {
  const lines = highlightLines(code, lang);
  if (lines === null) return code;
  return lines.map((spans, lineIndex) => (
    // Index keys are correct: lines are a fixed projection of the memoized code.
    <span key={lineIndex}>
      {lineIndex > 0 ? "\n" : null}
      {spans.map((span, i) =>
        KIND_CLASS[span.kind] === undefined ? (
          span.text
        ) : (
          <span key={i} className={KIND_CLASS[span.kind]}>
            {span.text}
          </span>
        ),
      )}
    </span>
  ));
}

const COPY_RESET_MS = 1_500;

export function CodeBlock({
  lang,
  code,
}: {
  readonly lang: string;
  readonly code: string;
}): JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  // Memoized on the code: a settled block must not re-tokenize per parent
  // render (streaming previews re-render at commit rate).
  const body = useMemo(() => highlightedCode(code, lang), [code, lang]);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The reset timer must not fire setState after unmount.
  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      // Clipboard can be denied/unavailable — surface it instead of lying.
      setCopyState("failed");
    }
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), COPY_RESET_MS);
  };

  const [wrap, setWrap] = useState(false);
  return (
    <div className="vex-code-block" data-wrap={wrap ? "" : undefined}>
      <div className="vex-code-block__head">
        <span className="vex-code-block__lang">{lang}</span>
        <span className="vex-code-block__keys">
          <button
            type="button"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
            className="vex-code-block__key"
          >
            <WrapGlyph />
          </button>
          <button
            type="button"
            aria-label={
              copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy code"
            }
            onClick={() => void onCopy()}
            className="vex-code-block__key"
          >
            {copyState === "copied" ? <LineCheck size={16} /> : <LineCopy size={16} />}
          </button>
        </span>
      </div>
      <pre className="vex-code-block__pre max-h-[480px] overflow-auto bg-[var(--vex-alias-code-background)] px-4 py-3 font-code text-[12.5px] leading-[1.6] text-[var(--vex-alias-code-foreground)]">
        <code>{body}</code>
      </pre>
    </div>
  );
}
