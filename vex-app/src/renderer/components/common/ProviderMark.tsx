/**
 * Provider mark: the small mark before an inference provider's name. The flat
 * vx disc (`VxToken`, the product mark beside Vex's messages) stands for Vex
 * Inference; OpenRouter's own one-ink mark stands for OpenRouter.
 *
 * This is the ONE renderer, shared by the provider choice (onboarding and
 * Settings) and the composer's model key, so a provider wears the same mark
 * everywhere. It is decorative: the caller's visible text or accessible name
 * names the provider.
 *
 * `size` is the square box. The vx disc fills it; OpenRouter's glyph draws at
 * four fifths of it (16 in the 20 box of the provider choice), centred. The
 * OpenRouter mark is the package's "mono" variant, drawn in `currentColor`,
 * because its default variant paints a fixed ink that vanishes on one of the
 * two papers (measured in the installed `@thesvg/react` sources).
 */

import type { JSX } from "react";
import { Openrouter } from "@thesvg/react";
import type { ProviderName } from "@shared/schemas/provider.js";
import { VxToken } from "../ui/vx-token.js";

/** The provider names users read, beside the mark and in accessible names. */
export const PROVIDER_DISPLAY_NAME: Readonly<Record<ProviderName, string>> = {
  vexcloud: "Vex Inference",
  openrouter: "OpenRouter",
};

export function ProviderMark({
  provider,
  size,
}: {
  readonly provider: ProviderName;
  readonly size: number;
}): JSX.Element {
  switch (provider) {
    case "vexcloud":
      return (
        <span className="inline-flex shrink-0" data-vex-provider-mark="vexcloud">
          <VxToken size={size} />
        </span>
      );
    case "openrouter": {
      const glyph = Math.round((size * 4) / 5);
      return (
        <span
          className="inline-flex shrink-0 items-center justify-center"
          style={{ width: size, height: size }}
          data-vex-provider-mark="openrouter"
        >
          <Openrouter
            variant="mono"
            width={glyph}
            height={glyph}
            aria-hidden
            focusable={false}
            data-vex-brand-mark="openrouter"
          />
        </span>
      );
    }
  }
}
