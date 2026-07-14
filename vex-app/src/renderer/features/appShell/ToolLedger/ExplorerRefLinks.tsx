/**
 * Explorer deep-link row for a tool-result act (Stage 2). Renders one compact
 * labelled `tx ↗` link per validated `{ chain, txRef }` ref that resolves
 * through the shared `explorerTxUrl` builder. A ref whose chain is unknown to
 * the builder resolves to `null` and is silently dropped; when nothing
 * resolves the component renders nothing (inert). With multiple resolvable
 * refs the labels disambiguate (`tx 1 ↗`, `tx 2 ↗`).
 *
 * The link is passive: `target="_blank"` never opens a child window — main's
 * `setWindowOpenHandler` denies the popup and routes allow-listed explorer
 * hosts through `shell.openExternal`. Same tone as the Stage-1 `View account`
 * link in `MovesBlock`. Tool args/output remain inert text elsewhere; only
 * these main-validated refs become interactive.
 */

import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { explorerTxUrl } from "@shared/explorer-links.js";
import type { ExplorerRef } from "@shared/schemas/messages.js";

interface ResolvedRef {
  readonly url: string;
  readonly label: string;
  readonly ariaLabel: string;
}

/** Keep resolvable refs only, labelling `tx ↗` (single) or `tx N ↗` (many). */
function resolveRefs(
  refs: readonly ExplorerRef[] | null | undefined,
): ResolvedRef[] {
  if (refs === null || refs === undefined || refs.length === 0) return [];
  const resolved: { url: string; chain: string }[] = [];
  for (const ref of refs) {
    const url = explorerTxUrl(ref.chain, ref.txRef);
    if (url !== null) resolved.push({ url, chain: ref.chain });
  }
  const many = resolved.length > 1;
  return resolved.map((r, index) => ({
    url: r.url,
    label: many ? `tx ${index + 1}` : "tx",
    // Distinct per-link label (index + chain) so multiple links are
    // distinguishable to assistive tech, not one repeated generic name.
    ariaLabel: `Open transaction ${index + 1} on ${r.chain} explorer`,
  }));
}

export function ExplorerRefLinks({
  refs,
}: {
  readonly refs: readonly ExplorerRef[] | null | undefined;
}): JSX.Element | null {
  const resolved = resolveRefs(refs);
  if (resolved.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {resolved.map((ref, index) => (
        <a
          // Index-suffixed: the same URL could appear twice (JSONB dupes pass
          // zod), and duplicate keys break React reconciliation.
          key={`${index}-${ref.url}`}
          href={ref.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={ref.ariaLabel}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {ref.label}
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} aria-hidden />
        </a>
      ))}
    </div>
  );
}
