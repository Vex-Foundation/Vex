/**
 * Memory panel - read-only memory register, mounted inside the Memory
 * ShellScreen (docs/design/R3-MINIMAL.md sections 9.6 and 12; the screen owns
 * the page sheet and the scroll well, so this is pure flow content).
 * A thin composer over seven sections, each in its own
 * module so every file stays under the 400-line budget:
 *
 *  1. **Long-term memory** (S9 rewire) — `LongMemorySection.tsx`
 *  2. **Memory candidates** (S10 inspector) — `CandidatesSection.tsx`
 *  3. **Manager decisions** (S10 inspector) — `DecisionsSection.tsx`
 *  4. **Memory jobs** (S10 inspector) — `JobsSection.tsx`
 *  5. **Session memory** (7-2a) — `SessionMemorySection.tsx`
 *  6. **Compaction history** (7-2a) — `CompactionHistorySection.tsx`
 *  7. **Memory & privacy** (7-4) — `MemoryPrivacySection.tsx`
 *
 * Every value is the sanitized DTO from main — never raw narrative bodies,
 * outstanding-item text, or embeddings. Session-scoped sections show a clear
 * empty state when no session is active (and issue no session-scoped query).
 * Shared presentational primitives live in `MemoryPanelShared.tsx`.
 */

import type { JSX } from "react";
import { useUiStore } from "../../stores/uiStore.js";
import { LongMemorySection } from "./LongMemorySection.js";
import { CandidatesSection } from "./CandidatesSection.js";
import { DecisionsSection } from "./DecisionsSection.js";
import { JobsSection } from "./JobsSection.js";
import { MemorySection } from "./SessionMemorySection.js";
import { CompactionHistorySection } from "./CompactionHistorySection.js";
import { MemoryPrivacySection } from "./MemoryPrivacySection.js";

export function MemoryPanel(): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);

  return (
    // Sections are ledger groups (SECTION in MemoryPanelShared): a head, a
    // lead, hairline rows, 24 between groups (`styles/global-css/memory.css`).
    <div data-vex-screen="memory" className="vex-mem">
      <LongMemorySection />
      {/* S10 inspector trio — read-only manager pipeline views. */}
      <CandidatesSection />
      <DecisionsSection />
      <JobsSection />
      <MemorySection sessionId={activeSessionId} />
      <CompactionHistorySection sessionId={activeSessionId} />
      <MemoryPrivacySection />
    </div>
  );
}
