/**
 * User-facing copy for each engine-error category.
 *
 * The owner's requirement is that every category the SDK can express produces
 * something a human can act on. The bar this file has to clear is that a
 * provider 429 reads as "provider rate-limited, try again" and never as
 * "Unable to process the message" — including for `unknown`, which must still
 * say something honest rather than nothing.
 *
 * Copy lives beside the vocabulary rather than inside a component, so a new
 * surface (banner, mission card, stream bubble) cannot quietly invent its own
 * wording for the same category. A `Record` keyed by the closed category enum
 * makes an unlabelled category a compile error.
 *
 * NO INTERPOLATED PROVIDER TEXT. The only dynamic value permitted is
 * `retryAfterSeconds`, a bounded integer.
 */

import type {
  EngineErrorCategory,
  EngineErrorRemedy,
} from "./engine-error-classification.js";

export interface EngineErrorCopy {
  /** Short label for the banner heading. Sentence case, no trailing period. */
  readonly title: string;
  /** One sentence saying what happened and what to do about it. */
  readonly body: string;
  /** Whether retrying the same request is worth suggesting. */
  readonly retryable: boolean;
}

const COPY: Readonly<Record<EngineErrorCategory, EngineErrorCopy>> = {
  account: {
    title: "Provider account problem",
    body: "The provider rejected the request because of credit, key, or permission. Check provider setup, then retry.",
    retryable: false,
  },
  capacity: {
    title: "Provider rate-limited or unavailable",
    body: "The provider is rate-limited, overloaded, or unreachable. This usually clears on its own.",
    retryable: true,
  },
  context: {
    title: "Conversation too long",
    body: "This session exceeds the selected model's context window. Compact the session or start a new one, then retry.",
    retryable: false,
  },
  policy: {
    title: "Request refused",
    body: "The provider refused this request on content-policy grounds. Rephrase and retry.",
    retryable: false,
  },
  request: {
    title: "Request rejected",
    body: "The provider rejected the request as invalid or unsupported. Check the selected model in provider setup.",
    retryable: false,
  },
  media: {
    title: "Image could not be used",
    body: "An attached image was rejected by the provider. Remove or replace it, then retry.",
    retryable: false,
  },
  unreadable_response: {
    title: "Provider response unreadable",
    body: "The provider answered, but the response could not be read. This is usually transient.",
    retryable: true,
  },
  unknown: {
    // Honest last resort — it still names WHAT failed, and it does not claim
    // to know why. Silence here was the original defect.
    title: "The provider call failed",
    body: "The request to the inference provider failed and the cause was not reported. Retry; if it repeats, check provider setup.",
    retryable: true,
  },
};

/** Copy for a category. Total by construction over the closed enum. */
export function engineErrorCopy(category: EngineErrorCategory): EngineErrorCopy {
  return COPY[category];
}

/**
 * Retry advice with the provider's own hint folded in when there is one.
 * `retryAfterSeconds` is a bounded integer from the `Retry-After` header — the
 * difference between "try again later" and "try again in 41s".
 */
export function engineErrorRetryHint(
  category: EngineErrorCategory,
  retryAfterSeconds: number | null,
): string | null {
  if (retryAfterSeconds !== null) {
    return `Retry in ${retryAfterSeconds}s.`;
  }
  return engineErrorCopy(category).retryable ? "Retry when ready." : null;
}

/**
 * Action hint per remedy - the ONE user action that clears the failure,
 * phrased as an imperative. A `Record` over the closed enum so a new remedy
 * without copy is a compile error, exactly like the category table above.
 */
const REMEDY_HINT: Readonly<Record<EngineErrorRemedy, string>> = {
  "insufficient-funds": "Top up your provider credits, then retry.",
  "config-invalid": "Check the API key and permissions in provider setup.",
  "rate-limited": "Wait out the rate limit, then retry.",
  "provider-down": "Wait for the provider to recover, then retry.",
  "compact-session": "Compact this session or start a new one.",
  "remove-attachment": "Remove or replace the attached image, then retry.",
};

/** Imperative action hint for a remedy; null when there is none to suggest. */
export function engineErrorRemedyHint(
  remedy: EngineErrorRemedy | null,
): string | null {
  return remedy === null ? null : REMEDY_HINT[remedy];
}
