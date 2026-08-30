export interface PrivilegedBundleCheck {
  readonly label: string;
  run(root: string): void;
}

export interface ZodLocaleBundleInput {
  /** Bundle-set name as reported in violations, e.g. `dist/renderer/assets`. */
  readonly name: string;
  /** Full text of every emitted chunk in the set. */
  readonly sources: ReadonlyArray<string>;
}

export interface ZodLocaleBundleVerdict {
  readonly ok: boolean;
  readonly violations: string[];
}

export function evaluateZodLocaleBundles(
  bundles: ReadonlyArray<ZodLocaleBundleInput>,
): ZodLocaleBundleVerdict;

export function findBareFilenameHits(
  file: string,
): ReadonlyArray<{ readonly line: number; readonly text: string }>;

export const privilegedBundleChecks: ReadonlyArray<PrivilegedBundleCheck>;

export interface HighlightWorkerBundleInput {
  /** The `content` of the built renderer's Content-Security-Policy meta tag. */
  readonly csp: string;
  /** Every file name in `dist/renderer/assets/`. */
  readonly assetFileNames: ReadonlyArray<string>;
  /** Full text of every emitted `.js` chunk in that directory. */
  readonly bundleSources: ReadonlyArray<string>;
}

export interface HighlightWorkerBundleVerdict {
  readonly ok: boolean;
  readonly violations: string[];
}

/**
 * The marker string that proves the Studio highlighter PORT is in the bundle.
 * Lives in the same module as the `new Worker(new URL(...))` factory, so it
 * cannot be present without the factory being present.
 */
export const HIGHLIGHT_PORT_MARKER: string;

export function evaluateHighlightWorkerBundle(
  input: HighlightWorkerBundleInput,
): HighlightWorkerBundleVerdict;
