/**
 * Memory screen — the Memory ShellScreen: a plain-words explainer of how
 * Vex's memory works (static repo markdown, `?raw` + article-variant
 * MarkdownContent) above the read-only MemoryPanel register.
 */

import type { JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";
import { MemoryPanel } from "../MemoryPanel.js";
import { ShellScreen } from "./ShellScreen.js";
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
      {/* Comfortable reading measure for the intro; the register below keeps
       * its own 760px ledger width. */}
      <div className="mx-auto mb-8 w-full max-w-[72ch] text-[14.5px] leading-[1.7] text-ink-secondary">
        <MarkdownContent text={memoryExplainerMd} variant="article" />
      </div>
      <MemoryPanel />
    </ShellScreen>
  );
}
