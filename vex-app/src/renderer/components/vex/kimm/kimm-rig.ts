/**
 * Kimm's own motion (SK KIMM.md 6; vex-home `kimm.js:43-107, 157-226`, the fixed `kimm-embed.js` `on()` and
 * `frame()`): the mood clock, the hand crossfade, the springs, the hop, the gaze, the idle acts, the breath and the
 * talk flap, without PIXI or the model. `kimm-embed.ts` writes what `frame()` returns into the model's parameters each
 * update; the tests step it on a manual clock.
 *
 * Kept from the embed's fixes: one clock for everything, springs and the hop sub-stepped at 1/60 s so they stay stable
 * on slow frames (the eye spring of `kimm.js` diverges under 19.5 fps); reduced motion makes every value jump (tau
 * 1 ms), with no sway, hop or swap impulse.
 *
 * DESKTOP PORT (owner decision 2026-11-15): VEX Cloud's `apps/web/src/components/kimm/kimm-rig.ts`, unchanged but for
 * its moods' names (`KimmLiveMood`, `KIMM_LIVE_MOODS` in `kimm-live-moods.ts`: on desktop `KimmMood` is the mood of
 * her still, `kimm-assets.ts`), the import suffixes and the indentation, plus desktop's lock-screen lively mode
 * (`KIMM_LIVELY`, `lively()`, `pointerAway()`), off by default so Cloud's behaviour and the Vex card's stay as they were.
 */
import {
  KIMM_HANDS,
  KIMM_MARKS,
  KIMM_LIVE_MOODS,
  type KimmEvent,
  type KimmLiveMood,
} from "./kimm-live-moods.js";

/** What she glances at: an element (its box) or a point in client px. */
export type KimmLookTarget =
  | {
      getBoundingClientRect(): {
        left: number;
        top: number;
        width: number;
        height: number;
      };
    }
  | { readonly x: number; readonly y: number };

/** The places she glances at by name (`talk`: the transcript, `key`: the view's one action). */
export type KimmTargets = Readonly<
  Record<string, KimmLookTarget | null | (() => KimmLookTarget | null)>
>;

export interface KimmRigOptions {
  /** The clock in ms (`performance.now()` by default); tests pass a manual one. */
  readonly now?: () => number;
  readonly reducedMotion?: boolean;
  /** Idle acts when she rests (default on). */
  readonly idle?: boolean;
  /** She follows the pointer that moved in the last 5 s (default on). */
  readonly pointer?: boolean;
  /** The idle acts she may play (default all). */
  readonly acts?: readonly KimmActName[];
  readonly targets?: KimmTargets;
  /** True while a recorded line plays (no acts; the mouth follows `level`). */
  readonly speaking?: () => boolean;
  /** The voice level 0 to 1 while speaking. */
  readonly level?: () => number;
  /** Random in [0, 1) (acts and their timing). */
  readonly random?: () => number;
  /** The lock screen's lively mode from the start (`KIMM_LIVELY`; `lively()` switches it later). */
  readonly lively?: boolean;
}

/**
 * THE LOCK SCREEN'S LIVELY MODE (desktop only; owner decision 2026-11-15: "like a game login screen, never
 * standing still"). Off by default, so Cloud's rig and desktop's Vex card are unchanged. On, she:
 *   - sways and drifts more: the head and body sways run at `sway` times Cloud's amplitude (still within the
 *     angle clamps);
 *   - bobs with her breath: up to `bobPx` px up on each 3.4 s breath, a slow bounce, never a jitter;
 *   - plays her idle acts sooner and more often: the first `firstActMs` after the switch, then every `actGapMs`
 *     (instead of Cloud's 5 s, then 3.5 to 7 s), and `afterEventMs` after an event that ends a run (Cloud's 4 s);
 *   - follows the pointer that moved in the last `lookHoldMs` (Cloud's 5 s), then eases back to centre on her
 *     springs; `pointerAway()` (the pointer left the window) eases her back at once.
 * Reduced motion never reaches it: the panel never seats her live under it, and the rig zeroes sway and bob anyway.
 * `fps` is the ticker cap the embed applies in lively mode, to spare the battery.
 */
export const KIMM_LIVELY = {
  sway: 1.8,
  bobPx: 2.4,
  firstActMs: 2000,
  actGapMs: [1400, 3200] as const,
  afterEventMs: 2000,
  lookHoldMs: 3000,
  fps: 30,
} as const;

/** The box she stands in, in client px (her head line is 18% down it). */
export interface KimmHostBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One frame of the rig: every parameter to write (drawn in this order), her vertical offset and how shut her eyes are. */
export interface KimmRigFrame {
  readonly params: ReadonlyMap<string, number>;
  /** The hop's offset in px (0 under reduced motion). */
  readonly y: number;
  /** 0 open to 1 shut (the stretch act). */
  readonly shut: number;
  /** The time in seconds (the breath and sways read it). */
  readonly t: number;
}

/** Spring stiffness per parameter (`kimm.js:43`): eyes quick, head calm, body slow; marks 11, the rest 9. */
export const KIMM_SPRINGS: Readonly<Record<string, number>> = {
  ParamEyeBallX: 16,
  ParamEyeBallY: 16,
  ParamAngleX: 6.5,
  ParamAngleY: 6.5,
  ParamAngleZ: 5.5,
  ParamBodyAngleX: 4,
  ParamBodyAngleY: 4,
  ParamBodyAngleZ: 3.6,
};

/** The hand crossfade (`kimm.js:195-203`): 340 ms, 260 ms into or out of crossed arms; a pose holds 650 ms, rest 350. */
export const KIMM_HAND_MS = { swap: 340, crossed: 260, hold: 650, rest: 350 };

/** The breath's cycle in seconds (ParamBreath = 0.5 + 0.5 sin(2 pi t / 3.4)). */
export const KIMM_BREATH_S = 3.4;

interface ActPose {
  readonly ax?: number;
  readonly ay?: number;
  readonly az?: number;
  readonly bz?: number;
  readonly mouth?: number;
  readonly shut?: boolean;
  readonly to?: string | null;
}

interface Act {
  readonly ms: number;
  readonly mood?: KimmLiveMood;
  readonly hop?: number;
  readonly clean?: boolean;
  readonly pose?: (u: number) => ActPose;
}

/** The idle acts (`kimm.js:48-65`), with the page's selectors replaced by named targets. */
const ACTS = {
  scan: {
    ms: 2600,
    mood: "sign",
    pose: (u: number) => ({ ax: Math.sin(u * Math.PI * 3) * 26, ay: 4 }),
  },
  ponder: { ms: 2600, mood: "think", pose: () => ({ ax: -14, ay: 14, az: 8 }) },
  survey: {
    ms: 3000,
    pose: (u: number) => ({ to: u < 0.35 ? "talk" : u < 0.7 ? "key" : null }),
  },
  hello: { ms: 1600, mood: "hi", hop: 1 },
  invite: { ms: 2000, mood: "point", pose: () => ({ to: "key" }) },
  wait: { ms: 2600, mood: "no", clean: true, pose: () => ({ az: -9, ax: 6 }) },
  stretch: {
    ms: 1800,
    pose: (u: number) => ({
      bz: Math.sin(u * Math.PI) * 9,
      az: Math.sin(u * Math.PI) * 12,
      ay: 10 * Math.sin(u * Math.PI),
      shut: u > 0.15 && u < 0.85,
      mouth: Math.sin(u * Math.PI) * 0.45,
    }),
  },
  present: { ms: 2200, mood: "offer" },
} as const satisfies Record<string, Act>;

export type KimmActName = keyof typeof ACTS;

export const KIMM_ACTS = Object.keys(ACTS) as KimmActName[];

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const smoothstep = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

const isHand = (id: string) => (KIMM_HANDS as readonly string[]).includes(id);

/** The rig: one per live model. */
export function createKimmRig(options: KimmRigOptions = {}) {
  const now = options.now ?? (() => performance.now());
  const RM = options.reducedMotion === true;
  const random = options.random ?? Math.random;
  const targets = options.targets ?? {};
  const cur: Record<string, number> = {};
  const tgt: Record<string, number> = {};
  const vel: Record<string, number> = {};
  const raw: Record<string, number> = {};
  const hands = {
    want: null as string | null,
    t0: -1e9,
    dur: 300,
    hold: 0,
    from: {} as Record<string, number>,
  };
  const set = (id: string, value: number) => {
    tgt[id] = value;
  };
  let mood: KimmLiveMood = "rest";
  let moodUntil = 0;
  let talkUntil = 0;
  let focus: KimmLookTarget | null = null;
  let focusUntil = 0;
  let active = false;
  let nextIdle = now() + 5000;
  let act: { readonly name: KimmActName; readonly t0: number } | null = null;
  let lastAct = "";
  let px = -1;
  let py = -1;
  let lastMove = -1e9;
  let hover = false;
  let hop = 0;
  let jy = 0;
  let hv = 0;
  let shut = 0;
  let lastT = 0;
  let lively = options.lively === true;
  if (lively) nextIdle = now() + KIMM_LIVELY.firstActMs;
  const actNames = (options.acts ?? KIMM_ACTS).filter((name) => name in ACTS);
  const targetOf = (name: string): KimmLookTarget | null => {
    const value = targets[name];
    return (typeof value === "function" ? value() : value) ?? null;
  };

  const setMood = (next: KimmLiveMood, ms = 0) => {
    mood = next;
    moodUntil = ms ? now() + ms : 0;
    for (const id of [...KIMM_HANDS, ...KIMM_MARKS]) set(id, 0);
    const rig = KIMM_LIVE_MOODS[next];
    for (const [id, value] of Object.entries(rig))
      if (id !== "form" && id !== "smile") set(id, value);
    set("ParamMouthForm", rig.form ?? 0);
    set("ParamEyeRSmile", rig.smile ?? 0);
  };
  const startAct = () => {
    const names = actNames.filter((name) => name !== lastAct);
    if (!names.length) return;
    const name = names[Math.floor(random() * names.length)] as KimmActName;
    const A: Act = ACTS[name];
    lastAct = name;
    act = { name, t0: now() };
    if (A.mood) {
      setMood(A.mood, A.ms);
      if (A.clean) {
        set("E1", 0);
        set("FeceAngry", 0);
        set("ParamMouthForm", 0.3);
      }
    }
    if (A.hop) hop = A.hop;
  };
  const talk = (ms: number) => {
    talkUntil = Math.max(talkUntil, now() + ms);
  };
  const look = (target: KimmLookTarget | null, ms = 2400) => {
    focus = target;
    focusUntil = now() + ms;
  };

  /** The event vocabulary of `window.kimm.on` (`kimm.js:89-107`). */
  const on = (event: KimmEvent, data?: unknown) => {
    const t = now();
    if (
      event === "request" ||
      event === "propose" ||
      event === "wait" ||
      event === "approve"
    ) {
      active = true;
      act = null;
    }
    if (event === "idle" || event === "refused" || event === "reset") {
      active = false;
      nextIdle = t + (lively ? KIMM_LIVELY.afterEventMs : 4000);
    }
    if (event === "press") nextIdle = t + 6000;
    switch (event) {
      case "request":
        setMood("think");
        look(targetOf("talk"), 3000);
        break;
      case "say":
        talk(clamp(String(data ?? "").length * 26, 500, 3200));
        break;
      case "propose":
        setMood("rest");
        set("ParamMouthForm", 0.6);
        look(targetOf("talk"), 1800);
        break;
      case "wait":
        setMood("offer");
        look(targetOf("key"), 1800);
        break;
      case "approve":
        setMood("sign");
        break;
      case "done":
        setMood("v", 2800);
        hop = 1;
        break;
      case "refused":
        setMood("no", 3400);
        break;
      case "hi":
        setMood("hi", 1800);
        hop = 1;
        break;
      case "idle":
        if (!moodUntil) setMood("rest");
        break;
      case "spam":
        setMood("oops", 1600);
        hop = 1;
        talk(600);
        break;
      case "nudge":
        setMood("offer", 2200);
        look(targetOf("key"), 1600);
        break;
      case "eyekey":
        look(targetOf("key"), 1200);
        if (mood === "rest") {
          set("ParamMouthForm", 0.9);
          set("ParamEyeRSmile", 0.6);
        }
        break;
      case "press":
        look(targetOf("key"), 700);
        if (mood === "rest") hop = 0.6;
        break;
      case "reset":
        break;
    }
  };

  const frame = (host: KimmHostBox): KimmRigFrame => {
    const t0 = now();
    const t = t0 / 1000;
    const dt = Math.min(0.1, Math.max(0, (t0 - (lastT || t0)) / 1000));
    lastT = t0;
    if (moodUntil && t0 > moodUntil) setMood("rest");
    const speaking = options.speaking?.() ?? false;
    if (
      !active &&
      !act &&
      mood === "rest" &&
      t0 > nextIdle &&
      !speaking &&
      options.idle !== false
    )
      startAct();
    let P: ActPose = {};
    let env = 0;
    if (act) {
      const A: Act = ACTS[act.name];
      const u = (t0 - act.t0) / A.ms;
      if (u >= 1) {
        act = null;
        const [gapMin, gapMax] = lively ? KIMM_LIVELY.actGapMs : ([3500, 7000] as const);
        nextIdle = t0 + gapMin + random() * (gapMax - gapMin);
      } else {
        env = smoothstep(0, 0.2, u) * (1 - smoothstep(0.8, 1, u));
        if (A.pose) P = A.pose(u);
      }
    }
    const ax = (P.ax ?? 0) * env;
    const ay = (P.ay ?? 0) * env;
    const az = (P.az ?? 0) * env;
    const bz = (P.bz ?? 0) * env;
    const mouth = (P.mouth ?? 0) * env;
    if (focus && t0 > focusUntil) focus = null;
    /* where to look: a target, else the pointer if it moved in the last 5 s (3 s lively), else a slow drift
       (`kimm.js:170-177`) */
    const hx = host.left + host.width * 0.5;
    const hy = host.top + host.height * 0.18;
    let tx = hx + Math.sin(t * 0.35) * 60;
    let ty = hy + 40 + Math.sin(t * 0.23) * 24;
    const lookHold = lively ? KIMM_LIVELY.lookHoldMs : 5000;
    if (options.pointer !== false && t0 - lastMove < lookHold && px >= 0) {
      tx = px;
      ty = py;
    }
    const fo = focus ?? (P.to ? targetOf(P.to) : null);
    if (fo) {
      if ("getBoundingClientRect" in fo) {
        const box = fo.getBoundingClientRect();
        tx = box.left + box.width * 0.5;
        ty = box.top + box.height * 0.6;
      } else {
        tx = fo.x;
        ty = fo.y;
      }
    }
    const dx = clamp((tx - hx) / 520, -1, 1);
    const dy = clamp((ty - hy) / 420, -1, 1);
    const sw = RM ? 0 : lively ? KIMM_LIVELY.sway : 1;
    const swx = sw * (2.2 * Math.sin(t * 0.47) + 1.3 * Math.sin(t * 0.83 + 2));
    const swz = sw * (1.8 * Math.sin(t * 0.31 + 1) + 0.9 * Math.sin(t * 0.71));
    const swb = sw * 1.3 * Math.sin(t * 0.29 + 0.5);
    set("ParamAngleX", clamp(dx * 28 + ax + swx, -30, 30));
    set(
      "ParamAngleY",
      -dy * 22 +
        (mood === "think" ? -6 : 0) +
        ay +
        sw * Math.sin(t * 0.37) * 1.5,
    );
    set("ParamAngleZ", -dx * 6 + (mood === "think" ? 7 : 0) + az + swz);
    set("ParamBodyAngleX", dx * 9 + swb * 1.4);
    set("ParamBodyAngleY", -dy * 4);
    set("ParamBodyAngleZ", -dx * 3 + bz + swb);
    set("ParamEyeBallX", dx * 0.9);
    set("ParamEyeBallY", -dy * 0.8);
    if (mood === "rest") {
      set("ParamMouthForm", hover ? 0.8 : 0.15);
      set("ParamEyeRSmile", hover ? 0.5 : 0);
    }
    /* lip sync: the voice level while she speaks, else a soft flap while text types (`kimm.js:186-188`) */
    if (speaking && options.level)
      set("ParamMouthOpenY", clamp(options.level() * 1.3, 0, 1));
    else
      set(
        "ParamMouthOpenY",
        t0 < talkUntil
          ? 0.25 + 0.55 * Math.abs(Math.sin(t * 13) * Math.sin(t * 7.3 + 1))
          : mouth,
      );
    /* hands, as the model was rigged (`kimm.js:191-203`): one crossfade clock for all five toggles, smootherstep,
       340 ms (260 ms into or out of crossed arms), a 650 ms hold per pose, and a dip toward the raised side */
    const want = KIMM_HANDS.find((hand) => (tgt[hand] ?? 0) > 0.5) ?? null;
    if (want !== hands.want && t0 - hands.t0 > hands.hold) {
      hands.from = {};
      for (const hand of KIMM_HANDS) hands.from[hand] = cur[hand] ?? 0;
      const leavingCrossed = (hands.from.T4 ?? 0) > 0.5 && want !== "T4";
      hands.want = want;
      hands.t0 = t0;
      hands.hold = want ? KIMM_HAND_MS.hold : KIMM_HAND_MS.rest;
      if (!RM) {
        const side =
          want === "T7" || want === "T8"
            ? 1
            : want === "T5" || want === "T6"
              ? -1
              : 0;
        vel.ParamBodyAngleY = (vel.ParamBodyAngleY ?? 0) - 26;
        vel.ParamAngleY = (vel.ParamAngleY ?? 0) - 30;
        vel.ParamBodyAngleZ = (vel.ParamBodyAngleZ ?? 0) + side * 22;
        vel.ParamAngleZ = (vel.ParamAngleZ ?? 0) + side * 30;
        hv -= 40;
      }
      hands.dur = RM
        ? 1
        : want === "T4" || leavingCrossed
          ? KIMM_HAND_MS.crossed
          : KIMM_HAND_MS.swap;
    }
    {
      const u = Math.min(1, (t0 - hands.t0) / hands.dur);
      const e = u * u * u * (u * (u * 6 - 15) + 10);
      for (const hand of KIMM_HANDS) {
        const from = hands.from[hand] ?? 0;
        const goal = hand === hands.want ? 1 : 0;
        cur[hand] = from + (goal - from) * e;
      }
    }
    const steps = Math.max(1, Math.ceil(dt * 60));
    const h = dt / steps;
    for (const id of Object.keys(tgt)) {
      if (isHand(id)) continue;
      const goal = tgt[id] ?? 0;
      const w =
        KIMM_SPRINGS[id] ??
        (id === "ParamMouthOpenY"
          ? 0
          : id[0] === "E" || id === "FeceAngry" || id === "T1"
            ? 11
            : 9);
      if (w && !RM) {
        let x = cur[id] === undefined ? goal : cur[id];
        let v = vel[id] ?? 0;
        for (let i = 0; i < steps; i++) {
          const acc = -2 * w * v - w * w * (x - goal);
          v += acc * h;
          x += v * h;
        }
        vel[id] = v;
        cur[id] = x;
      } else {
        const a = cur[id] === undefined ? goal : cur[id];
        const tau = RM
          ? 0.001
          : id[0] === "T" || id[0] === "E" || id === "FeceAngry"
            ? 0.16
            : id === "ParamMouthOpenY"
              ? 0.045
              : 0.28;
        cur[id] = a + (goal - a) * (1 - Math.exp(-dt / tau));
      }
    }
    shut += ((P.shut ? 1 : 0) - shut) * (1 - Math.exp(-dt / 0.07));
    if (hop > 0) {
      hv -= 150 * hop;
      hop = 0;
    }
    for (let i = 0; i < steps; i++) {
      const w = 13;
      const z = 0.45;
      const a = -2 * z * w * hv - w * w * jy;
      hv += a * h;
      jy += hv * h;
    }
    const params = new Map<string, number>();
    for (const hand of KIMM_HANDS) params.set(hand, cur[hand] ?? 0);
    for (const id of Object.keys(tgt))
      if (!isHand(id)) params.set(id, cur[id] ?? 0);
    params.set(
      "ParamBreath",
      0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / KIMM_BREATH_S),
    );
    for (const [id, value] of Object.entries(raw)) params.set(id, value);
    /* lively: a slow bounce with her breath, up to `bobPx` up at the top of each breath */
    const bob = lively && !RM ? -KIMM_LIVELY.bobPx * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / KIMM_BREATH_S)) : 0;
    return { params, y: RM ? 0 : jy + bob, shut, t };
  };

  setMood("rest");
  return {
    on,
    frame,
    look,
    talk,
    /** A mood directly (`point`, ...), for `ms` (0: until the next event). */
    mood: (name: KimmLiveMood, ms = 0) => setMood(name, ms),
    /** A raw parameter drawn last, or `null` to drop it (debug, deterministic stills). */
    param: (id: string, value: number | null) => {
      if (value === null) delete raw[id];
      else raw[id] = value;
    },
    /** The pointer moved (client px). */
    /** The lock screen's lively mode on or off (`KIMM_LIVELY`); on, her next idle act comes sooner. */
    lively: (on: boolean) => {
      if (on === lively) return;
      lively = on;
      if (on && !act) nextIdle = Math.min(nextIdle, now() + KIMM_LIVELY.firstActMs);
    },
    /** The pointer left the window: she stops following it and eases back to centre on her springs. */
    pointerAway: () => {
      lastMove = -1e9;
    },
    pointerMove: (x: number, y: number) => {
      px = x;
      py = y;
      lastMove = now();
    },
    /** The pointer is over her canvas: she smiles while she rests. */
    hover: (on: boolean) => {
      hover = on;
    },
    /** A click on her: hi for 1.6 s, a hop and half a second of talk (`kimm.js:234`). */
    poke: () => {
      setMood("hi", 1600);
      hop = 1;
      talk(500);
    },
    get state() {
      return {
        mood,
        active,
        lively,
        act: act?.name ?? null,
        hands: Object.fromEntries(
          KIMM_HANDS.map((hand) => [hand, Number((cur[hand] ?? 0).toFixed(3))]),
        ) as Record<(typeof KIMM_HANDS)[number], number>,
      };
    },
  };
}
