/**
 * The model cell's glyph and key frame (docs/design/H3-DESKTOP.md section
 * 1.8: the composer row's first cell, "the model's glyph: the model choice").
 *
 * H3 draws the model vendor's mark there. Desktop draws the mark of WHO
 * SERVES the model, the one it already wears wherever a provider is named
 * (`ProviderMark`: the vx disc for Vex Inference, OpenRouter's one-ink mark),
 * so the cell claims nothing the catalogue does not say. A provider this
 * build does not know draws the line model glyph and claims no provider.
 * Decoration either way: the key's accessible name says the model and its
 * provider in words.
 *
 * Both keys that can sit in the cell share its frame: the model menu in an
 * agent session (`ComposerModelMenu`) and the display-only key that opens
 * Settings elsewhere (`ComposerSeats`). The frame is the cell
 * (`.vex-composer-model`, console.css); focus is the 2px ink ring inside it
 * (section 2.4).
 */

import type { JSX } from "react";
import type { ProviderName } from "@shared/schemas/provider.js";
import { ProviderMark } from "../../../components/common/ProviderMark.js";
import { LineIcon } from "../../../components/icons/line/index.js";

/** The glyph's box in the 75 x 72 cell. */
export const MODEL_GLYPH_PX = 20;

/** The model cell's key frame: the cell itself, the ring inside it. */
export const MODEL_CELL_KEY_CLASS =
  "vex-composer-model transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus";

export function ComposerModelGlyph({
  provider,
}: {
  readonly provider: ProviderName | null;
}): JSX.Element {
  return provider === null ? (
    <LineIcon name="model" size={MODEL_GLYPH_PX} />
  ) : (
    <ProviderMark provider={provider} size={MODEL_GLYPH_PX} />
  );
}
