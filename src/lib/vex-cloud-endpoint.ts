/**
 * Where Vex Cloud lives, for the engine's inference client and for the main
 * process's account and sign-in client: ONE resolver, so the host the SIWE
 * messages bind and the host the session bearer is sent to can never differ.
 *
 * The shipped value is the built-in `VEX_CLOUD_API_URL` (owner decision D18).
 * Development may point the whole app at a local backend through
 * `VEX_DEV_CLOUD_API_URL`. A packaged build IGNORES that variable: the
 * decision is the privileged main process's (`!app.isPackaged`), handed down
 * through {@link allowVexCloudDevOverride} at boot, and it is closed until
 * main opens it. Core code has no Electron and cannot read `app.isPackaged`
 * itself; the same pattern as `allowBinaryPathOverride` in
 * `tools/lighter/signer-binary-adapter.ts`, failing closed for a caller that
 * never thought about it.
 */

import { VEX_CLOUD_API_URL } from "../config/store.js";

/** Development-only override; a packaged build ignores it. */
export const VEX_CLOUD_DEV_API_URL_ENV = "VEX_DEV_CLOUD_API_URL";

let devOverrideAllowed = false;

/**
 * Main's decision whether the development override may apply in this
 * process. Called once at boot with `!app.isPackaged`; tests call it to
 * exercise both sides.
 */
export function allowVexCloudDevOverride(allowed: boolean): void {
  devOverrideAllowed = allowed;
}

/** Whether the development override is currently honoured (diagnostics and tests). */
export function isVexCloudDevOverrideAllowed(): boolean {
  return devOverrideAllowed;
}

/**
 * A usable origin: http(s), no credentials, no path beyond `/`, no query or
 * fragment. Anything else is not a backend origin and is refused rather than
 * trimmed into one.
 */
function parseOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

/**
 * The Vex Cloud origin in effect, without a trailing slash. The development
 * override applies only when main allowed it AND it parses as a bare origin;
 * a malformed override falls back to the shipped host instead of sending the
 * bearer somewhere half-parsed.
 */
export function resolveVexCloudOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (devOverrideAllowed) {
    const raw = env[VEX_CLOUD_DEV_API_URL_ENV]?.trim();
    if (raw !== undefined && raw.length > 0) {
      const origin = parseOrigin(raw);
      if (origin !== null) return origin;
    }
  }
  return VEX_CLOUD_API_URL;
}

/** The OpenRouter-dialect base the inference SDK appends `/chat/completions` and `/models` to. */
export function vexCloudInferenceServerUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return `${resolveVexCloudOrigin(env)}/v1`;
}

/**
 * What a Vex Cloud sign-in message must bind (EIP-4361 `domain` and `uri`),
 * derived from the origin the app actually dials. The backend issues its own
 * `domain` and `uri` with every nonce; the signer refuses to sign unless they
 * equal these, so a spoofed or misconfigured server cannot make the app sign
 * for another host.
 */
export interface VexCloudSiweBinding {
  /** The host name, without a port (the backend's `SIWE_DOMAIN`). */
  readonly domain: string;
  /** The origin, scheme and port included (the backend's `SIWE_URI`). */
  readonly uri: string;
}

export function vexCloudSiweBinding(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VexCloudSiweBinding {
  const origin = resolveVexCloudOrigin(env);
  const url = new URL(origin);
  return { domain: url.hostname, uri: url.origin };
}
