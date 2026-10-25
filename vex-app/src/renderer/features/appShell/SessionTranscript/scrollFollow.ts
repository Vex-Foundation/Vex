/*! Portions © 2026 DeepSeek, MIT License. See vex-app/THIRD_PARTY_NOTICES.md.
 * Upstream: packages/client/ui-chat/src/client/chat/{use-scroll-follow.ts,use-chat-reading.ts,use-chat-viewport.ts} @ 639ed01 (ScrollFollow lines 16-126; sampling lines 7-8, 126-144, 190-206; attribution lines 136-142)
 * Ported from VEX Cloud `apps/web/src/components/chat/thread/scroll-follow.ts`. */
/**
 * THE TRANSCRIPT'S FOLLOW CONTROLLER - a pure policy over one scrollport, with
 * no DOM and no React in it, so every rule below is testable with a fake
 * scrollport and a fake timer (`__tests__/SessionTranscript/scroll-follow.test.ts`).
 * `useTranscriptScroll.ts` binds it to `[data-vex-conversation-scroll]`.
 *
 * It is in one of three modes: `anchor` (the newest user turn held at the
 * top), `tail` (the floor followed) or `free` (the reader's own place).
 *
 * - Near the bottom: `floor - top <= 25` (`FOLLOW_THRESHOLD + 1`), where
 *   `floor = scrollHeight - clientHeight`.
 * - Send or steer (`anchor`): clear the pending sample, size the tail space
 *   so the floor reaches the newest turn's anchor top (`reserve`,
 *   `tailSpace`), write `scrollTop = anchorTop` once (instant, never smooth).
 *   Without a turn anchor it lands at the floor instead.
 * - Anchored growth never writes `scrollTop`: the reply grows under the
 *   anchored turn and the tail space shrinks by what it fills. The one write
 *   left restores the anchor when a browser clamp moved it (the seat or an
 *   approval card shrank) or when content above it moved it, after the same
 *   pre-write check as tail following.
 * - The tail space follows the newest anchor in every mode, so the last turn
 *   keeps the view's height below its top; an initial landing removes it (a
 *   stored session needs none).
 * - Exact floor: `top >= floor - 0.5` resumes following at once, also when the
 *   browser clamped `top` to a lower floor (no counted movement): on the
 *   scroll event, or on growth when no sample is pending. A floor no lower
 *   than the anchor (a short newest turn, held by the tail space) anchors
 *   again instead: there is no tail to follow.
 * - Reader movement: an observed `top` that differs from
 *   `min(acknowledged, floor)` by more than 0.5px - the observed-top LEDGER.
 *   Every programmatic write acknowledges the landed `top`, so a browser
 *   shrink-clamp (which lands on the floor minimum) is never read as the
 *   reader. Movement and any reader-intent event set `pending` and start one
 *   500ms sample; the decision is taken when the sample elapses or
 *   `scrollend` fires, whichever comes first.
 * - Growth while following the tail and not pending writes `scrollTop =
 *   floor` (instant), after a pre-write check: if the current `top` shows
 *   reader movement, it sets `pending` and writes nothing. While a sample is
 *   pending, growth never writes.
 * - The sample settles: counted movement that ends away from the floor is
 *   `free`; near the floor it follows the tail (from `anchor` only when the
 *   reader moved down); no movement keeps the mode and catches up (one jump
 *   to the floor, or the anchor held).
 * - Jump to latest (`repin`) and initial landing (`land`): clear the pending
 *   sample, jump to the floor, follow the tail.
 * - `behind` (the jump pill): `free`, or `anchor` with more than 25px of
 *   content below the view.
 *
 * Changes from Cloud: `shifted` (a load-older prepend moved the view by a
 * page; the ledger and the anchor move with it, so a reader gesture still in
 * its sample keeps counting as movement) and `restore` (a per-session saved
 * reader position lands instead of the floor). Desktop pages history and
 * persists positions, Cloud does neither. `ANCHOR_AIR_PX` is the session
 * content's own top padding here, 18px, the page's beat.
 *
 * Changes from DSH (carried from Cloud): one class instead of `ScrollFollow` +
 * `ChatReading` + `ChatViewport`; no smooth motion target, no turn
 * navigation; a reader-intent event starts the sample on its own; the
 * scrollport and the timer are injected. A send anchors the newest turn at the
 * top instead of re-pinning to the floor (DSH `followTail`), because on a long
 * answer tail following showed only the end and pushed a chart out of view;
 * tail following is kept for the reader who goes to the floor, the jump pill
 * and a stored session.
 */

/** DSH `use-chat-reading.ts:7`; the test is `<= FOLLOW_THRESHOLD + 1`. */
export const FOLLOW_THRESHOLD = 24;
/** Accepted distance from the floor, inclusive (px). */
export const NEAR_BOTTOM_PX = FOLLOW_THRESHOLD + 1;
/** DSH `use-chat-reading.ts:8`. */
export const SCROLL_SAMPLE_INTERVAL_MS = 500;
/** Sub-pixel noise that never counts as movement (px). */
export const MOVEMENT_EPSILON_PX = 0.5;
/**
 * Air above an anchored turn (px): the session content's own top padding
 * (`pt-[18px]` in `SessionPanel`), so the newest turn sits where a fresh
 * session's first row sits.
 */
export const ANCHOR_AIR_PX = 18;

/** Scroll position and maximum top from one geometry read. */
export interface ScrollMetrics {
  readonly top: number;
  readonly floor: number;
}

/** One read of a scrolling element, without measuring its children. */
export function scrollMetrics(element: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): ScrollMetrics {
  return {
    top: element.scrollTop,
    floor: Math.max(0, element.scrollHeight - element.clientHeight),
  };
}

/** Within the follow threshold of the floor (inclusive). */
export function nearBottom(metrics: ScrollMetrics): boolean {
  return metrics.floor - metrics.top <= NEAR_BOTTOM_PX;
}

/** At the floor, up to sub-pixel rounding. */
export function atFloor(metrics: ScrollMetrics): boolean {
  return metrics.top >= metrics.floor - MOVEMENT_EPSILON_PX;
}

/**
 * The tail space (px) that lets the floor reach `anchorTop`: what the view
 * (`viewport`, the scrollport's client height) lacks between the anchor and
 * `contentEnd`, the natural bottom of the scroll content (everything but the
 * space itself and any flex fill). Whole pixels, up; none for an anchor at the
 * transcript's top.
 */
export function tailSpace(
  anchorTop: number,
  viewport: number,
  contentEnd: number,
): number {
  // The transcript's own top needs no room: every floor reaches it.
  if (anchorTop <= 0) return 0;
  return Math.max(0, Math.ceil(anchorTop + viewport - contentEnd));
}

/** The scrollport the controller owns. */
export interface FollowPort {
  read(): ScrollMetrics;
  /** Sets `scrollTop` instantly. */
  write(top: number): void;
  /**
   * The `scrollTop` that puts the newest turn anchor at the top of the view
   * (its top minus `ANCHOR_AIR_PX`), or null without one.
   */
  anchorTop?(): number | null;
  /** Sizes the tail space for an anchor top (`tailSpace`); null removes it. */
  reserve?(anchorTop: number | null): void;
}

/** The sample timer (the browser's `setTimeout` by default). */
export interface FollowTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const browserTimer: FollowTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** `anchor`: the newest turn held at the top; `tail`: the floor followed; `free`: the reader's place. */
export type FollowMode = "anchor" | "tail" | "free";

/** What the view shows of the controller. */
export interface FollowState {
  readonly mode: FollowMode;
  /** Content waits below the view: the jump pill shows. */
  readonly behind: boolean;
}

export interface ScrollFollowOptions {
  readonly timer?: FollowTimer;
  /** Called when the mode or `behind` changes. */
  readonly onChange?: (state: FollowState) => void;
}

export class ScrollFollow {
  private current: FollowMode = "tail";
  private lagging = false;
  /** The newest turn's anchor top, or null (no anchor since the landing). */
  private anchorAt: number | null = null;
  private acknowledged: number | null = null;
  private sampling = false;
  private sampleHandle: unknown = null;
  private readonly timer: FollowTimer;
  private onChange: (state: FollowState) => void;

  constructor(
    private readonly port: FollowPort,
    options: ScrollFollowOptions = {},
  ) {
    this.timer = options.timer ?? browserTimer;
    this.onChange = options.onChange ?? (() => {});
  }

  get mode(): FollowMode {
    return this.current;
  }

  /** Whether content growth follows the floor. */
  get following(): boolean {
    return this.current === "tail";
  }

  /** Whether content waits below the view (the jump pill shows). */
  get behind(): boolean {
    return this.lagging;
  }

  get state(): FollowState {
    return { mode: this.current, behind: this.lagging };
  }

  /** Whether reader input still awaits its sample. */
  get pending(): boolean {
    return this.sampling;
  }

  /** Jump to latest: to the floor, following it; clears any pending sample. */
  repin(): void {
    this.cancel();
    this.reserveTail();
    this.jump();
  }

  /** Initial landing (a stored session): no anchor, no tail space, the floor. */
  land(): void {
    this.cancel();
    this.anchorAt = null;
    this.port.reserve?.(null);
    this.jump();
  }

  /**
   * Initial landing on a saved reader position (Desktop): no anchor, no tail
   * space, `top` written once. The reader's place unless that lands near the
   * floor, which follows the tail as a landing does.
   */
  restore(top: number): void {
    this.cancel();
    this.anchorAt = null;
    this.port.reserve?.(null);
    const before = this.port.read();
    if (Math.abs(before.top - top) > MOVEMENT_EPSILON_PX) this.port.write(top);
    const landed = this.port.read();
    if (nearBottom(landed)) {
      this.jump();
      return;
    }
    this.acknowledged = landed.top;
    this.set("free", landed);
  }

  /** Send or steer: the newest turn at the top; clears any pending sample. */
  anchor(): void {
    this.cancel();
    const target = this.port.anchorTop?.() ?? null;
    this.anchorAt = target;
    this.port.reserve?.(target);
    if (target === null) {
      this.jump();
      return;
    }
    this.hold();
  }

  /**
   * Content above the view moved by `delta` and the view was moved with it (a
   * load-older prepend restored its paging row; Desktop). The ledger moves by
   * the same amount, so a reader gesture still in its sample keeps counting
   * as movement, and the anchor is measured again.
   */
  shifted(delta: number): void {
    if (this.acknowledged !== null) this.acknowledged += delta;
    this.reserveTail();
  }

  /** A `scroll` event on the scrollport. */
  onScroll(): void {
    const metrics = this.port.read();
    // Exact-floor arrival is checked before movement: a browser clamp to a
    // lower floor (the viewport grew) lands on `min(acknowledged, floor)` and
    // so counts as no movement, yet the free reader is at the floor now. An
    // anchored view of a short turn sits at its floor already, so only a free
    // reader resumes without movement.
    const resume = this.current === "free" && atFloor(metrics);
    if (!resume && !this.moved(metrics)) return;
    if (atFloor(metrics)) {
      // The reader reached the floor: following resumes at once.
      this.cancel();
      this.acknowledged = metrics.top;
      if (this.current !== "tail") this.arrive(metrics);
      return;
    }
    this.markPending();
  }

  /** A reader-intent event outside the composer seat. */
  onIntent(): void {
    this.markPending();
  }

  /** The browser's `scrollend`: settles a pending sample early. */
  onScrollEnd(): void {
    this.flush();
  }

  /** The transcript, the session content, the seat or the scrollport changed size. */
  onGrowth(): void {
    // Read before the tail space changes: a clamp that already happened then
    // compares against the floor it clamped to (no movement).
    const metrics = this.port.read();
    this.reserveTail();
    if (this.sampling) return;
    if (this.current === "free") {
      // A pending sample is left alone (above); a free scrollport that now
      // sits at its floor (a clamp after the viewport grew) resumes, so the
      // next growth is followed.
      if (atFloor(metrics)) {
        this.toFloor();
        this.arrive(this.port.read());
      }
      return;
    }
    if (this.moved(metrics)) {
      // Movement no scroll event reported yet: the reader owns it.
      this.markPending();
      return;
    }
    if (this.current === "tail") this.jump();
    else this.hold();
  }

  /** Cancels the sample timer and stops reporting changes. */
  dispose(): void {
    this.cancel();
    this.onChange = () => {};
  }

  private moved(metrics: ScrollMetrics): boolean {
    const base = this.acknowledged ?? metrics.top;
    return (
      Math.abs(metrics.top - Math.min(base, metrics.floor)) >
      MOVEMENT_EPSILON_PX
    );
  }

  /** Keeps the tail space on the newest anchor, measured again (it can move). */
  private reserveTail(): void {
    if (this.anchorAt === null) return;
    const target = this.port.anchorTop?.() ?? null;
    this.anchorAt = target;
    this.port.reserve?.(target);
  }

  private toFloor(): void {
    const before = this.port.read();
    if (before.top !== before.floor) this.port.write(before.floor);
    this.acknowledged = this.port.read().top;
  }

  private jump(): void {
    this.toFloor();
    this.set("tail", this.port.read());
  }

  /** Holds the newest turn at the top: writes only when it is not there. */
  private hold(): void {
    const target = this.anchorAt;
    if (target === null) {
      // The anchored row is gone: the view stays where it is.
      this.set("free", this.port.read());
      return;
    }
    const before = this.port.read();
    if (Math.abs(before.top - target) > MOVEMENT_EPSILON_PX) {
      this.port.write(target);
    }
    const landed = this.port.read();
    this.acknowledged = landed.top;
    this.set("anchor", landed);
  }

  /** At (or near) the floor: the tail, unless the floor is the anchor itself. */
  private arrive(metrics: ScrollMetrics): void {
    const short =
      this.anchorAt !== null &&
      metrics.floor <= this.anchorAt + MOVEMENT_EPSILON_PX;
    this.set(short ? "anchor" : "tail", metrics);
  }

  private markPending(): void {
    this.sampling = true;
    if (this.sampleHandle !== null) return;
    this.sampleHandle = this.timer.set(
      () => this.flush(),
      SCROLL_SAMPLE_INTERVAL_MS,
    );
  }

  private flush(): void {
    if (!this.sampling) return;
    this.cancel();
    const metrics = this.port.read();
    if (this.moved(metrics)) {
      const down = metrics.top > (this.acknowledged ?? metrics.top);
      this.acknowledged = metrics.top;
      if (!nearBottom(metrics) || (this.current === "anchor" && !down)) {
        this.set("free", metrics);
      } else if (this.current !== "tail") {
        this.arrive(metrics);
      }
      return;
    }
    if (this.current === "tail") this.jump();
    else if (this.current === "anchor") this.hold();
  }

  private cancel(): void {
    if (this.sampleHandle !== null) this.timer.clear(this.sampleHandle);
    this.sampleHandle = null;
    this.sampling = false;
  }

  private set(mode: FollowMode, metrics: ScrollMetrics): void {
    const behind =
      mode === "free" ||
      (mode === "anchor" && metrics.floor - metrics.top > NEAR_BOTTOM_PX);
    if (mode === this.current && behind === this.lagging) return;
    this.current = mode;
    this.lagging = behind;
    this.onChange({ mode, behind });
  }
}
