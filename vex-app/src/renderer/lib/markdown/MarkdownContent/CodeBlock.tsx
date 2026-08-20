/**
 * Fenced code block — recessed case file: hairline wrapper on the surface-down
 * well with a language strip + copy key. The copy button writes the token's
 * RAW string via the clipboard API — it never re-enters the React tree, so the
 * no-HTML-sink invariant is untouched.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { IconCopy } from "../../../components/icons/index.js";
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
    <div className="overflow-hidden rounded-[10px] border border-[var(--vex-line)] bg-[var(--vex-surface-down)]">
      <div className="flex h-7 items-center justify-between border-b border-[var(--vex-line)] px-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
          {lang}
        </span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => void onCopy()}
          className="flex items-center text-[var(--vex-text-3)] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {copyState === "idle" ? (
            <IconCopy size={12} />
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
              {copyState === "copied" ? "Copied" : "Copy failed"}
            </span>
          )}
        </button>
      </div>
      <pre className="max-h-[480px] overflow-auto px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-[var(--vex-text-2)]">
        <code>{body}</code>
      </pre>
    </div>
  );
}
