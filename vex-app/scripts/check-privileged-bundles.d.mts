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
