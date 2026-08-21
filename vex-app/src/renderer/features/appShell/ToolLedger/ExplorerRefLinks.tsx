/**
 * Explorer deep-link row for a tool-result act (Stage 2). Renders one compact
 * labelled `tx ↗` link per validated `{ chain, txRef }` ref that resolves
 * through the shared `explorerTxUrl` builder. A ref whose chain is unknown to
 * the builder resolves to `null` and is silently dropped; when nothing
 * resolves the component renders nothing (inert). With multiple resolvable
 * refs the labels disambiguate (`tx 1 ↗`, `tx 2 ↗`). The row renders on its own
 * line and shows at most `VISIBLE_REF_CAP` chips, the rest behind a `+N more`
 * toggle that expands in place - display-only, every link keeps its distinct
 * `aria-label` whether it is currently visible or not.
 *
 * The link is passive: `target="_blank"` never opens a child window — main's
 * `setWindowOpenHandler` denies the popup and routes allow-listed explorer
 * hosts through `shell.openExternal`. Same tone as the Stage-1 `View account`
 * link in `MovesBlock`. Tool args/output remain inert text elsewhere; only
 * these main-validated refs become interactive.
 */

import { useState, type JSX } from "react";
import {
  IconArrowUpRight,
} from "../../../components/icons/index.js";
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

/**
 * How many chips a collapsed row shows. A batch tool can deposit a ref per
 * transaction, and seven chips wrapping out of a header is exactly the
 * "unformatted strip" the owner reported. DISPLAY-ONLY, in the spirit of
 * `lib/head-tail-cap.ts`: nothing is dropped, the rest is one click away, and
 * no agent-visible context is touched.
 */
const VISIBLE_REF_CAP = 3;

export function ExplorerRefLinks({
  refs,
}: {
  readonly refs: readonly ExplorerRef[] | null | undefined;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const resolved = resolveRefs(refs);
  if (resolved.length === 0) return null;
  const overflow = resolved.length - VISIBLE_REF_CAP;
  const visible = expanded ? resolved : resolved.slice(0, VISIBLE_REF_CAP);
  return (
    // Own line, never a wrapping sibling of a header row: as a flex-wrap
    // neighbour of the act header the chip block crushed the title and folded
    // onto its own line anyway, detached from its owner.
    <div
      data-vex-explorer-refs=""
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      {visible.map((ref, index) => (
        <a
          // Index-suffixed: the same URL could appear twice (JSONB dupes pass
          // zod), and duplicate keys break React reconciliation.
          key={`${index}-${ref.url}`}
          href={ref.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={ref.ariaLabel}
          // 10px is the repo's mono floor (the act header's own microtype); the
          // old 9px with 0.14em tracking on uppercase digits is what read as
          // unformatted. Tracking comes down with it - letter-spacing isolates
          // already-sparse glyphs rather than helping them.
          className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {ref.label}
          <IconArrowUpRight size={11} />
        </a>
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex shrink-0 items-center rounded-[3px] font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {expanded ? "less" : `+${overflow} more`}
        </button>
      ) : null}
    </div>
  );
}
