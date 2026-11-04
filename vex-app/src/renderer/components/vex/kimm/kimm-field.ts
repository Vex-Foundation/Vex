/**
 * HER GLYPH FIELD, THE MODEL (docs/design/H3-DESKTOP.md sections 1.5, 3.2 and
 * 3.5; plan row S4-17): the falling V, X and E behind her figure on her blue
 * ground. Pure: columns of glyphs that fall at their own pace, stepped by a
 * fixed clock, from one seeded sequence, so the same step always draws the
 * same field (a still frame is a step, a capture is repeatable). The canvas
 * that draws it, the run gate and the still frame are `KimmField.tsx`.
 *
 * MEASURED from `h3-merged__welcome-open-1440`: glyphs about 14px high in a
 * mono face on a 15px pitch across and 20px down, light on the ground, the
 * columns falling apart from one another, some empty. Open: the source's own
 * speeds, density and face, settled by the mockup source.
 */

/** The glyphs she falls in. */
export const KIMM_FIELD_GLYPHS = ["V", "X", "E"] as const;

/** The field's cell: a column's pitch across, a row's pitch down (CSS px). */
export const KIMM_FIELD_CELL = { width: 15, height: 20 } as const;

/**
 * The field's step: 10 a second, K2's idle step (MOTION-POLICY.md, "Kimm's
 * glyph field"). One frame never advances it by more than
 * `KIMM_FIELD_CLOCK_CAP_MS`, so a stalled window resumes where it stopped.
 */
export const KIMM_FIELD_STEP_MS = 100;
export const KIMM_FIELD_CLOCK_CAP_MS = 250;

/** The step the still frame paints: the field as it stands after a few seconds. */
export const KIMM_FIELD_STILL_STEP = 48;

/** One falling run of glyphs in a column. */
interface Stream {
  /** The row its head stands on, fractional. */
  head: number;
  /** Rows per step. */
  speed: number;
  /** How many glyphs trail behind the head. */
  length: number;
  /** Steps to wait before it falls again, once it has left the field. */
  wait: number;
}

/** A glyph to draw: its cell and how strongly it shows (0 to 1). */
export interface KimmGlyph {
  readonly column: number;
  readonly row: number;
  readonly glyph: (typeof KIMM_FIELD_GLYPHS)[number];
  readonly alpha: number;
}

/** mulberry32: a small seeded sequence, so every field is the same field. */
function sequence(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class KimmFieldModel {
  readonly columns: number;
  readonly rows: number;
  #streams: Stream[];
  #glyphs: (typeof KIMM_FIELD_GLYPHS)[number][][];
  #random: () => number;
  #step = 0;

  constructor(width: number, height: number, seed = 0x5eed) {
    this.columns = Math.max(1, Math.floor(width / KIMM_FIELD_CELL.width));
    this.rows = Math.max(1, Math.ceil(height / KIMM_FIELD_CELL.height));
    this.#random = sequence(seed);
    this.#glyphs = Array.from({ length: this.columns }, () =>
      Array.from({ length: this.rows }, () => this.#pick()),
    );
    this.#streams = Array.from({ length: this.columns }, () => this.#stream(true));
  }

  /** The steps taken since the field began. */
  get step(): number {
    return this.#step;
  }

  /** Advance by `steps` fixed steps. */
  advance(steps: number): void {
    for (let i = 0; i < steps; i += 1) {
      this.#step += 1;
      this.#streams.forEach((stream, column) => {
        if (stream.wait > 0) {
          stream.wait -= 1;
          return;
        }
        stream.head += stream.speed;
        // Now and then a glyph in the run changes, as the field flickers.
        if (this.#random() < 0.08) {
          const row = Math.floor(this.#random() * this.rows);
          const cells = this.#glyphs[column];
          if (cells !== undefined) cells[row] = this.#pick();
        }
        if (stream.head - stream.length > this.rows) this.#streams[column] = this.#stream(false);
      });
    }
  }

  /** The glyphs that show now, tail faintest, head brightest. */
  glyphs(): KimmGlyph[] {
    const out: KimmGlyph[] = [];
    this.#streams.forEach((stream, column) => {
      if (stream.wait > 0) return;
      const head = Math.floor(stream.head);
      for (let k = 0; k < stream.length; k += 1) {
        const row = head - k;
        if (row < 0 || row >= this.rows) continue;
        const glyph = this.#glyphs[column]?.[row];
        if (glyph === undefined) continue;
        out.push({ column, row, glyph, alpha: 0.75 * (1 - k / stream.length) + 0.1 });
      }
    });
    return out;
  }

  #pick(): (typeof KIMM_FIELD_GLYPHS)[number] {
    return KIMM_FIELD_GLYPHS[Math.floor(this.#random() * KIMM_FIELD_GLYPHS.length)] ?? "V";
  }

  #stream(first: boolean): Stream {
    const length = 3 + Math.floor(this.#random() * 8);
    return {
      // The first runs start anywhere in the field, later ones above it.
      head: first ? this.#random() * (this.rows + length) : -1,
      speed: 0.15 + this.#random() * 0.35,
      length,
      // Some columns rest: the field is never a wall of glyphs.
      wait: Math.floor(this.#random() * (first ? 12 : 25)),
    };
  }
}
