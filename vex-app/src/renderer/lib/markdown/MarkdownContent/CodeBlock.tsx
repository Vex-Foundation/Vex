/**
 * Fenced code block: a well on paper 2 (docs/design/R3-MINIMAL.md section 6)
 * with a language strip + copy key in the sans at 12 muted, the code set in
 * JetBrains Mono on the same code-token palette the Studio viewer's shiki
 * theme writes (`--vex-alias-code-*`). Styles: `.vex-code-block` in
 * chat-transcript.css. The copy button writes the token's RAW string via
 * the clipboard API; it never re-enters the React tree, so the no-HTML-sink
 * invariant is untouched.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { LineCopy } from "../../../components/icons/line/index.js";
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

  return (
    <div className="vex-code-block">
      <div className="vex-code-block__head">
        <span>{lang}</span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => void onCopy()}
          className="flex items-center text-ink-tertiary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {copyState === "idle" ? (
            <LineCopy size={14} />
          ) : (
            <span>{copyState === "copied" ? "Copied" : "Copy failed"}</span>
          )}
        </button>
      </div>
      <pre className="max-h-[480px] overflow-auto bg-[var(--vex-alias-code-background)] px-4 py-3 font-code text-[12.5px] leading-[1.6] text-[var(--vex-alias-code-foreground)]">
        <code>{body}</code>
      </pre>
    </div>
  );
}
