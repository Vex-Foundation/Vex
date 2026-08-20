/**
 * MemoryMarker — static inline recall indicator (stage 8-4): the
 * `ProvenanceMarker` preset for an assistant tool-call row that invoked
 * `session_memory_search` (per-session narrative memory) or a `long_memory_*`
 * read (durable cross-session memory). The copy stays distinct so
 * cross-session memory is never mislabeled as session memory; an
 * unknown/missing recall tool falls back to neutral copy. Static by design —
 * a persisted row has no reliable "recalling…" state.
 */

import type { ComponentType, JSX } from "react";
import {
  IconBookOpen,
  IconBrain,
  type GlyphProps,
  IconSparkle,
} from "../../components/icons/index.js";
import { ProvenanceMarker } from "./ProvenanceMarker.js";

interface RecallCopy {
  readonly label: string;
  readonly icon: ComponentType<GlyphProps>;
}

function recallCopy(toolName: string | null): RecallCopy {
  switch (toolName) {
    case "session_memory_search":
      return { label: "Recalled session memory", icon: IconBrain };
    case "long_memory_search":
    case "long_memory_get":
    case "long_memory_history":
      return {
        label: "Recalled long-term memory",
        icon: IconBookOpen,
      };
    default:
      return { label: "Recalled context", icon: IconSparkle };
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
    <ProvenanceMarker
      marker="recall"
      label={label}
      icon={icon}
      content={content}
    />
  );
}
