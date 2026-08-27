/**
 * THE BOARD CARD IN THE CHAT - a board, compactly, without becoming one.
 *
 * WHAT IT REPLACED AND WHY. A transcript used to carry the whole card grid
 * inline. That put a heavy market surface into a reading column, and it put
 * it there for every board in the history at once. This card is the summary
 * and the door: the model's own title, a derived subtitle, how many results,
 * three token thumbnails, whether the figures are a snapshot or live, one
 * sentence of conclusion, and a button.
 *
 * THE MODAL NEVER OPENS BY ITSELF. Nothing here calls the store on mount, on
 * arrival or on any timer. A board appearing in a conversation is a thing to
 * be told about, never a surface to be interrupted with - so the ONLY path to
 * an open modal is the reader pressing "View board".
 *
 * THE CONCLUSION IS COUNTED, NOT WRITTEN. Its words come from the shared A11
 * classifier's own tally, so the sentence here and the chips inside the modal
 * can never disagree, and no bucket is quietly dropped from the arithmetic.
 * While every pool is still pending it says so instead of showing a tally
 * that would be wrong for as long as it was visible.
 *
 * LEGACY BOARDS RENDER. A board composed before `iconId` and `analysis`
 * existed carries neither; the thumbnails fall back to monograms and the card
 * says nothing about an assessment it does not have. Nothing about this card
 * requires a field that older persisted boards lack.
 */

import { useMemo, useState, type JSX } from "react";
import { IconArrowUpRight, IconSparkle } from "../../../components/icons/index.js";
import {
  boardTokenIconDataUrl,
  useBoardTokenIcon,
} from "../../../lib/api/board-icons.js";
import { cn } from "../../../lib/utils.js";
import { useBoardSafetyVerdicts } from "./board-safety-surface.js";
import {
  countBoardSafety,
  describeBoardSafetyCounts,
  type BoardPreviewCardProps,
} from "./board-surface-contracts.js";
import { boardSubtitle, buildBoardViewModel } from "./boardModel.js";
import { isBoardLiveHeld } from "./board-live-overlay.js";

/** How many token thumbnails the card shows. The rest are counted, not drawn. */
const THUMBNAIL_COUNT = 3;

/** What the conclusion says while no pool has a settled verdict yet. */
export const BOARD_PREVIEW_PENDING_CONCLUSION = "Checking safety signals";

export interface BoardPreviewCardExtraProps {
  /**
   * Ask VEX about these results. Optional: the affordance is only offered
   * where a composer can actually receive the intent, so a surface that
   * cannot hand it on does not paint a button that would do nothing.
   */
  readonly onAsk?: (() => void) | undefined;
}

export function BoardPreviewCard({
  board,
  onOpen,
  live,
  onAsk,
}: BoardPreviewCardProps & BoardPreviewCardExtraProps): JSX.Element {
  const spec = board.spec;
  const model = useMemo(
    () => buildBoardViewModel(spec, Date.now()),
    [spec],
  );
  const verdicts = useBoardSafetyVerdicts(spec);
  const counts = useMemo(
    () => countBoardSafety(verdicts.map((verdict) => verdict.state)),
    [verdicts],
  );
  const pending = verdicts.every((verdict) => verdict.state === "pending");
  const conclusion = pending
    ? BOARD_PREVIEW_PENDING_CONCLUSION
    : describeBoardSafetyCounts(counts);

  const held = isBoardLiveHeld(live.mode);
  const total = model.cards.length;
  const thumbnails = model.cards.slice(0, THUMBNAIL_COUNT);
  const overflow = total - thumbnails.length;

  return (
    <section
      data-vex-area="board-preview-card"
      data-pools={total}
      data-live={held ? "true" : "false"}
      aria-label={`${board.title}, ${String(total)} ${total === 1 ? "result" : "results"}`}
      className="vex-board-card mt-3 flex flex-col gap-3 rounded-xl border border-line-2 bg-board-card px-4 py-3.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The MODEL's own title for this board. Nothing prints a product
            * label over it. */}
          <p
            data-vex-area="board-preview-title"
            className="truncate font-display text-[15px] font-bold leading-[20px] tracking-[-0.01em] text-ink-primary"
            title={board.title}
          >
            {board.title}
          </p>
          <p
            data-vex-area="board-preview-subtitle"
            className="truncate text-[12px] leading-[16px] text-ink-tertiary"
          >
            {boardSubtitle(model)}
          </p>
        </div>
        <ModeBadge held={held} mode={live.mode} model={model} />
      </div>

      <div className="flex items-center gap-3">
        <div
          data-vex-area="board-preview-thumbnails"
          className="flex shrink-0 items-center"
          aria-hidden
        >
          {thumbnails.map((card, index) => (
            <Thumbnail
              key={card.key}
              iconId={card.row?.iconId ?? null}
              symbol={card.row?.baseTokenSymbol ?? null}
              className={index === 0 ? undefined : "-ml-2"}
            />
          ))}
          {overflow > 0 ? (
            <span
              data-vex-area="board-preview-overflow"
              className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full border border-line-2 bg-surface-2 text-[10px] font-semibold tabular-nums text-ink-tertiary"
            >
              {`+${String(overflow)}`}
            </span>
          ) : null}
        </div>
        <p
          data-vex-area="board-preview-count"
          className="shrink-0 text-[13px] font-semibold leading-[18px] tabular-nums text-ink-primary"
        >
          {`${String(total)} ${total === 1 ? "result" : "results"}`}
        </p>
        <p
          data-vex-area="board-preview-conclusion"
          data-pending={pending ? "true" : "false"}
          className={cn(
            "min-w-0 flex-1 truncate text-[12.5px] leading-[18px]",
            pending ? "text-ink-tertiary" : "text-ink-secondary",
          )}
        >
          {conclusion ?? ""}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-vex-area="board-preview-open"
          onClick={() => {
            onOpen(board);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-button-accent px-3 py-1.5 text-[13px] font-semibold text-ink-on-button-accent transition-colors duration-150 hover:bg-button-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          View board
          <IconArrowUpRight size={14} />
        </button>
        {onAsk === undefined ? null : (
          <button
            type="button"
            data-vex-area="board-preview-ask"
            onClick={onAsk}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-2 px-3 py-1.5 text-[13px] font-medium text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <IconSparkle size={14} />
            Ask VEX about results
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Snapshot or LIVE, in words plus one dot.
 *
 * The dot follows `live-connected` - a landed tick - rather than the toggle,
 * so a reader is never shown a green LIVE beside figures that have not
 * arrived. A snapshot names its clock, because a board's figures are a
 * financial reading whose age changes what they mean.
 */
function ModeBadge({
  held,
  mode,
  model,
}: {
  readonly held: boolean;
  readonly mode: BoardPreviewCardProps["live"]["mode"];
  readonly model: ReturnType<typeof buildBoardViewModel>;
}): JSX.Element {
  if (!held) {
    return (
      <span
        data-vex-area="board-preview-mode"
        data-mode="snapshot"
        className="shrink-0 whitespace-nowrap text-[12px] leading-[16px] text-ink-tertiary"
      >
        {`Snapshot · ${clockOf(model)}`}
      </span>
    );
  }
  const connected = mode === "live-connected";
  return (
    <span
      data-vex-area="board-preview-mode"
      data-mode={connected ? "live" : "connecting"}
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-semibold leading-[16px]",
        connected ? "text-success" : "text-ink-tertiary",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[6px] w-[6px] rounded-full",
          connected ? "bg-success motion-safe:animate-pulse" : "bg-ink-dimmed",
        )}
      />
      {connected ? "LIVE" : "Connecting"}
    </span>
  );
}

function clockOf(model: ReturnType<typeof buildBoardViewModel>): string {
  const parts = boardSubtitle(model).split(" · ");
  return parts[parts.length - 1] ?? "";
}

/**
 * One token thumbnail. Same two-state contract as the card's 64px photo, at a
 * size where the monogram is the common case rather than a fallback.
 */
function Thumbnail({
  iconId,
  symbol,
  className,
}: {
  readonly iconId: string | null;
  readonly symbol: string | null;
  readonly className?: string | undefined;
}): JSX.Element {
  const query = useBoardTokenIcon(iconId);
  const dataUrl = boardTokenIconDataUrl(query);
  const [undecodableUrl, setUndecodableUrl] = useState<string | null>(null);
  const shell =
    "h-7 w-7 shrink-0 rounded-full border border-line-2 bg-surface-2 ring-2 ring-board-card";

  if (dataUrl !== null && dataUrl !== undecodableUrl) {
    return (
      <img
        data-vex-area="board-preview-thumbnail"
        data-state="image"
        src={dataUrl}
        alt=""
        onError={() => {
          setUndecodableUrl(dataUrl);
        }}
        className={cn(shell, "object-cover", className)}
      />
    );
  }
  return (
    <span
      data-vex-area="board-preview-thumbnail"
      data-state="monogram"
      className={cn(
        shell,
        "flex items-center justify-center font-display text-[10px] font-bold leading-none text-ink-secondary",
        className,
      )}
    >
      {monogram(symbol)}
    </span>
  );
}

function monogram(symbol: string | null): string {
  if (symbol === null) return "?";
  const characters = Array.from(symbol.replace(/^\$/, "").trim());
  if (characters.length === 0) return "?";
  return characters.slice(0, 2).join("").toUpperCase();
}
