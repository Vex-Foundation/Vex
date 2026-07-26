/**
 * ProviderStep error UI copy — extracted from `ProviderStep.tsx` so
 * the screen file stays under the 400-LOC scalability ceiling (V2
 * refactor).
 *
 * The map is the single source of truth for fixed strings shown when
 * provider verification or persistence fails. We DO NOT surface the
 * SDK's raw error message (codex turn 3 YELLOW) — the user gets a
 * stable, redacted, actionable hint and the correlation id for
 * support, nothing more.
 */

import type { VexErrorCode } from "@shared/ipc/result.js";

export interface ServerError {
  readonly code: VexErrorCode | string;
  readonly correlationId: string | null;
  /**
   * Errno-shaped cause code from `VexError.details.causeCode`
   * (error-diagnostics plan D-WIZARD). Always a closed-dictionary
   * errno string extracted main-side — never raw SDK message text.
   */
  readonly causeCode: string | null;
  /**
   * Which provider the verify failed on. `"fallback"` only when the optional
   * fallback was the one that failed — the primary having already verified.
   * Closed set stamped main-side (`ipc/onboarding/provider.ts`); anything else
   * is treated as the primary.
   */
  readonly scope?: "primary" | "fallback";
}

export interface ErrorCopy {
  readonly title: string;
  readonly body: string;
}

const PROVIDER_ERROR_UI: Readonly<Record<string, ErrorCopy>> = {
  "provider.invalid_api_key": {
    title: "API key rejected",
    body:
      "OpenRouter rejected the API key. Verify the key in your OpenRouter dashboard and try again.",
  },
  "provider.insufficient_credits": {
    title: "Insufficient credits",
    body:
      "Your OpenRouter account has insufficient credits. Add funds in the OpenRouter dashboard, then retry.",
  },
  "provider.model_unsupported": {
    title: "Model not found",
    body:
      "OpenRouter couldn't find that model id. Verify the model in the OpenRouter models catalogue and try again.",
  },
  "provider.unavailable": {
    title: "OpenRouter unavailable",
    body:
      "Couldn't reach OpenRouter (network error, rate limit, or service outage). Check your connection and retry. If this persists, try again in a few minutes.",
  },
  "provider.test_failed": {
    title: "Verification failed",
    body:
      "Verification failed. Try again, or check the OpenRouter dashboard for service issues.",
  },
  "onboarding.env_persist_failed": {
    title: "Couldn't save provider settings",
    body:
      "Credentials verified, but couldn't save to disk. Check disk space and permissions, then retry.",
  },
  "validation.invalid_input": {
    title: "Invalid input",
    body:
      "API key and model id must be non-empty after trimming whitespace, and shorter than 200 characters.",
  },
};

const FALLBACK_COPY: ErrorCopy = {
  title: "Something went wrong",
  body:
    "Verification or save failed for an unexpected reason. Please retry.",
};

export function uiCopyFor(code: string): ErrorCopy {
  return PROVIDER_ERROR_UI[code] ?? FALLBACK_COPY;
}

/**
 * Closed hint map for errno-shaped cause codes (error-diagnostics plan
 * D-WIZARD). Fixed inline-English copy per code group — a code outside
 * this map renders the Cause line WITHOUT a hint; codes never come from
 * user data (main extracts only errno-shaped `.code` strings).
 */
const TLS_HINT =
  "TLS certificate could not be verified — antivirus or proxy HTTPS " +
  "inspection is a common cause. Check your antivirus 'HTTPS scanning' " +
  "setting.";
const DNS_HINT =
  "DNS lookup failed — check your network connection or DNS settings.";
const CONNECT_HINT =
  "Connection could not be established — a firewall, VPN, or proxy may " +
  "be blocking the app.";

export const CAUSE_HINTS: Readonly<Record<string, string>> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: TLS_HINT,
  SELF_SIGNED_CERT_IN_CHAIN: TLS_HINT,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: TLS_HINT,
  DEPTH_ZERO_SELF_SIGNED_CERT: TLS_HINT,
  CERT_HAS_EXPIRED: TLS_HINT,
  ENOTFOUND: DNS_HINT,
  EAI_AGAIN: DNS_HINT,
  ECONNREFUSED: CONNECT_HINT,
  ETIMEDOUT: CONNECT_HINT,
  ECONNRESET: CONNECT_HINT,
  UND_ERR_CONNECT_TIMEOUT: CONNECT_HINT,
};
