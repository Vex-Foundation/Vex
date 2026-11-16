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
import { clampKimmParam, KIMM_LOCK } from "./kimm-lock-tuning.js";
import {
  KIMM_MOMENTS,
  pickMoment,
  type MomentPose,
  type MomentStep,
} from "./kimm-moments.js";

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
/**
 * THE LOCK SCREEN'S REACTIONS (desktop only, lively mode; owner decision 2026-11-15). `react()` takes one of a few
 * typed signals and nothing else (`kimm-lock-signals.ts`: never the password, its length or any content):
 *   - `typing`: her gaze goes to the password field for `typingLookMs` after each key and no idle act starts for
 *     `typingQuietMs`; then she looks back to the pointer or to centre;
 *   - `shown` (the password is visible): she looks away, down and to her side, eyes nearly shut (`avertShut`), her
 *     head turned `avertTilt` degrees, and plays no idle act, until `hidden`. The model has no hand over her eyes, so
 *     she does not peek instead;
 *   - `failed`: a short head shake (`shakeDeg` at most, `shakeCycles` in `shakeMs`, fading out) and her refused mood
 *     (Cloud's `refused`: arms crossed, 3.4 s);
 *   - `unlocked`: a happy beat, Cloud's `done` (her V sign, a smile and a hop), played as the curtain lifts: it adds no
 *     wait to the unlock;
 * and, lively, a pointer resting over her panel tilts her head `hoverTilt` degrees with Cloud's hover smile.
 */
export const KIMM_REACT = {
  typingLookMs: 1200,
  typingQuietMs: 3000,
  avertShut: 0.85,
  avertTilt: KIMM_LOCK.avertTilt,
  shakeMs: 900,
  shakeDeg: KIMM_LOCK.shakeDeg,
  shakeCycles: 2,
  hoverTilt: KIMM_LOCK.hoverTilt,
} as const;

/**
 * What `react()` takes: a signal, never content. The first seven are the lock screen's words
 * (`kimm-lock-signals.ts`); `greet`, `sleep`, `wake`, `night` and `day` come from her panel's own life
 * (`use-kimm-lock-life.ts`).
 */
export type KimmReaction =
  | "typing"
  | "shown"
  | "hidden"
  | "failed"
  | "unlocked"
  | "focus"
  | "blur"
  | "greet"
  | "sleep"
  | "wake"
  | "night"
  | "day";

/**
 * THE LOCK SCREEN'S LIFE (desktop only, lively mode; owner decision 2026-11-15). Off in the card.
 *   - GREETING (`greet`): a hop, a smile and a head tilt toward the viewer for `greetViewerMs`, then her gaze settles
 *     on the password field, `greetMs` in all. Typing, Show, a refusal or the unlock end it at once; focus waits for it.
 *   - LEANING IN (`focus`, `typing`): she leans toward the form (body `leanBody`, head `leanHead` degrees toward the
 *     field) and steps a little closer (up to `leanZoom` of her size, about her face), eased with `leanTauS`; she eases
 *     back on `blur`, or `leanHoldMs` after the last key or focus.
 *   - SLEEPY (`sleep`, `wake`): her eyes half closed (`sleepShut`), her sway at `sleepSwayRate` of its pace, her breath
 *     `sleepBreath` slower, a small yawn-like head drop every `yawnGapMs`, no moments; eased in over `sleepTauS`.
 *     `wake` perks her up: a small hop and a smile for `perkMs`.
 *   - NIGHT (`night`, `day`): a calmer idle, her sway at `nightSwayRate`, her bob at `nightBob`, her moments every
 *     `nightActGapMs` (fewer).
 * THE PRIORITY, highest first: the unlock's happy beat, a refusal, the password shown, typing and focus, the
 * greeting, sleepiness, the idle moments. A higher one ends or holds the lower ones: the beat, a refusal and Show each
 * end the greeting and stand her back from her lean; typing ends the greeting, and typing and focus hold the moments
 * back, the lean waiting for the greeting to end; while
 * she is sleepy or greeting, no moment starts. The depth (`kimm-parallax.ts`) is a layer of its own and adds to all.
 */
export const KIMM_LIFE = {
  greetMs: 2000,
  greetViewerMs: 1200,
  greetHop: KIMM_LOCK.greetHop,
  greetTilt: KIMM_LOCK.greetTilt,
  leanHoldMs: 4000,
  leanTauS: 0.35,
  leanZoom: KIMM_LOCK.leanZoom,
  leanBody: KIMM_LOCK.leanBody,
  leanHead: KIMM_LOCK.leanHead,
  sleepTauS: 1.2,
  sleepShut: 0.5,
  sleepSwayRate: 0.5,
  sleepBreath: 0.6,
  yawnGapMs: [9000, 15000] as const,
  yawnMs: 1800,
  perkMs: 900,
  nightSwayRate: 0.75,
  nightBob: 0.7,
  nightActGapMs: KIMM_LOCK.nightActGapMs,
} as const;

/* The amplitudes and cadences above and below come from the lock screen's one tuning knob (`kimm-lock-tuning.ts`,
   `KIMM_LOCK` at `KIMM_LOCK_INTENSITY`); the timings that are not amplitudes stay here. */
export const KIMM_LIVELY = {
  sway: KIMM_LOCK.sway,
  bobPx: KIMM_LOCK.bobPx,
  firstActMs: 2000,
  actGapMs: KIMM_LOCK.actGapMs,
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
  /** DESKTOP, the lock screen: how much nearer she has stepped (1: her own size; `KIMM_LIFE.leanZoom` at most). */
  readonly zoom: number;
  /** DESKTOP, the lock screen: how sleepy she is, 0 to 1 (her blink reads it). */
  readonly sleep: number;
  /** DESKTOP, the lock screen: her blink rate's multiple (`KIMM_LOCK.blink`; 1 in the card). */
  readonly blink: number;
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

/** The hand swap (`kimm.js:195-203`): 340 ms, 260 ms into or out of crossed arms; a pose holds 650 ms, rest 350. */
export const KIMM_HAND_MS = { swap: 340, crossed: 260, hold: 650, rest: 350 };

/**
 * DESKTOP: THE HAND SWAP IS A CUT, NEVER A CROSSFADE (owner decision 2026-11-15, the "ghost arm"). Measured on the
 * shipped model: each hand toggle (`T4` to `T8`) is a straight opacity crossfade between two drawings, so at a value
 * v the raised arm draws at v and the rest arm (with its sleeve) at 1 - v. Any value between 0 and 1 draws both arms,
 * see-through; there is no in-between drawing to fade through. So the swap keeps Cloud's clock (the 340 or 260 ms leg,
 * the hold, and the body dip toward the raised side that starts it) but each toggle is exactly 0 or 1 on every frame:
 * the old pose holds until `KIMM_HAND_CUT` of the leg, at the bottom of the dip, and the new one stands from there.
 * The dip hides the cut, and no frame ever shows two arms.
 */
export const KIMM_HAND_CUT = 0.5;

/** How far a hand swap has gone at `u` (0 to 1 of its leg): 0 (the old pose) until the cut, then 1 (the new). */
export function kimmHandBlend(u: number): 0 | 1 {
  return u >= KIMM_HAND_CUT ? 1 : 0;
}

/** The breath's cycle in seconds (ParamBreath = 0.5 + 0.5 sin(2 pi t / 3.4)). */
export const KIMM_BREATH_S = 3.4;

/* an idle act is a one-step moment (`kimm-moments.ts` holds the lock screen's chained ones) */
type ActPose = MomentPose;
type Act = MomentStep;

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
  let act: { readonly name: string; t0: number; readonly steps: readonly Act[]; step: number } | null = null;
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
  let averted = false;
  let shakeT0 = -1e9;
  /* DESKTOP, the lock screen's life (`KIMM_LIFE`) */
  let fieldAt: { readonly x: number; readonly y: number } | null = null;
  let greetT0 = -1e9;
  let leanUntil = 0;
  let lean = 0;
  let sleepGoal = 0;
  let sleep = 0;
  let night = false;
  let perkUntil = 0;
  let nextYawn = 0;
  let yawnT0 = -1e9;
  let swayT = now() / 1000;
  let breathPhase = ((now() / 1000) * 2 * Math.PI) / KIMM_BREATH_S;
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
  /* a step begins: its hand pose and marks (rest when it names none after a step that did), its hop */
  const enterStep = () => {
    if (!act) return;
    const A = act.steps[act.step];
    if (!A) return;
    if (A.mood) {
      setMood(A.mood, A.ms);
      if (A.clean) {
        set("E1", 0);
        set("FeceAngry", 0);
        set("ParamMouthForm", 0.3);
      }
    } else if (act.step > 0 && mood !== "rest") setMood("rest");
    if (A.hop) hop = A.hop * (lively ? KIMM_LOCK.hop : 1);
  };
  const startAct = () => {
    /* DESKTOP, the lock screen: a chained moment, never the one just played */
    if (lively) {
      const name = pickMoment(random, lastAct || null);
      lastAct = name;
      act = { name, t0: now(), steps: KIMM_MOMENTS[name], step: 0 };
      enterStep();
      return;
    }
    const names = actNames.filter((name) => name !== lastAct);
    if (!names.length) return;
    const name = names[Math.floor(random() * names.length)] as KimmActName;
    lastAct = name;
    act = { name, t0: now(), steps: [ACTS[name]], step: 0 };
    enterStep();
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
    /* DESKTOP, the lock screen's life: the greeting, sleepiness, the lean, each eased on her own clock */
    const greetU = (t0 - greetT0) / KIMM_LIFE.greetMs;
    const greeting = lively && greetU >= 0 && greetU < 1;
    sleep += (sleepGoal - sleep) * (1 - Math.exp(-dt / KIMM_LIFE.sleepTauS));
    const leanGoal =
      lively && t0 < leanUntil && !averted && mood !== "no" && mood !== "v" && !greeting ? 1 : 0;
    lean += (leanGoal - lean) * (1 - Math.exp(-dt / KIMM_LIFE.leanTauS));
    if (
      !active &&
      !act &&
      mood === "rest" &&
      t0 > nextIdle &&
      !speaking &&
      options.idle !== false
    )
      if (!averted && !greeting && sleep < 0.5) startAct();
    let P: ActPose = {};
    let env = 0;
    if (act) {
      let A = act.steps[act.step];
      let u = A ? (t0 - act.t0) / A.ms : 1;
      /* DESKTOP: a chained moment steps on to its next pose */
      while (A && u >= 1 && act.step + 1 < act.steps.length) {
        act.t0 += A.ms;
        act.step += 1;
        enterStep();
        A = act.steps[act.step];
        u = A ? (t0 - act.t0) / A.ms : 1;
      }
      if (!A || u >= 1) {
        act = null;
        const [gapMin, gapMax] = lively
          ? night
            ? KIMM_LIFE.nightActGapMs
            : KIMM_LIVELY.actGapMs
          : ([3500, 7000] as const);
        nextIdle = t0 + gapMin + random() * (gapMax - gapMin);
      } else {
        env = smoothstep(0, 0.2, u) * (1 - smoothstep(0.8, 1, u));
        if (A.pose) P = A.pose(u);
      }
    }
    /* sleepy: an occasional yawn-like head drop */
    if (lively && !RM && sleep > 0.8 && t0 > nextYawn) {
      yawnT0 = t0;
      nextYawn = t0 + KIMM_LIFE.yawnGapMs[0] + random() * (KIMM_LIFE.yawnGapMs[1] - KIMM_LIFE.yawnGapMs[0]);
    }
    const yawnU = (t0 - yawnT0) / KIMM_LIFE.yawnMs;
    const yawn = yawnU >= 0 && yawnU < 1 ? Math.sin(yawnU * Math.PI) : 0;
    const greetEnv = greeting ? Math.sin(greetU * Math.PI) : 0;
    /* DESKTOP, lively: the moments' angles at the knob's `gesture` (the card's acts at Cloud's own) */
    const g = lively ? KIMM_LOCK.gesture : 1;
    const ax = (P.ax ?? 0) * env * g + KIMM_LIFE.leanHead * lean;
    const ay = (P.ay ?? 0) * env * g - 12 * yawn;
    const az = (P.az ?? 0) * env * g + KIMM_LIFE.greetTilt * greetEnv - 3 * lean;
    const bz = (P.bz ?? 0) * env * g - 2 * lean;
    const by = (P.by ?? 0) * env * g;
    const mouth = (P.mouth ?? 0) * env + 0.55 * yawn;
    if (focus && t0 > focusUntil) focus = null;
    /* where to look: a target, else the pointer if it moved in the last 5 s (3 s lively), else a slow drift
       (`kimm.js:170-177`) */
    const hx = host.left + host.width * 0.5;
    const hy = host.top + host.height * 0.18;
    const drift = lively ? KIMM_LOCK.drift : 1;
    let tx = hx + Math.sin(t * 0.35) * 60 * drift;
    let ty = hy + 40 + Math.sin(t * 0.23) * 24 * drift;
    const lookHold = lively ? KIMM_LIVELY.lookHoldMs : 5000;
    if (options.pointer !== false && t0 - lastMove < lookHold && px >= 0) {
      tx = px;
      ty = py;
    }
    /* DESKTOP: the lock screen's named places, and the greeting's gaze (the viewer, then the field) */
    const placeOf = (name: string): KimmLookTarget | null => {
      if (name === "field") return fieldAt;
      if (name === "viewer") return { x: hx, y: hy + 40 };
      if (name === "left") return { x: hx - 600, y: hy + 60 };
      if (name === "right") return { x: hx + 600, y: hy + 60 };
      return targetOf(name);
    };
    const greetLook = greeting
      ? t0 - greetT0 < KIMM_LIFE.greetViewerMs || fieldAt === null
        ? placeOf("viewer")
        : fieldAt
      : null;
    const fo = focus ?? greetLook ?? (P.to ? placeOf(P.to) : null);
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
    /* DESKTOP, the lock screen: while the password shows she looks away, down and to her side, never toward it */
    if (averted) {
      tx = hx - 520;
      ty = hy + 300;
    }
    const turn = averted ? -KIMM_REACT.avertTilt : lively && hover ? KIMM_REACT.hoverTilt : 0;
    const dx = clamp((tx - hx) / 520, -1, 1);
    const dy = clamp((ty - hy) / 420, -1, 1);
    const sw = RM ? 0 : lively ? KIMM_LIVELY.sway : 1;
    /* DESKTOP, lively: the sways run on their own clock, slower when sleepy or at night (the card reads `t`) */
    const rate =
      (1 - (1 - KIMM_LIFE.sleepSwayRate) * sleep) * (night ? KIMM_LIFE.nightSwayRate : 1);
    swayT += dt * rate;
    breathPhase += (dt * 2 * Math.PI) / (KIMM_BREATH_S * (1 + KIMM_LIFE.sleepBreath * sleep));
    const st = lively ? swayT : t;
    const swx = sw * (2.2 * Math.sin(st * 0.47) + 1.3 * Math.sin(st * 0.83 + 2));
    const swz = sw * (1.8 * Math.sin(st * 0.31 + 1) + 0.9 * Math.sin(st * 0.71));
    const swb = sw * 1.3 * Math.sin(st * 0.29 + 0.5);
    set("ParamAngleX", clamp(dx * 28 * (lively ? KIMM_LOCK.lookGain : 1) + ax + swx, -30, 30));
    set(
      "ParamAngleY",
      -dy * 22 +
        (mood === "think" ? -6 : 0) +
        ay +
        sw * Math.sin(st * 0.37) * 1.5,
    );
    set("ParamAngleZ", -dx * 6 + (mood === "think" ? 7 : 0) + az + swz + turn);
    set("ParamBodyAngleX", dx * 9 + swb * 1.4 + KIMM_LIFE.leanBody * lean);
    set("ParamBodyAngleY", -dy * 4 + by);
    set("ParamBodyAngleZ", -dx * 3 + bz + swb);
    set("ParamEyeBallX", dx * 0.9);
    set("ParamEyeBallY", -dy * 0.8);
    if (mood === "rest") {
      set("ParamMouthForm", hover ? 0.8 : 0.15);
      set("ParamEyeRSmile", hover ? 0.5 : 0);
    }
    /* DESKTOP: a moment's mouth and smile, the greeting's smile and the perk after waking */
    const face = lively ? KIMM_LOCK.face : 1;
    if (env > 0.3 && P.form !== undefined) set("ParamMouthForm", clamp(P.form * face, -1, 1));
    if (env > 0.3 && P.smile !== undefined) set("ParamEyeRSmile", clamp(P.smile * face, 0, 1));
    if (greeting || t0 < perkUntil) {
      set("ParamMouthForm", clamp(0.9 * face, -1, 1));
      set("ParamEyeRSmile", clamp(0.65 * face, 0, 1));
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
    /* hands, as the model was rigged (`kimm.js:191-203`): one clock for all five toggles, 340 ms (260 ms into or out
       of crossed arms), a 650 ms hold per pose, and a dip toward the raised side. DESKTOP: a cut at the leg's middle,
       never a crossfade (`KIMM_HAND_CUT`): every toggle is 0 or 1 on every frame, so no frame draws two arms */
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
      const e = kimmHandBlend(u);
      for (const hand of KIMM_HANDS) {
        const from = hands.from[hand] ?? 0;
        const goal = hand === hands.want ? 1 : 0;
        cur[hand] = (from >= 0.5 ? 1 : 0) + (goal - (from >= 0.5 ? 1 : 0)) * e;
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
    const actShut = P.shut === true ? 1 : typeof P.shut === "number" ? P.shut * env : 0;
    const shutGoal = Math.min(
      1,
      Math.max(actShut, averted ? KIMM_REACT.avertShut : 0, KIMM_LIFE.sleepShut * sleep + 0.4 * yawn),
    );
    shut += (shutGoal - shut) * (1 - Math.exp(-dt / 0.07));
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
    const breath = lively ? Math.sin(breathPhase) : Math.sin((t * 2 * Math.PI) / KIMM_BREATH_S);
    params.set("ParamBreath", 0.5 + 0.5 * breath);
    /* DESKTOP, the lock screen's failed unlock: a short head shake on top of the springs, fading out */
    const since = t0 - shakeT0;
    if (!RM && since >= 0 && since < KIMM_REACT.shakeMs) {
      const u = since / KIMM_REACT.shakeMs;
      const shake = KIMM_REACT.shakeDeg * Math.sin(u * 2 * Math.PI * KIMM_REACT.shakeCycles) * (1 - u);
      params.set("ParamAngleX", clamp((params.get("ParamAngleX") ?? 0) + shake, -30, 30));
    }
    /* DESKTOP, lively: every parameter inside the model's own limits, whatever the knob asks */
    if (lively) for (const [id, value] of params) params.set(id, clampKimmParam(id, value));
    for (const [id, value] of Object.entries(raw)) params.set(id, value);
    /* lively: a slow bounce with her breath, up to `bobPx` up at the top of each breath */
    const bobScale = (night ? KIMM_LIFE.nightBob : 1) * (1 - 0.6 * sleep);
    const bob = lively && !RM ? -KIMM_LIVELY.bobPx * bobScale * (0.5 + 0.5 * breath) : 0;
    const zoom = lively && !RM ? 1 + KIMM_LIFE.leanZoom * lean : 1;
    return { params, y: RM ? 0 : jy + bob, shut, t, zoom, sleep, blink: lively ? KIMM_LOCK.blink : 1 };
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
    /**
     * DESKTOP, the lock screen: a reaction to a typed signal (`KIMM_REACT`). `at` is where the password field stands
     * in client px, for `typing`; never an element, so nothing here can read the field.
     */
    react: (signal: KimmReaction, at?: { readonly x: number; readonly y: number }) => {
      const t = now();
      if (at) fieldAt = { x: at.x, y: at.y };
      switch (signal) {
        case "typing":
          if (!averted && at) look({ x: at.x, y: at.y }, KIMM_REACT.typingLookMs);
          nextIdle = Math.max(nextIdle, t + KIMM_REACT.typingQuietMs);
          greetT0 = -1e9;
          leanUntil = t + KIMM_LIFE.leanHoldMs;
          break;
        case "focus":
          /* the field is focused as the screen opens: the greeting plays on, and she leans in once it ends */
          leanUntil = t + KIMM_LIFE.leanHoldMs;
          nextIdle = Math.max(nextIdle, t + KIMM_REACT.typingQuietMs);
          break;
        case "blur":
          leanUntil = 0;
          break;
        case "greet":
          if (averted) break;
          greetT0 = t;
          hop = KIMM_LIFE.greetHop;
          act = null;
          nextIdle = Math.max(nextIdle, t + KIMM_LIFE.greetMs + 600);
          break;
        case "sleep":
          sleepGoal = 1;
          act = null;
          nextYawn = t + 4000;
          break;
        case "wake":
          if (sleepGoal > 0 || sleep > 0.2) {
            hop = 0.5 * KIMM_LOCK.hop;
            perkUntil = t + KIMM_LIFE.perkMs;
          }
          sleepGoal = 0;
          nextIdle = Math.max(nextIdle, t + 1500);
          break;
        case "night":
          night = true;
          break;
        case "day":
          night = false;
          break;
        case "shown":
          averted = true;
          act = null;
          focus = null;
          greetT0 = -1e9;
          break;
        case "hidden":
          averted = false;
          nextIdle = Math.max(nextIdle, t + 1500);
          break;
        case "failed":
          shakeT0 = t;
          greetT0 = -1e9;
          leanUntil = 0;
          act = null;
          on("refused");
          break;
        case "unlocked":
          averted = false;
          greetT0 = -1e9;
          leanUntil = 0;
          act = null;
          on("done");
          /* the beat's hop at the knob's size (Cloud's `done` hops 1) */
          hop = KIMM_LOCK.hop;
          break;
      }
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
        averted,
        greeting: lively && now() - greetT0 >= 0 && now() - greetT0 < KIMM_LIFE.greetMs,
        lean,
        sleep,
        sleepy: sleepGoal > 0,
        night,
        step: act?.step ?? null,
        act: act?.name ?? null,
        hands: Object.fromEntries(
          KIMM_HANDS.map((hand) => [hand, Number((cur[hand] ?? 0).toFixed(3))]),
        ) as Record<(typeof KIMM_HANDS)[number], number>,
      };
    },
  };
}
