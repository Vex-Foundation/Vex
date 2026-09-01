/**
 * Explicit registration of zod's English locale.
 *
 * zod 4.4.3 declares `"sideEffects": false` in its package.json, and its
 * classic entrypoint registers the English error map as a MODULE-LEVEL side
 * effect (`node_modules/zod/v4/classic/external.js:10` -> `config(en());`).
 * Rollup/rolldown is therefore free to drop that statement when it bundles
 * `zod`, and it does: every bundled process then falls back to zod core's
 * generic `"Invalid input"` for every issue, so a model or a user is told
 * nothing about WHY the value was rejected. Measured in production: 32 stored
 * tool outputs carried the generic message and zero carried a specific one.
 *
 * The fix is an EXPLICIT call from each composition root. A bare
 * side-effect-only import of this module would be dropped by exactly the same
 * tree-shaking, so every root calls `registerZodLocale()` directly.
 *
 * Survival in the privileged bundles is enforced after build by the
 * "zod english locale registered" check in
 * `vex-app/scripts/check-privileged-bundles.mjs`, which greps the emitted
 * chunks for `ZOD_LOCALE_MARKER` and for the English locale's own text.
 */

import { z } from "zod";

/**
 * Distinctive literal that exists only because `registerZodLocale` is reachable
 * from a bundle entry. It must stay a plain inline string literal that no
 * minifier can fold away.
 *
 * ITS ONE REFERENCE IN THIS MODULE IS THE ASSIGNMENT INSIDE
 * `registerZodLocale`, AND THAT IS THE WHOLE GATE. The marker used to be read
 * by the PROBE as well, and the probe is reachable without registration ever
 * happening - so a bundle that called `probeZodLocale()` and never
 * `registerZodLocale()` still carried the literal and passed the post-build
 * check. That gate proved the string had been compiled in, which was never the
 * question. Now the literal survives tree-shaking only if the registration
 * body does, so its presence in a chunk IS registration reachability.
 *
 * Consequence for anyone editing this file: do NOT reference
 * `ZOD_LOCALE_MARKER` from any other function here. Read
 * {@link ZodLocaleProbe.marker} instead, which is null exactly when
 * registration has not run.
 */
export const ZOD_LOCALE_MARKER = "vex-zod-locale:en";

/** Message zod core produces when no locale error map is registered. */
const GENERIC_ZOD_MESSAGE = "Invalid input";

/**
 * The sample value the probe parses. Deliberately NOT the marker: a bundle
 * that only probes must not be able to carry it (see {@link ZOD_LOCALE_MARKER}).
 */
const PROBE_SAMPLE = "zod-locale-probe";

/**
 * Registration state, written ONLY by {@link registerZodLocale}: null until it
 * runs, the marker afterwards. One variable carries both the idempotence flag
 * and the marker, so there is no second place the literal could leak in from.
 */
let registrationMarker: string | null = null;

/**
 * Register the English locale on zod's global config. Idempotent: safe to call
 * from several roots inside one process (main imports modules that preload
 * also imports, and a re-register is a plain overwrite of the same map).
 */
export function registerZodLocale(): void {
  if (registrationMarker !== null) return;
  z.config(z.locales.en());
  registrationMarker = ZOD_LOCALE_MARKER;
}

/** Result of the boot-time self-check. */
export interface ZodLocaleProbe {
  /**
   * The registration marker, or null when `registerZodLocale()` never ran in
   * this process. A caller logging it makes the fact greppable in a running
   * app; it is NOT how the built artifact is gated (see the marker's own doc).
   */
  readonly marker: string | null;
  /** False when zod is still emitting the generic core message. */
  readonly localized: boolean;
  /** The message the probe schema actually produced. */
  readonly sampleMessage: string;
}

/**
 * Parse a value that must fail `z.array(z.string()).max(0)` and return the
 * resulting issue message. Exported only as the injection seam for tests.
 */
export function readZodLocaleSampleMessage(): string {
  const parsed = z.array(z.string()).max(0).safeParse([PROBE_SAMPLE]);
  if (parsed.success) return "";
  const [issue] = parsed.error.issues;
  return issue?.message ?? "";
}

/**
 * Boot-time self-check: does a real zod parse produce a localized message?
 * Pure - it never logs and never throws. The caller decides how to report,
 * because main, preload and renderer have different reporting owners.
 */
export function probeZodLocale(
  readSampleMessage: () => string = readZodLocaleSampleMessage,
): ZodLocaleProbe {
  const sampleMessage = readSampleMessage();
  return {
    marker: registrationMarker,
    localized: sampleMessage !== GENERIC_ZOD_MESSAGE && sampleMessage !== "",
    sampleMessage,
  };
}
