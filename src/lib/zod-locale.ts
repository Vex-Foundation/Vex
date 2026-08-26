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
 * from a bundle entry. The post-build gate greps emitted chunks for it, so it
 * must stay a plain inline string literal that no minifier can fold away, and
 * must stay referenced from the exported functions below.
 */
export const ZOD_LOCALE_MARKER = "vex-zod-locale:en";

/** Message zod core produces when no locale error map is registered. */
const GENERIC_ZOD_MESSAGE = "Invalid input";

let registered = false;

/**
 * Register the English locale on zod's global config. Idempotent: safe to call
 * from several roots inside one process (main imports modules that preload
 * also imports, and a re-register is a plain overwrite of the same map).
 */
export function registerZodLocale(): void {
  if (registered) return;
  z.config(z.locales.en());
  registered = true;
}

/** Result of the boot-time self-check. */
export interface ZodLocaleProbe {
  /** Marker string, so a caller's log line is greppable in a built bundle. */
  readonly marker: string;
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
  const parsed = z.array(z.string()).max(0).safeParse([ZOD_LOCALE_MARKER]);
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
    marker: ZOD_LOCALE_MARKER,
    localized: sampleMessage !== GENERIC_ZOD_MESSAGE && sampleMessage !== "",
    sampleMessage,
  };
}
