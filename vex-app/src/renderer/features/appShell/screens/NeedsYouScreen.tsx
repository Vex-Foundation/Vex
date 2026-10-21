/**
 * NeedsYouScreen: the `needsYou` page in the centre column, both sidebars
 * standing (docs/design/R3-MINIMAL.md section 8.5). Every decision that waits
 * for the user, grouped by where it was raised (a session, a Studio project,
 * a background approval): a group head with its Open key, the open decision as
 * the full approval card, the others folded to rows with Reject and
 * "Review {action}", and the missions that wait as rows with their own key.
 *
 * The same items the title bar's "Needs you · N" and the Vex sidebar list
 * (`useNeedsYou`), in the same order, so the three can never count apart. The
 * page never decides anything itself: each card is the inline card, with
 * REAL FUNDS, Reject's first focus and the two-step confirm for a high-risk
 * action. A Review key elsewhere opens this page on its decision
 * (`approvalId`); otherwise the first decision is the open one, and when it
 * is decided the next one opens.
 *
 * Freshness: while the page is open the inbox polls on the faster review net
 * (the query refetches on the shortest interval any observer asks for); the
 * push from `approval_enqueued` stays the first source.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useUiStore, type ShellScreenOrigin } from "../../../stores/uiStore.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { usePendingApprovalsAll } from "../../../lib/api/approvals.js";
import {
  NEEDS_YOU_EMPTY_COPY,
  NEEDS_YOU_UNKNOWN_COPY,
  needsYouMetaText,
  type NeedsYouItem,
} from "../../vex/needs-you.js";
import { useNeedsYou } from "../../vex/useVexPresence.js";
import { VEX_STATE_FILL } from "../../vex/vex-state.js";
import { pendingRowsOf, REVIEW_OPEN_POLL_MS } from "../GlobalApprovals.js";
import {
  GlobalApprovalItem,
  NeedsYouGroupHead,
  useNeedsYouNavigation,
} from "../GlobalApprovals/GlobalApprovalItem.js";
import { ShellScreen } from "./ShellScreen.js";

export const NEEDS_YOU_LEAD =
  "Review the details before approving an action. Nothing signs until you confirm.";

interface NeedsYouGroup {
  readonly key: string;
  readonly items: readonly NeedsYouItem[];
}

/** The items in groups, in the order each group first appears. */
function groupItems(items: readonly NeedsYouItem[]): readonly NeedsYouGroup[] {
  const groups = new Map<string, NeedsYouItem[]>();
  for (const item of items) {
    const group = groups.get(item.groupKey);
    if (group === undefined) groups.set(item.groupKey, [item]);
    else group.push(item);
  }
  return [...groups.entries()].map(([key, members]) => ({ key, items: members }));
}

/** Focus the open card's Reject, the safer choice, once it has painted. */
function focusCardReject(approvalId: string): void {
  requestAnimationFrame(() => {
    const cards = document.querySelectorAll<HTMLElement>(
      "[data-vex-area='needs-you-page'] [data-approval-id]",
    );
    for (const card of cards) {
      if (card.getAttribute("data-approval-id") !== approvalId) continue;
      card.querySelector<HTMLElement>("[autofocus]:not([disabled])")?.focus();
      if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });
      return;
    }
  });
}

/** A mission that waits for a decision, as a row with its own key. */
function MissionRow({
  item,
  onOpen,
}: {
  readonly item: NeedsYouItem;
  readonly onOpen: () => void;
}): JSX.Element {
  return (
    <div className="vex-appr-row-frame" data-vex-needs-you-item={item.kind}>
      <div className="vex-appr-row">
        <span aria-hidden className="vex-appr-row__pin">
          <Swatch
            state={item.kind === "recover" ? VEX_STATE_FILL.error : item.kind === "withdrawal" ? VEX_STATE_FILL.concerned : VEX_STATE_FILL.awaiting}
            size={10}
          />
        </span>
        <h3 className="vex-appr-row__title">{item.title}</h3>
        <span className="vex-appr-row__go">
          <button
            type="button"
            onClick={onOpen}
            aria-label={`${item.go}: ${item.title}`}
            className="inline-flex h-8 shrink-0 items-center justify-center border border-rule bg-transparent px-3 font-sans text-[13px] font-medium leading-none text-ink-primary transition-colors hover:bg-interactive-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus"
          >
            {item.go}
          </button>
        </span>
        <p className="vex-appr-row__meta">{needsYouMetaText(item)}</p>
      </div>
    </div>
  );
}

export function NeedsYouScreen({
  origin,
  approvalId = null,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  /** The decision a Review key asked to open; `null` opens the first. */
  readonly approvalId?: string | null;
  readonly onClose: () => void;
}): JSX.Element {
  const model = useNeedsYou();
  const query = usePendingApprovalsAll({ refetchInterval: REVIEW_OPEN_POLL_MS });
  const rows = useMemo(() => pendingRowsOf(query.data) ?? [], [query.data]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const { openSession } = useNeedsYouNavigation();

  // The decision the user asked for, kept across reads; a new Review while the
  // page is open replaces it.
  const [chosen, setChosen] = useState<string | null>(approvalId);
  useEffect(() => {
    if (approvalId !== null) setChosen(approvalId);
  }, [approvalId]);

  const approvalIds = useMemo(
    () =>
      model.items
        .map((item) => item.approvalId)
        .filter((id): id is string => id !== null && rowsById.has(id)),
    [model.items, rowsById],
  );
  const openId = chosen !== null && approvalIds.includes(chosen) ? chosen : approvalIds[0] ?? null;

  // The card open at first paint takes the first focus through the card's own
  // mount rule; every later change of the open card (a Review, the next one
  // after a decision) moves the focus to its Reject.
  const firstOpenId = useRef(openId);
  const lastOpenId = useRef(openId);
  useEffect(() => {
    if (openId === lastOpenId.current) return;
    lastOpenId.current = openId;
    if (openId !== null) focusCardReject(openId);
  }, [openId]);

  const groups = useMemo(() => groupItems(model.items), [model.items]);

  return (
    <ShellScreen title="Needs you" chapter={null} origin={origin} onClose={onClose}>
      <div className="vex-needs-page" data-vex-area="needs-you-page" data-state={model.status}>
        <p className="vex-needs-page__lead">{NEEDS_YOU_LEAD}</p>

        {model.status === "loading" ? (
          <EmptyBlock scope="Needs you" title="Checking for pending approvals" loading className="mt-6" />
        ) : null}
        {model.status === "unknown" ? (
          <EmptyBlock
            scope="Needs you"
            state="error"
            title={NEEDS_YOU_UNKNOWN_COPY}
            // While the read runs again there is no key to press twice; the
            // block says so instead.
            detail={model.retrying ? "Checking again" : undefined}
            action={model.retrying ? undefined : { label: "Retry", onClick: model.retry }}
            className="mt-6"
          />
        ) : null}
        {model.status === "ready" && model.items.length === 0 ? (
          <EmptyBlock scope="Needs you" title={NEEDS_YOU_EMPTY_COPY} className="mt-6" />
        ) : null}

        {groups.map((group) => (
          <section key={group.key} aria-label={group.items[0]?.where ?? "Needs you"}>
            {group.items.map((item, index) => {
              const row = item.approvalId === null ? undefined : rowsById.get(item.approvalId);
              if (row !== undefined) {
                const id = row.id;
                return (
                  <GlobalApprovalItem
                    key={item.key}
                    row={row}
                    head={index === 0}
                    expanded={id === openId}
                    focusOnMount={id === firstOpenId.current}
                    onReview={() => setChosen(id)}
                    // The Open keys close the page themselves (their route write).
                    onOpenSession={() => undefined}
                  />
                );
              }
              const sessionId = item.sessionId;
              return (
                <div key={item.key}>
                  {index === 0 ? (
                    <NeedsYouGroupHead
                      where={item.where}
                      projectId={null}
                      projectName={null}
                      context={null}
                      open={
                        sessionId === null
                          ? null
                          : { label: "Open session", onOpen: () => openSession(sessionId) }
                      }
                    />
                  ) : null}
                  {item.kind === "approval" ? null : (
                    <MissionRow
                      item={item}
                      onOpen={() => {
                        if (item.kind === "withdrawal") {
                          useUiStore.getState().setShellRoute({ kind: "vexCloudFunding", origin: null });
                          return;
                        }
                        if (sessionId !== null) openSession(sessionId);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </ShellScreen>
  );
}
