/**
 * VexIcon — the renderer's single icon rendering contract.
 *
 * Every icon in the shell is drawn through this component, so the stroke
 * weight, default size, and pass-through props are decided in ONE place
 * instead of at ~50 call sites. The icon itself travels as DATA (`icon={...}`)
 * rather than as a JSX element, which is what lets maps like
 * `toolGlyph.ts` / `wizard-icons.ts` keep a plain glyph value per key.
 *
 * Underneath this is `lucide-react` (`components.json` already declares
 * `"iconLibrary": "lucide"`). Nothing outside this folder imports the icon
 * vendor directly — swapping the vendor again should be a change to this
 * folder and nothing else.
 *
 * `strokeWidth` defaults to 1.75: lucide's own default of 2 reads heavier than
 * the shell's hairline register at the 12–16px sizes used here.
 */

import type { ComponentPropsWithoutRef, JSX } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * A single icon, as a value. This is the type to use for icon fields on
 * config objects and component props (`readonly icon: IconGlyph`).
 */
export type IconGlyph = LucideIcon;

type IconSvgProps = Omit<
  ComponentPropsWithoutRef<LucideIcon>,
  "size" | "strokeWidth" | "color"
>;

export interface VexIconProps extends IconSvgProps {
  /** The glyph to draw — imported from `./icon-glyphs.js`. */
  readonly icon: IconGlyph;
  /** Rendered edge length in px. */
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly color?: string;
}

export function VexIcon({
  icon: Glyph,
  size = 24,
  strokeWidth = 1.75,
  ...svgProps
}: VexIconProps): JSX.Element {
  return <Glyph size={size} strokeWidth={strokeWidth} {...svgProps} />;
}
