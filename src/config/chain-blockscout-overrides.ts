import { VexError } from "../errors.js";
import { loadConfig } from "./store.js";

export const BLOCKSCOUT_OVERRIDE_INVALID = "BLOCKSCOUT_OVERRIDE_INVALID";

/** User-owned endpoint configuration, never a provider-controlled URL. */
export function validateBlockscoutBaseUrl(raw: string): string {
  let url: URL;
  try {
    if (!/^https?:\/\/\S+$/i.test(raw.trim()) || raw.includes("\\")) throw new Error();
    url = new URL(raw.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new VexError(BLOCKSCOUT_OVERRIDE_INVALID,
      "blockscoutBaseUrls contains an invalid Blockscout base URL",
      "Use HTTPS or loopback HTTP, without credentials, query parameters or fragments.");
  }
  return url.toString().replace(/\/+$/, "");
}

/** The per-chain override uses the same local config owner as EVM RPC overrides. */
export function getUserBlockscoutOverrideForChain(chainId: number): string | undefined {
  const raw = loadConfig().blockscoutBaseUrls?.[String(chainId)];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new VexError(BLOCKSCOUT_OVERRIDE_INVALID, "blockscoutBaseUrls must contain base URL strings");
  }
  return validateBlockscoutBaseUrl(raw);
}
