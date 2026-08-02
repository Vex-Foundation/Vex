/**
 * MemoryMarker — static inline recall indicator (stage 8-4, S3
 * ledger-interruption grammar). Rendered for an assistant tool-call row that
 * invoked `session_memory_search` (per-session narrative memory) or a
 * `long_memory_*` read (durable cross-session memory). The copy stays
 * distinct so cross-session memory is never mislabeled as session memory; an
 * unknown/missing recall tool falls back to neutral copy.
 *
 * Any assistant prose on the row is preserved below the centered hairline
 * indicator as a recessed well (plain text — never markdown/HTML). Static by
 * design — a persisted row has no reliable "recalling…" state.
 */

import type { JSX } from "react";
import {
  BookOpen01Icon,
  Brain01Icon,
  type IconGlyph,
  SparklesIcon,
  VexIcon,
} from "../../components/icons/index.js";

interface RecallCopy {
  readonly label: string;
  readonly icon: IconGlyph;
}

function recallCopy(toolName: string | null): RecallCopy {
  switch (toolName) {
    case "session_memory_search":
      return { label: "Recalled session memory", icon: Brain01Icon };
    case "long_memory_search":
    case "long_memory_get":
    case "long_memory_history":
      return {
        label: "Recalled long-term memory",
        icon: BookOpen01Icon,
      };
    default:
      return { label: "Recalled context", icon: SparklesIcon };
  }
}

export function MemoryMarker({
  toolName,
  content,
}: {
  readonly toolName: string | null;
  readonly content: string;
}): JSX.Element {
  const { label, icon } = recallCopy(toolName);
  return (
    <div
      data-vex-message-role="system"
      data-vex-marker="recall"
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-[var(--vex-line)]" />
        <span className="flex min-w-0 items-center gap-1.5 text-[var(--vex-text-3)]">
          <VexIcon icon={icon} size={12} aria-hidden />
          <span className="break-words font-mono text-[10px] uppercase tracking-[0.3em]">
            {label}
          </span>
        </span>
        <span aria-hidden className="h-px flex-1 bg-[var(--vex-line)]" />
      </div>
      {content.length > 0 ? (
        <span
          data-vex-marker-content=""
          className="block whitespace-pre-wrap break-words rounded-[6px] border border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-3 py-2 text-xs text-[var(--vex-text-2)]"
        >
          {content}
        </span>
      ) : null}
    </div>
  );
}
