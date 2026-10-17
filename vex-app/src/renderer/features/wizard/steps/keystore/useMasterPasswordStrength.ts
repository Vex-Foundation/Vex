/**
 * Real password-strength gate for the master-password CREATION flow
 * (`KeystoreStep`, the only consumer). The local secret vault (AES-256-GCM
 * + scrypt) is protected ONLY by this password - there is no OS-keychain
 * second factor - so a weak password is the single offline-brute-force
 * path for a disk thief. A length floor alone does not catch low-entropy
 * passwords like "aaaaaaaaaa" or "password123", so `KeystoreStep` also
 * gates submission on this real zxcvbn estimate.
 *
 * The estimator and its English dictionary are loaded lazily via dynamic
 * `import()` on first mount rather than bundled into the renderer's main
 * chunk, so wizard first paint stays light. The load is memoized at module
 * scope so remounting this step does not re-fetch the chunk.
 *
 * `MIN_ACCEPTABLE_SCORE = 3` is a renderer-only UX gate, not part of
 * `keystoreSetInputSchema` (the main-process floor lives in
 * `PASSWORD_CREATE_MIN`, `@shared/schemas/wizard.js`). A renderer that
 * bypassed this hook and called the IPC directly with a long-but-low-score
 * password would only weaken its own vault - self-custodial, approved
 * design (see the /harness plan for this change).
 */

import { useEffect, useMemo, useState } from "react";
import type { ZxcvbnResult } from "@zxcvbn-ts/core";

export type PasswordStrengthLabel = "weak" | "fair" | "good" | "strong";

export interface PasswordStrengthState {
  /** True once the zxcvbn estimator has finished loading and scored `password`. */
  readonly ready: boolean;
  /** zxcvbn score, 0 (worst) to 4 (best). 0 while not ready or the input is empty. */
  readonly score: number;
  readonly label: PasswordStrengthLabel;
  readonly warning: string | null;
  readonly suggestions: ReadonlyArray<string>;
  /** True once `score >= MIN_ACCEPTABLE_SCORE`. Length is the caller's concern (`PASSWORD_CREATE_MIN`). */
  readonly meetsMinimumScore: boolean;
}

/**
 * zxcvbn's own scoring language: 0 too guessable, 1 very guessable, 2
 * somewhat guessable, 3 safely unguessable, 4 very unguessable. Require
 * "safely unguessable" or better before a new master password is accepted.
 */
export const MIN_ACCEPTABLE_SCORE = 3;

type Estimator = (password: string) => ZxcvbnResult;

let estimatorPromise: Promise<Estimator> | null = null;

function loadEstimator(): Promise<Estimator> {
  estimatorPromise ??= (async () => {
    const [{ ZxcvbnFactory }, common, en] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-en"),
    ]);
    const factory = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
    return (password: string) => factory.check(password);
  })();
  return estimatorPromise;
}

/** Exported for direct unit testing of the score->label mapping table. */
export function labelForScore(score: number): PasswordStrengthLabel {
  if (score >= 4) return "strong";
  if (score >= 3) return "good";
  if (score >= 2) return "fair";
  return "weak";
}

const NOT_READY_STATE: PasswordStrengthState = {
  ready: false,
  score: 0,
  label: "weak",
  warning: null,
  suggestions: [],
  meetsMinimumScore: false,
};

export function useMasterPasswordStrength(
  password: string
): PasswordStrengthState {
  const [estimator, setEstimator] = useState<Estimator | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadEstimator().then((fn) => {
      if (!cancelled) setEstimator(() => fn);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo<PasswordStrengthState>(() => {
    if (estimator === null) return NOT_READY_STATE;
    if (password.length === 0) return { ...NOT_READY_STATE, ready: true };

    const result = estimator(password);
    return {
      ready: true,
      score: result.score,
      label: labelForScore(result.score),
      warning: result.feedback.warning,
      suggestions: result.feedback.suggestions,
      meetsMinimumScore: result.score >= MIN_ACCEPTABLE_SCORE,
    };
  }, [estimator, password]);
}
