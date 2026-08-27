/**
 * Ansem Z500 client — one GET, honestly classified.
 *
 * The whole contract is: fetch `/api/coins`, return a VALIDATED snapshot or
 * throw the ANSEM_* error naming why the snapshot is unusable. The
 * allocation-sync workflow turns every throw from here into a fail-closed,
 * no-change run — so precision about WHY matters more than resilience tricks.
 *
 *   - transport failure / timeout            → ANSEM_TIMEOUT / ANSEM_UNAVAILABLE
 *   - bot-management challenge or any HTML   → ANSEM_UNAVAILABLE (an access
 *     control; never solved, never retried harder — spec constraint)
 *   - non-2xx                                → ANSEM_UNAVAILABLE
 *   - 2xx non-JSON                           → ANSEM_INVALID_RESPONSE
 *   - JSON failing validation                → ANSEM_INVALID_RESPONSE / ANSEM_STALE
 *
 * The optional ANSEM_API_KEY env is sent as a bearer token, read per call and
 * never cached, logged, or echoed — same discipline as the Indexify key.
 */

import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout } from "../../utils/http.js";
import { ANSEM_API_KEY_ENV, ANSEM_COINS_PATH } from "./constants.js";
import { validateAnsemSnapshot } from "./validation.js";
import type { AnsemSnapshot } from "./types.js";

export interface AnsemRequestOptions {
  readonly signal?: AbortSignal | undefined;
}

export class AnsemClient {
  constructor(private readonly baseUrl: string) {}

  /** Fetch and validate the current Z500 Curated snapshot, or throw ANSEM_*. */
  async fetchSnapshot(options: AnsemRequestOptions = {}): Promise<AnsemSnapshot> {
    const url = new URL(ANSEM_COINS_PATH, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`).toString();
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
    };
    const token = process.env[ANSEM_API_KEY_ENV]?.trim();
    if (token) headers.authorization = `Bearer ${token}`;

    let response: Response;
    let text: string;
    try {
      response = await fetchWithTimeout(url, {
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      text = await response.text();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new VexError(
          ErrorCodes.ANSEM_TIMEOUT,
          "Ansem feed timed out or was aborted",
          "The Ansem feed did not answer in time.",
        );
      }
      const reason = err instanceof Error ? err.constructor.name : typeof err;
      throw new VexError(
        ErrorCodes.ANSEM_UNAVAILABLE,
        `Ansem feed unreachable before a response arrived (${reason})`,
        "Could not reach the Ansem feed.",
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const looksLikeHtml = contentType.includes("text/html") || text.trimStart().startsWith("<");

    if (!response.ok || looksLikeHtml) {
      // A challenge page IS an html non-answer; both collapse to the same
      // honest classification. HTTP status is carried for the audit record.
      throw new VexError(
        ErrorCodes.ANSEM_UNAVAILABLE,
        `Ansem feed unavailable (HTTP ${response.status}${looksLikeHtml ? ", non-JSON body — likely a bot-management challenge" : ""})`,
        "The Ansem feed refused or challenged this client. Partner-side allowlisting or a feed token (ANSEM_API_KEY) grants access.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new VexError(
        ErrorCodes.ANSEM_INVALID_RESPONSE,
        "Ansem feed answered ok with a non-JSON body",
        "The Ansem feed returned an unreadable document.",
      );
    }
    return validateAnsemSnapshot(parsed);
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let cachedClient: AnsemClient | null = null;
let cachedBaseUrl: string | null = null;

export function getAnsemClient(): AnsemClient {
  const baseUrl = loadConfig().services.ansemApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) return cachedClient;
  cachedClient = new AnsemClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
