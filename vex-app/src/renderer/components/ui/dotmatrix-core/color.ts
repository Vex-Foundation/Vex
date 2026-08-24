import type { DotMatrixColorPreset } from "./types.js";

const DOT_MATRIX_COLOR_PRESETS: Record<
  DotMatrixColorPreset,
  {
    fill: string;
    glow: string;
  }
> = {
  "solid-theme": {
    fill: "var(--color-dot-on)",
    glow: "var(--color-dot-on)"
  },
  // The brand gradient - hover -> primary -> deep steps of the accent
  // family (tokens.css aliases, so it re-points per theme). The ONLY
  // gradient preset in the single-accent design language.
  "grad-cobalt": {
    fill: "linear-gradient(140deg, var(--color-accent-hover) 0%, var(--color-accent-primary) 48%, var(--color-accent-brand) 100%)",
    glow: "var(--color-accent-primary)"
  }
};

export function resolveDmxColorTokens(color: string, colorPreset?: DotMatrixColorPreset): {
  resolvedColor: string;
  dotFill: string;
} {
  if (!colorPreset) {
    return { resolvedColor: color, dotFill: color };
  }

  const preset = DOT_MATRIX_COLOR_PRESETS[colorPreset];
  if (!preset) {
    return { resolvedColor: color, dotFill: color };
  }

  return { resolvedColor: preset.glow, dotFill: preset.fill };
}
