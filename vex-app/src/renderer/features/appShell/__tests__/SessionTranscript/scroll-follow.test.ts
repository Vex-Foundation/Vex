/*! Portions © 2026 DeepSeek, MIT License. See vex-app/THIRD_PARTY_NOTICES.md.
 * Upstream model: packages/client/ui-chat/tests/scroll-follow.client.spec.ts @ 639ed01
 * Ported from VEX Cloud `apps/web/src/components/chat/thread/scroll-follow.test.ts`. */
/**
 * THE FOLLOW CONTROLLER (`SessionTranscript/scrollFollow.ts`), pure. Regressions
 * this catches: a reader yanked back to the bottom by streamed growth while
 * the sample is pending (the (a)-(c) cases), growth deferred during the sample
 * never caught up (d), a stale sample surviving a re-pin (e), a threshold off
 * by one (25px is still "near"), sub-pixel noise counted as movement, and an
 * unfollowed reader clamped to a new floor by a larger viewport never
 * resuming.
 *
 * Top anchoring: a send anchors the newest turn at the top and the reply grows
 * under it. It catches a send that still jumps to the floor, any write while
 * the reply grows under the anchor, a tail space that never shrinks or never
 * makes room, a reader at the floor of a long reply who does not get the tail
 * back, a reader back at a short turn's anchor who is switched to tail
 * following, and a stored landing that keeps an old anchor's space.
 *
 * Desktop additions: a load-older prepend (`shifted`) that must not swallow a
 * reader gesture still in its sample, and a saved reader position
 * (`restore`) that lands free, or follows when it lands near the floor.
 *
 * The scrollport and the timer are fakes: `write` counts every programmatic
 * scroll; the timer runs only when the test fires it; `reserve` sizes the tail
 * space with the real `tailSpace` rule.
 */
import { describe, expect, test } from "vitest";
import {
  type FollowPort,
  type FollowState,
  type FollowTimer,
  NEAR_BOTTOM_PX,
  nearBottom,
  SCROLL_SAMPLE_INTERVAL_MS,
  ScrollFollow,
  tailSpace,
} from "../../SessionTranscript/scrollFollow.js";

const VIEWPORT = 600;

interface TimerEntry {
  readonly callback: () => void;
  readonly ms: number;
  cleared: boolean;
}

function world(initialHeight = 2_000) {
  // The natural content height: the transcript and the seat, no tail space.
  let height = initialHeight;
  let viewport = VIEWPORT;
  let space = 0;
  let anchor: number | null = null;
  let top = 0;
  const floor = (): number => Math.max(0, height + space - viewport);
  const writes: number[] = [];
  const port: FollowPort = {
    read: () => ({ top, floor: floor() }),
    write: (next) => {
      writes.push(next);
      top = Math.max(0, Math.min(next, floor()));
    },
    anchorTop: () => anchor,
    reserve: (target) => {
      space = target === null ? 0 : tailSpace(target, viewport, height);
      // A smaller space clamps like a browser.
      top = Math.min(top, floor());
    },
  };
  const timers: TimerEntry[] = [];
  const timer: FollowTimer = {
    set: (callback, ms) => {
      const entry: TimerEntry = { callback, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clear: (handle) => {
      for (const entry of timers) {
        if (entry === handle) entry.cleared = true;
      }
    },
  };
  const changes: FollowState[] = [];
  const follow = new ScrollFollow(port, {
    timer,
    onChange: (next) => changes.push(next),
  });
  return {
    follow,
    writes,
    changes,
    timers,
    floor,
    get top() {
      return top;
    },
    get space() {
      return space;
    },
    /** The reader (or the browser) moved the scrollport. */
    scrollBy(delta: number) {
      top = Math.max(0, Math.min(top + delta, floor()));
    },
    /** Content (or the seat) grew; a negative delta shrinks it and clamps. */
    grow(delta: number) {
      height += delta;
      top = Math.min(top, floor());
    },
    /** The viewport grew; the browser clamps `top` to the new floor. */
    enlarge(delta: number) {
      viewport += delta;
      top = Math.max(0, Math.min(top, floor()));
    },
    /** A user row appended at the end; `anchorTop` is its top minus the air. */
    send(anchorTop: number, rowHeight = 80) {
      height += rowHeight;
      anchor = anchorTop;
    },
    /** Content above the newest turn grew: the anchor moved down with it. */
    shiftAnchor(delta: number) {
      height += delta;
      if (anchor !== null) anchor += delta;
    },
    /** An older page landed above the view, and the view moved with it. */
    prepend(delta: number) {
      height += delta;
      if (anchor !== null) anchor += delta;
      top = Math.max(0, Math.min(top + delta, floor()));
    },
    /** Fires the pending sample timer, as 500ms elapsing would. */
    elapse() {
      const live = timers.filter((entry) => !entry.cleared);
      for (const entry of live) {
        entry.cleared = true;
        entry.callback();
      }
    },
    liveTimers: () => timers.filter((entry) => !entry.cleared).length,
  };
}

/** A transcript landed at its floor (900), then a send whose anchor top is 1484. */
function anchored() {
  const w = world(1_500);
  w.follow.land();
  w.send(1_484);
  w.follow.anchor();
  return w;
}

describe("scroll follow: near-bottom and attribution", () => {
  test("the threshold is 25px inclusive", () => {
    expect(NEAR_BOTTOM_PX).toBe(25);
    expect(nearBottom({ top: 975, floor: 1_000 })).toBe(true);
    expect(nearBottom({ top: 974.5, floor: 1_000 })).toBe(false);
  });

  test("landing jumps to the floor, follows, and acknowledges the landed top", () => {
    const w = world();
    w.follow.land();
    expect(w.writes).toEqual([1_400]);
    expect(w.top).toBe(1_400);
    expect(w.follow.following).toBe(true);
    expect(w.follow.mode).toBe("tail");
    // The scroll event of its own write is not reader movement.
    w.follow.onScroll();
    expect(w.follow.pending).toBe(false);
  });

  test("sub-pixel movement (0.5px) is not reader movement", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-0.5);
    w.follow.onScroll();
    expect(w.follow.pending).toBe(false);
    w.scrollBy(-0.1);
    w.follow.onScroll();
    expect(w.follow.pending).toBe(true);
  });

  test("a reader at the exact floor resumes following at once", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    w.elapse();
    expect(w.follow.following).toBe(false);
    w.grow(200);
    w.scrollBy(10_000);
    w.follow.onScroll();
    expect(w.follow.following).toBe(true);
    expect(w.follow.pending).toBe(false);
    expect(w.liveTimers()).toBe(0);
  });

  test("a reader clamped to a new floor by a larger viewport resumes on the scroll event", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    w.elapse();
    expect(w.follow.following).toBe(false);
    // Acknowledged at 1100px; the floor drops to 1000px and the browser
    // clamps there, which is no movement against min(1100, 1000).
    w.enlarge(400);
    expect(w.top).toBe(1_000);
    expect(w.top).toBe(w.floor());
    w.follow.onScroll();
    expect(w.follow.following).toBe(true);
    expect(w.follow.pending).toBe(false);
    w.grow(200);
    w.follow.onGrowth();
    expect(w.top).toBe(w.floor());
    expect(w.top).toBe(1_200);
  });

  test("a reader clamped to a new floor resumes on growth when no scroll event came", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    w.elapse();
    expect(w.follow.following).toBe(false);
    w.enlarge(400);
    // The resize observer reports the larger viewport first.
    w.follow.onGrowth();
    expect(w.follow.following).toBe(true);
    w.grow(200);
    w.follow.onGrowth();
    expect(w.top).toBe(w.floor());
    expect(w.top).toBe(1_200);
  });

  test("a clamp to the floor keeps a pending sample pending on growth", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    w.elapse();
    w.follow.onIntent();
    expect(w.follow.pending).toBe(true);
    const count = w.writes.length;
    w.enlarge(400);
    w.follow.onGrowth();
    expect(w.follow.pending).toBe(true);
    expect(w.writes.length).toBe(count);
  });
});

describe("scroll follow: sampling", () => {
  test("a sample starts on movement and runs 500ms; movement within it does not restart it", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-100);
    w.follow.onScroll();
    w.scrollBy(-100);
    w.follow.onScroll();
    expect(w.timers).toHaveLength(1);
    expect(w.timers[0]?.ms).toBe(SCROLL_SAMPLE_INTERVAL_MS);
  });

  test("the sample settles on the timer: counted movement takes the near-bottom test", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    expect(w.follow.following).toBe(true);
    w.elapse();
    expect(w.follow.pending).toBe(false);
    expect(w.follow.following).toBe(false);
    expect(w.changes).toEqual([{ mode: "free", behind: true }]);
  });

  test("the sample settles early on scrollend; a near-bottom stop keeps following", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-20);
    w.follow.onScroll();
    w.follow.onScrollEnd();
    expect(w.follow.pending).toBe(false);
    expect(w.liveTimers()).toBe(0);
    expect(w.follow.following).toBe(true);
  });

  test("(a) intent plus growth inside the window writes nothing", () => {
    const w = world();
    w.follow.land();
    const landed = w.writes.length;
    w.follow.onIntent();
    w.scrollBy(-300);
    w.follow.onScroll();
    for (let chunk = 0; chunk < 20; chunk += 1) {
      w.grow(24);
      w.follow.onGrowth();
    }
    expect(w.writes.length).toBe(landed);
    w.elapse();
    expect(w.writes.length).toBe(landed);
    expect(w.follow.following).toBe(false);
  });

  test("(b) movement seen by a scroll event without intent, plus growth, writes nothing", () => {
    const w = world();
    w.follow.land();
    const landed = w.writes.length;
    w.scrollBy(-300);
    w.follow.onScroll();
    w.grow(500);
    w.follow.onGrowth();
    expect(w.writes.length).toBe(landed);
    expect(w.follow.pending).toBe(true);
  });

  test("(c) a 300px movement no scroll event reported is caught by the pre-write check", () => {
    const w = world();
    w.follow.land();
    const landed = w.writes.length;
    w.scrollBy(-300);
    w.grow(100);
    w.follow.onGrowth();
    expect(w.writes.length).toBe(landed);
    expect(w.follow.pending).toBe(true);
  });

  test("(d) intent without movement plus growth: one floor jump when the sample settles", () => {
    const w = world();
    w.follow.land();
    const landed = w.writes.length;
    w.follow.onIntent();
    w.grow(100);
    w.follow.onGrowth();
    w.grow(100);
    w.follow.onGrowth();
    expect(w.writes.length).toBe(landed);
    w.elapse();
    expect(w.writes.slice(landed)).toEqual([w.floor()]);
    expect(w.top).toBe(w.floor());
    expect(w.follow.following).toBe(true);
  });

  test("(e) a re-pin clears the pending sample and jumps to the floor", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    w.elapse();
    w.follow.onIntent();
    expect(w.follow.pending).toBe(true);
    w.grow(400);
    w.follow.repin();
    expect(w.follow.pending).toBe(false);
    expect(w.liveTimers()).toBe(0);
    expect(w.top).toBe(w.floor());
    expect(w.follow.following).toBe(true);
    w.grow(50);
    w.follow.onGrowth();
    expect(w.top).toBe(w.floor());
  });

  test("following and not pending: growth pins to the floor after every chunk", () => {
    const w = world();
    w.follow.land();
    for (let chunk = 0; chunk < 5; chunk += 1) {
      w.grow(37);
      w.follow.onGrowth();
      expect(w.floor() - w.top).toBeLessThanOrEqual(1);
    }
  });

  test("not following: growth preserves the position", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-500);
    w.follow.onScroll();
    w.elapse();
    const top = w.top;
    const count = w.writes.length;
    w.grow(300);
    w.follow.onGrowth();
    expect(w.top).toBe(top);
    expect(w.writes.length).toBe(count);
  });

  test("dispose cancels the sample and stops reporting", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    w.follow.dispose();
    expect(w.liveTimers()).toBe(0);
    w.follow.onScrollEnd();
    expect(w.changes).toEqual([]);
  });

  test("negative control: following on growth whenever following is true fails case (a)", () => {
    const w = world();
    w.follow.land();
    const landed = w.writes.length;
    w.follow.onIntent();
    w.scrollBy(-300);
    w.follow.onScroll();
    // The naive rule a regression would ship: follow whenever following.
    const naiveGrowth = (): void => {
      if (w.follow.following) {
        w.writes.push(w.floor());
      }
    };
    w.grow(24);
    naiveGrowth();
    expect(w.writes.length).toBeGreaterThan(landed);
    // The real controller, same inputs: nothing written.
    const v = world();
    v.follow.land();
    const vLanded = v.writes.length;
    v.follow.onIntent();
    v.scrollBy(-300);
    v.follow.onScroll();
    v.grow(24);
    v.follow.onGrowth();
    expect(v.writes.length).toBe(vLanded);
  });
});

describe("scroll follow: tail space", () => {
  test("the space is what the view lacks below the anchor, never negative, whole pixels up, none at the top", () => {
    // Anchor 1484, view 600, content ending at 1580: 504px more let the floor reach 1484.
    expect(tailSpace(1_484, 600, 1_580)).toBe(504);
    expect(tailSpace(1_484, 600, 2_500)).toBe(0);
    expect(tailSpace(100.25, 600, 600)).toBe(101);
    // A transcript shorter than the view: the whole lack, from the content's end.
    expect(tailSpace(50, 600, 200)).toBe(450);
    // The first turn anchors at the transcript's top: no space at all.
    expect(tailSpace(0, 600, 200)).toBe(0);
  });
});

describe("scroll follow: top anchoring", () => {
  test("a send anchors the newest turn: one instant write to its top, the floor made reachable", () => {
    const w = anchored();
    expect(w.writes).toEqual([900, 1_484]);
    expect(w.top).toBe(1_484);
    expect(w.space).toBe(504);
    expect(w.floor()).toBe(1_484);
    expect(w.follow.mode).toBe("anchor");
    expect(w.follow.following).toBe(false);
    expect(w.follow.behind).toBe(false);
    expect(w.changes).toEqual([{ mode: "anchor", behind: false }]);
  });

  test("a send clears a pending reader sample", () => {
    const w = world(1_500);
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    expect(w.follow.pending).toBe(true);
    w.send(1_484);
    w.follow.anchor();
    expect(w.follow.pending).toBe(false);
    expect(w.liveTimers()).toBe(0);
    expect(w.top).toBe(1_484);
  });

  test("the reply grows under the anchor: no write on any growth; the space shrinks as it fills", () => {
    const w = anchored();
    const count = w.writes.length;
    for (let chunk = 0; chunk < 10; chunk += 1) {
      w.grow(48);
      w.follow.onGrowth();
      expect(w.top).toBe(1_484);
    }
    expect(w.writes.length).toBe(count);
    expect(w.space).toBe(24);
    expect(w.follow.mode).toBe("anchor");
    expect(w.follow.behind).toBe(false);
  });

  test("once more than 25px wait below the view, behind turns on (the pill), still no write", () => {
    const w = anchored();
    const count = w.writes.length;
    w.grow(504 + 25);
    w.follow.onGrowth();
    expect(w.follow.behind).toBe(false);
    w.grow(1);
    w.follow.onGrowth();
    expect(w.follow.behind).toBe(true);
    expect(w.follow.mode).toBe("anchor");
    expect(w.top).toBe(1_484);
    expect(w.writes.length).toBe(count);
    expect(w.changes.at(-1)).toEqual({ mode: "anchor", behind: true });
  });

  test("a reader who scrolls to the floor of a long reply gets tail following back", () => {
    const w = anchored();
    w.grow(1_000);
    w.follow.onGrowth();
    w.follow.onIntent();
    w.scrollBy(10_000);
    w.follow.onScroll();
    expect(w.follow.mode).toBe("tail");
    expect(w.follow.pending).toBe(false);
    w.grow(60);
    w.follow.onGrowth();
    expect(w.top).toBe(w.floor());
  });

  test("a reader who stops near the floor of a long reply (moving down) follows the tail", () => {
    const w = anchored();
    w.grow(1_000);
    w.follow.onGrowth();
    w.scrollBy(w.floor() - w.top - 20);
    w.follow.onScroll();
    w.elapse();
    expect(w.follow.mode).toBe("tail");
  });

  test("a reader who scrolls up from the anchor is free: growth writes nothing, behind", () => {
    const w = anchored();
    w.follow.onIntent();
    w.scrollBy(-300);
    w.follow.onScroll();
    const count = w.writes.length;
    w.grow(48);
    w.follow.onGrowth();
    expect(w.writes.length).toBe(count);
    w.elapse();
    expect(w.follow.mode).toBe("free");
    expect(w.follow.behind).toBe(true);
    expect(w.top).toBe(1_184);
  });

  test("the pre-write check holds while anchored: unobserved movement plus growth is the reader's", () => {
    const w = anchored();
    const count = w.writes.length;
    w.scrollBy(-200);
    w.grow(48);
    w.follow.onGrowth();
    expect(w.writes.length).toBe(count);
    expect(w.follow.pending).toBe(true);
    w.elapse();
    expect(w.follow.mode).toBe("free");
  });

  test("an intent without movement at a short reply's anchor keeps the anchor (no tail switch)", () => {
    const w = anchored();
    // End or a wheel-down at the anchor: it is the floor, nothing moves.
    w.follow.onIntent();
    w.elapse();
    expect(w.follow.mode).toBe("anchor");
    const count = w.writes.length;
    w.grow(1_000);
    w.follow.onGrowth();
    expect(w.top).toBe(1_484);
    expect(w.writes.length).toBe(count);
  });

  test("a reader back at a short turn's anchor is anchored again, not tail following", () => {
    const w = anchored();
    w.scrollBy(-200);
    w.follow.onScroll();
    w.elapse();
    expect(w.follow.mode).toBe("free");
    // Back down to the floor, which the tail space holds at the anchor.
    w.scrollBy(200);
    w.follow.onScroll();
    expect(w.follow.mode).toBe("anchor");
    const count = w.writes.length;
    w.grow(1_000);
    w.follow.onGrowth();
    expect(w.top).toBe(1_484);
    expect(w.writes.length).toBe(count);
  });

  test("jump to latest while anchored follows the tail for the rest of the stream", () => {
    const w = anchored();
    w.grow(1_000);
    w.follow.onGrowth();
    expect(w.follow.behind).toBe(true);
    w.follow.repin();
    expect(w.top).toBe(w.floor());
    expect(w.follow.mode).toBe("tail");
    expect(w.follow.behind).toBe(false);
    w.grow(60);
    w.follow.onGrowth();
    expect(w.top).toBe(w.floor());
  });

  test("a growing card never moves the anchored turn; a shrinking one that clamps is restored", () => {
    const w = anchored();
    // The reply passes the bottom by 16px; the space is gone.
    w.grow(520);
    w.follow.onGrowth();
    expect(w.space).toBe(0);
    const count = w.writes.length;
    // An approval card (or the seat) grows below: no write, the anchor stays at the top.
    w.grow(200);
    w.follow.onGrowth();
    expect(w.top).toBe(1_484);
    expect(w.writes.length).toBe(count);
    // The card resolves: content shrinks, the browser clamps to a lower floor.
    w.grow(-350);
    expect(w.top).toBeLessThan(1_484);
    w.follow.onGrowth();
    expect(w.writes.slice(count)).toEqual([1_484]);
    expect(w.top).toBe(1_484);
    expect(w.follow.mode).toBe("anchor");
    expect(w.follow.pending).toBe(false);
  });

  test("content above the anchor grew: the anchored turn is held at the top by one write", () => {
    const w = anchored();
    const count = w.writes.length;
    w.shiftAnchor(50);
    w.follow.onGrowth();
    expect(w.writes.slice(count)).toEqual([1_534]);
    expect(w.top).toBe(1_534);
  });

  test("a send without a turn anchor falls back to the floor", () => {
    const w = world();
    w.follow.land();
    w.scrollBy(-300);
    w.follow.onScroll();
    w.elapse();
    w.follow.anchor();
    expect(w.top).toBe(w.floor());
    expect(w.follow.mode).toBe("tail");
  });

  test("an initial landing clears the anchor and its space and lands at the floor", () => {
    const w = anchored();
    w.follow.land();
    expect(w.space).toBe(0);
    expect(w.top).toBe(w.floor());
    expect(w.follow.mode).toBe("tail");
    w.grow(40);
    w.follow.onGrowth();
    expect(w.space).toBe(0);
    expect(w.top).toBe(w.floor());
  });

  test("negative control: a send that re-pins to the floor (the retired rule) moves scrollTop on growth", () => {
    const w = world(1_500);
    w.follow.land();
    w.send(1_484);
    // The retired rule: a send re-pins to the floor and follows the tail.
    w.follow.repin();
    const count = w.writes.length;
    w.grow(800);
    w.follow.onGrowth();
    expect(w.writes.length).toBeGreaterThan(count);
    expect(w.top).not.toBe(1_484);
    // The anchored controller, same inputs: no write, the turn at the top.
    const v = anchored();
    const vCount = v.writes.length;
    v.grow(800);
    v.follow.onGrowth();
    expect(v.writes.length).toBe(vCount);
    expect(v.top).toBe(1_484);
  });
});

describe("scroll follow: Desktop paging and saved positions", () => {
  test("a prepend inside a reader's sample keeps the gesture counted: the reader ends free, not re-anchored", () => {
    const w = anchored();
    // The reader flicks up toward the head; the older page lands mid-sample.
    w.follow.onIntent();
    w.scrollBy(-1_400);
    w.follow.onScroll();
    const count = w.writes.length;
    w.prepend(800);
    w.follow.shifted(800);
    w.follow.onGrowth();
    w.elapse();
    expect(w.follow.mode).toBe("free");
    expect(w.writes.length).toBe(count);
    expect(w.top).toBe(884);
  });

  test("a prepend measures the anchor again: a later hold targets the moved turn", () => {
    const w = anchored();
    w.prepend(800);
    w.follow.shifted(800);
    w.follow.onGrowth();
    expect(w.top).toBe(2_284);
    expect(w.follow.mode).toBe("anchor");
  });

  test("restore lands the saved top once, free and behind, with no tail space", () => {
    const w = anchored();
    w.follow.restore(300);
    expect(w.top).toBe(300);
    expect(w.space).toBe(0);
    expect(w.follow.mode).toBe("free");
    expect(w.follow.behind).toBe(true);
    // Growth never moves a restored reader.
    const count = w.writes.length;
    w.grow(200);
    w.follow.onGrowth();
    expect(w.writes.length).toBe(count);
  });

  test("restore near the floor follows the tail, as a landing does", () => {
    const w = world();
    w.follow.restore(1_390);
    expect(w.top).toBe(1_400);
    expect(w.follow.mode).toBe("tail");
    expect(w.follow.behind).toBe(false);
  });
});
