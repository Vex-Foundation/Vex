/**
 * Memory & privacy section of the Memory panel (7-4).
 *
 * Read-only transparency for the remote compaction path. Names the model that
 * builds memory (the SAME global `AGENT_MODEL` the agent uses, via
 * `useAvailableModels`) and states plainly what is redacted before a transcript
 * leaves the machine. This is deliberately a disclosure, not a toggle: Track-2
 * compaction is enabled-by-default (product sign-off) and the redaction
 * guarantee is owned upstream (engine redaction + the support-bundle scrub
 * proven by `bug-report-service.test.ts`) — nothing here re-implements it.
 */

import type { JSX } from "react";
import { defaultModelOption, useAvailableModels } from "../../lib/api/models.js";
import { SECTION, SectionHead } from "./MemoryPanelShared.js";

export function MemoryPrivacySection(): JSX.Element {
  const models = useAvailableModels();
  // The configured default, never a session's own pick (F06): background
  // work, memory included, always runs on `AGENT_MODEL`.
  const model = defaultModelOption(models.data);

  return (
    <section data-vex-section="memory-privacy" className={SECTION}>
      <SectionHead
        title="Memory & privacy"
        lead="How Vex builds long-term memory, and what leaves your machine."
      />

      <p data-vex-memory-model className="vex-mem-sec__facts">
        {models.isLoading ? (
          "Checking the configured model…"
        ) : model !== null ? (
          <>
            Memory is built by{" "}
            <span className="vex-mem-model">{model.modelId}</span> via
            OpenRouter.
          </>
        ) : (
          "The memory builder is idle until an OpenRouter model is configured."
        )}
      </p>

      <p className="vex-mem-sec__facts">
        When older messages are compacted into memory, Vex sends a{" "}
        <b>redacted</b> copy of that archived transcript to your OpenRouter
        model. Before it leaves your machine, secrets - wallet seeds, private
        keys, API keys, and JWTs - are removed, and wallet/contract addresses
        and transaction hashes are masked.
      </p>
      <p className="vex-mem-sec__facts">
        Only the sanitized summary and structured chunks are stored. Logs and
        support reports never include unredacted memory payloads: raw
        transcript text and embeddings are not attached to them.
      </p>
      <p className="vex-mem-sec__facts" data-quiet>
        This runs automatically in the background (enabled by default).
      </p>
    </section>
  );
}
