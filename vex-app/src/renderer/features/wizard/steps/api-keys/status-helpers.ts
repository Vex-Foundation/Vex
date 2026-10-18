/**
 * ApiKeysStep status helpers - pure mappers from envState booleans to
 * `ProviderCard` status words.
 *
 * Per the step's secret-input contract, no key value ever round-trips:
 * the words derive only from the configured/partial/missing flags that
 * `envState.apiKeys` already exposes. Kept pure (no React, no IPC) so the
 * component owns rendering and these stay trivially testable.
 */

import type { ProviderCardStatus } from "./ProviderCard.js";

export function statusFor(configured: boolean): ProviderCardStatus {
  // Status is a fill and a WORD (the row draws the swatch) - no checkmark glyphs.
  return configured
    ? { tone: "set", label: "Set" }
    : { tone: "unset", label: "Not set" };
}
