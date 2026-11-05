/**
 * THE CHATS PANEL (docs/design/H3-DESKTOP.md section 4.12): under 1280 the
 * chats column is the 76 rail at every moment, and the rail's key slides
 * this 248 panel out of the rail's right edge instead of widening the track.
 * VEX Cloud's own answer (`h3-shell-gaps`, decision 3: "under 1280 the rail
 * opens a chats panel, not the column").
 *
 * THE MONEY RULE (section 3.6). The panel is a box laid over Vex's column,
 * never a grid track: the frame's tracks are the same open or closed, so a
 * waiting card in the chat never moves while it opens or closes (the card
 * proof reads it at 1024, 1180 and 1279). It lies above her section, and a
 * scrim lies over the rest of her column beside it; under 1024, and on a
 * page whose Vex column has folded to its strip, there is no column to lie
 * over, so the scrim runs to the window's edge and the chat behind it rests
 * (`covers`, the frame makes it inert) until the panel closes.
 *
 *   section.vex-chats-panel[data-vex-area="chats-panel"]
 *     the CHATS head, 56
 *     Search chats, the field, 48
 *     the chats by day, the open column's rows
 *   div.vex-chats-scrim        over the rest of her column; a press on it
 *                              is a press outside, which closes the panel
 *
 * Esc (focus in the panel or on its key), a press anywhere outside the panel
 * and its keys, and a row's press close it. Nothing here writes the stored
 * fold: the panel is the visit's own, and it closes when the window grows
 * past 1279.
 *
 * MOTION, Cloud's numbers (`lib/motion`, "THE CHATS PANEL"): the panel
 * slides in from translate3d(-100%) over 720ms and back over 420ms, on the
 * push curve; the scrim fades over 600ms in and 300ms out; its first rows
 * enter from 16px left over 620ms, row n after 120 + 45n ms. Transform and
 * opacity only, so nothing in the layout moves. Reduced motion and Save-Data
 * land it at once.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { isDialogOnScreen } from "../../components/ui/dialog.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import {
  CHATS_ROW_DELAY_MS,
  CHATS_ROW_ENTER_MAX,
  CHATS_ROW_STAGGER_MS,
  DURATION_CHATS_ROW_MS,
  DURATION_CHATS_SCRIM_CLOSE_MS,
  DURATION_CHATS_SCRIM_OPEN_MS,
  DURATION_VEX_CLOSE_MS,
  DURATION_VEX_OPEN_MS,
  EASE_PUSH,
  cssCurve,
} from "../../lib/motion/index.js";
import { prefersStillFrame } from "../../lib/motion/use-still-frame.js";
import { useUiStore } from "../../stores/uiStore.js";
import { SessionDeleteDialog } from "./SessionDeleteDialog.js";
import {
  SessionsEmptyPlaceholder,
  SessionsErrorPlaceholder,
  SessionsLoadingPlaceholder,
  SidebarSessionGroups,
} from "./SessionRows.js";
import { SessionSearchField } from "./SessionRows/SessionSearch.js";
import { filterSessionsByTitle, filterSessionsByWorkspace, groupSessions } from "./sessionListModel.js";
import { useSessionRowActions } from "./useSessionRowActions.js";

/** The panel's id, for its keys' `aria-controls`. */
export const CHATS_PANEL_ID = "chats-panel";

/**
 * The attribute the rail's keys carry that open or close the panel: a press
 * on one of them is the key's own, never a press outside that closes it.
 */
export const CHATS_PANEL_KEY_ATTR = "data-chats-panel-key";

/** Where focus lands when the panel opens: its first chat, or its search field. */
export type ChatsPanelFocus = "list" | "search";

export interface ChatsPanelProps {
  readonly open: boolean;
  /** Where the press that opened it sends focus. */
  readonly focus: ChatsPanelFocus;
  /**
   * It lies over what is read: under 1024, or a page with Vex's column
   * folded to its strip. The scrim then runs to the window's edge.
   */
  readonly covers: boolean;
  readonly onClose: () => void;
}

/** The rows that enter as it opens, in the order they stand. */
const ENTER_SELECTOR = ".vex-chats-panel__head, .vex-ls-search, .vex-ls-group, .vex-ls-row";

/** The rail's key that toggles the panel, where focus returns when it closes. */
function panelKey(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${CHATS_PANEL_KEY_ATTR}="toggle"]`);
}

export function ChatsPanel({ open, focus, covers, onClose }: ChatsPanelProps): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const query = useSessionsList();
  const {
    pendingPinId,
    removeTarget,
    removeBlocked,
    removePending,
    handleTogglePin,
    handleRename,
    handleRequestRemove,
    handleCancelRemove,
    handleConfirmRemove,
  } = useSessionRowActions();
  const [searchText, setSearchText] = useState("");

  const rows = useMemo(() => {
    if (!query.data?.ok) return [];
    return filterSessionsByTitle(filterSessionsByWorkspace(query.data.data, null), searchText);
  }, [query.data, searchText]);
  const groups = useMemo(() => groupSessions(rows), [rows]);

  const handleSelect = useCallback(
    (id: string): void => {
      setActiveSessionId(id);
      // A chat opens in the centre: a page standing there closes, as a row
      // in the column closes it.
      setShellRoute({ kind: "none" });
      onClose();
    },
    [setActiveSessionId, setShellRoute, onClose],
  );

  // Esc in the field clears a typed query first, then closes the panel.
  const onFieldClose = useCallback((): void => {
    if (searchText !== "") setSearchText("");
    else onClose();
  }, [searchText, onClose]);

  const panelRef = useRef<HTMLElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // THE MOTION (see the header note). `closing` keeps the panel and its scrim
  // drawn while the close plays, so it slides away rather than vanishing.
  const [closing, setClosing] = useState(false);
  const shown = useRef(open);
  useLayoutEffect(() => {
    if (shown.current === open) return undefined;
    shown.current = open;
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    if (panel === null || scrim === null) return undefined;
    // Focus: the press that opened it says where; a close hands focus that
    // was inside back to the rail's key.
    if (open) {
      const target = focus === "search"
        ? searchRef.current
        : panel.querySelector<HTMLElement>(".vex-ls-row__select");
      target?.focus({ preventScroll: true });
    } else if (panel.contains(document.activeElement)) {
      panelKey()?.focus({ preventScroll: true });
    }
    const animated = typeof panel.animate === "function";
    if (animated) {
      for (const node of [panel, scrim, ...panel.querySelectorAll<HTMLElement>(ENTER_SELECTOR)]) {
        for (const animation of node.getAnimations()) animation.cancel();
      }
    }
    if (!animated || prefersStillFrame()) {
      setClosing(false);
      return undefined;
    }
    const push = cssCurve(EASE_PUSH);
    const direction = open ? "normal" : "reverse";
    const slide = panel.animate(
      [{ transform: "translate3d(-100%, 0, 0)" }, { transform: "none" }],
      { duration: open ? DURATION_VEX_OPEN_MS : DURATION_VEX_CLOSE_MS, easing: push, direction, fill: open ? "backwards" : "both" },
    );
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: open ? DURATION_CHATS_SCRIM_OPEN_MS : DURATION_CHATS_SCRIM_CLOSE_MS,
      easing: push,
      direction,
      fill: open ? "backwards" : "both",
    });
    if (open) {
      setClosing(false);
      const enter = Array.from(panel.querySelectorAll<HTMLElement>(ENTER_SELECTOR)).slice(0, CHATS_ROW_ENTER_MAX);
      enter.forEach((node, index) => {
        node.animate(
          [{ opacity: 0, transform: "translate3d(-16px, 0, 0)" }, { opacity: 1, transform: "none" }],
          {
            duration: DURATION_CHATS_ROW_MS,
            delay: CHATS_ROW_DELAY_MS + index * CHATS_ROW_STAGGER_MS,
            easing: push,
            fill: "backwards",
          },
        );
      });
      return undefined;
    }
    setClosing(true);
    let live = true;
    void slide.finished
      .then(() => {
        if (live) setClosing(false);
      })
      .catch(() => {
        // Cancelled by the next press, which owns the panel from here.
      });
    return () => {
      live = false;
    };
  }, [open, focus]);

  // Esc with focus in the panel or on its key, and a press outside it, close
  // it. A press inside a dialog (a row's Remove confirmation) is not outside.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      const inside = panelRef.current?.contains(active) === true
        || (active instanceof Element && active.closest(`[${CHATS_PANEL_KEY_ATTR}]`) !== null);
      if (!inside || isDialogOnScreen(document)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target) === true) return;
      if (target.closest(`[${CHATS_PANEL_KEY_ATTR}]`) !== null) return;
      if (isDialogOnScreen(document)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose]);

  const drawn = open || closing;
  const listBody = query.isLoading ? (
    <SessionsLoadingPlaceholder sidebarOpen />
  ) : query.data && query.data.ok === false ? (
    <SessionsErrorPlaceholder sidebarOpen message={query.data.error.message} />
  ) : query.isError ? (
    <SessionsErrorPlaceholder sidebarOpen message="Vex could not read your sessions." />
  ) : query.data && query.data.ok ? (
    rows.length === 0 ? (
      <SessionsEmptyPlaceholder sidebarOpen />
    ) : (
      <SidebarSessionGroups
        groups={groups}
        activeSessionId={activeSessionId}
        onSelect={handleSelect}
        onTogglePin={handleTogglePin}
        onRequestRemove={handleRequestRemove}
        onRename={handleRename}
        pendingPinId={pendingPinId}
        highlight={searchText}
      />
    )
  ) : null;

  return (
    <>
      {/* The scrim takes no focus and says nothing: a press on it is a press
        * outside the panel, which closes it (above). */}
      <div
        ref={scrimRef}
        aria-hidden="true"
        className="vex-chats-scrim"
        data-vex-area="chats-scrim"
        data-open={drawn || undefined}
        data-closing={closing || undefined}
        data-covers={covers || undefined}
      />
      <section
        ref={panelRef}
        id={CHATS_PANEL_ID}
        aria-label="Chats"
        inert={!open}
        className="vex-ls vex-chats-panel"
        data-vex-area="chats-panel"
        data-open={drawn || undefined}
        data-closing={closing || undefined}
      >
        <div className="vex-chats-panel__head">
          <h2 className="vex-chats-panel__title">Chats</h2>
        </div>
        <SessionSearchField
          value={searchText}
          onChange={setSearchText}
          onClose={onFieldClose}
          inputRef={(el) => {
            searchRef.current = el;
          }}
        />
        <div className="vex-scroll vex-ls-sessions vex-chats-panel__list min-h-0 flex-1 overflow-y-auto overflow-x-clip">
          {listBody}
        </div>
        <SessionDeleteDialog
          session={removeTarget}
          blockedOutcome={removeBlocked}
          pending={removePending}
          onCancel={handleCancelRemove}
          onConfirm={() => {
            void handleConfirmRemove();
          }}
        />
      </section>
    </>
  );
}
