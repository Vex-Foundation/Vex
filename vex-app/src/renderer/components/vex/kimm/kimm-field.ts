/**
 * HER GLYPH FIELD, THE RECIPE AND THE GATE (docs/design/H3-DESKTOP.md
 * sections 1.5, 3.2 and 3.5; MOTION-POLICY.md "Kimm's glyph field"). The
 * field behind her figure is VEX Cloud's: the landing's Gradient ASCII
 * recipe (Cloud's `kimm-field.ts`, its mockup's `stage.js:86-88`), drawn by
 * the port in `gradient-ascii.ts` and mounted by `KimmField.tsx`. Pure: the
 * options the port is mounted with, and whether it runs.
 *
 * TWO MODES, as Cloud's (its third, `baked`, is her ground's still image,
 * kimm.css, which stays where WebGL2 is missing):
 *   - `live`: her section over the Vex column; it runs while she is open and
 *     on screen, and holds its frame in the strip;
 *   - `frame`: one still frame, no ticker: her band under 1024 (Cloud's 768
 *     to 1023 layout).
 * Reduced motion and Save-Data hold either at one frame.
 */

/** The options of the port (`mountGradientAscii(container, options)`), as Cloud types them. */
export interface GradientAsciiOptions {
  readonly colors?: readonly string[];
  readonly shape?: "horizon" | "pinch" | "rise" | "eclipse";
  readonly characters?: string;
  readonly cellSize?: number;
  readonly density?: number;
  readonly glyphOpacity?: number;
  readonly glow?: number;
  readonly depthOfField?: number;
  readonly flicker?: number;
  readonly softness?: number;
  readonly scale?: number;
  readonly flow?: number;
  readonly speed?: number;
  readonly gradientOpacity?: number;
  readonly grain?: number;
  readonly variation?: number;
  readonly mouseInteraction?: boolean;
  readonly scrambleRadius?: number;
  readonly clickEffect?: "none" | "wave" | "burst";
  readonly intro?: boolean;
  readonly still?: boolean;
  readonly lightMode?: boolean;
  readonly fontFamily?: string;
  readonly dpr?: number;
}

/** How the field is drawn where it stands. */
export type KimmFieldMode = "live" | "frame";

/**
 * The landing's recipe (vex-home `gradient-ascii.js:850`, H3 `stage.js:86-88`,
 * VEX Cloud's `KIMM_FIELD_RECIPE`): ' VEX' in Roboto Mono on a 20 cell,
 * density 0.5, glyphs 0.6, gradient 0.8, the blue palette on the horizon
 * shape, no intro. The palette is the field's own drawing, mixed by the port
 * in its own colour space, not a token of the sheet.
 */
export const KIMM_FIELD_RECIPE = {
  colors: ["#1e3fd8", "#f6f8ff", "#a5d8ff", "#38bdf8"],
  shape: "horizon",
  characters: " VEX",
  cellSize: 20,
  density: 0.5,
  glyphOpacity: 0.6,
  gradientOpacity: 0.8,
  fontFamily: '"Roboto Mono", ui-monospace, monospace',
  intro: false,
} as const satisfies GradientAsciiOptions;

/** What decides whether the field runs. */
export interface KimmFieldGate {
  readonly mode: KimmFieldMode;
  /** Her section is open, as the last press left it. */
  readonly open: boolean;
  /** Reduced motion or Save-Data (`useStillFrame`). */
  readonly still: boolean;
  /** The run gate is open: the field is on screen and the window shown (`RunGate`). */
  readonly onScreen: boolean;
}

/**
 * Whether the field runs: only live, only while she is open, only on screen
 * in a shown window, and never under the still frame. Anything else holds
 * one frame.
 */
export function kimmFieldRuns(gate: KimmFieldGate): boolean {
  return gate.mode === "live" && gate.open && !gate.still && gate.onScreen;
}

/**
 * The port's options: the recipe, held at one frame unless it runs, the
 * pointer's trail only where it may run (Cloud's), at most twice the CSS
 * pixel.
 */
export function kimmFieldOptions(
  mode: KimmFieldMode,
  running: boolean,
  devicePixelRatio: number,
): GradientAsciiOptions {
  return {
    ...KIMM_FIELD_RECIPE,
    still: !running,
    mouseInteraction: mode === "live",
    dpr: Math.min(2, devicePixelRatio || 1),
  };
}
