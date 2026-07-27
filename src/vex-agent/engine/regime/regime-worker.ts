/**
 * Regime worker (S6b) — the daily market-regime classifier. A SEPARATE executor
 * from the memory-manager 3h sweep (owner decision: one row a day, no partial
 * state, no durable queue — retry comes free from the cadence gate + hourly
 * tick). Mirrors `memory-manager/executor.ts`'s loop discipline:
 * non-reentrant tick (`stopped` / `inFlight` / `setTimeout` chain), idempotent
 * `stop()`.
 *
 * Tick flow (§5, fail-closed at every step):
 *   1. provider gate  — OPENROUTER_API_KEY + AGENT_MODEL read from process.env
 *      EVERY tick (the vault injects on unlock and scrubs on lock; caching the
 *      gate would defeat that). Missing → cheap no-op.
 *   2. source gate    — TAVILY_API_KEY / RETTIWT_API_KEY, also per tick.
 *      Neither → no-op (no accounts linked = no regime, by design).
 *   3. cadence gate   — latest snapshot younger than 20h → skip (daily rhythm;
 *      a failed day naturally retries within the hour).
 *   4. gather         — per-source try/catch + timeout; partial success (one
 *      source down) continues with the other; ALL configured sources failing →
 *      throw (no snapshot today, retry next tick).
 *   5. classify       — judge.ts provider pattern: fresh provider per call (no
 *      coupling to vault lock/resetProvider), loadConfig, Promise.race timeout,
 *      brace-extracted JSON, STRICT Zod; any failure → throw (NO heuristic
 *      fallback — a wrong regime is worse than none).
 *   6. cap (F4)       — a single usable source caps confidence at 'medium'.
 *   7. redact         — the LLM rationale runs through redact() (it could
 *      hallucinate a key/address straight out of the evidence).
 *   8. insert + memLog (allowlisted enum/num meta ONLY — never evidence text).
 *
 * Seams (FIX-3 analog): internal functions only — `searchAndOptionallyFetch`
 * (web.ts, fetchTop=0) and `executeTwitterAccountRequest` (tweet_search). NO
 * ToolDefs, NO registry/dispatcher changes, no `InternalToolContext` stubbing.
 * All IO is injectable (`RegimeWorkerDeps`) so the tick is unit-testable with
 * no network and no DB.
 *
 * Advisory-only (OD-1): the snapshot this worker writes feeds ONLY
 * decay/reactivation (rank indirectly via activation). Never sizing, approval,
 * wallet intent, or execution.
 */

import {
  executeTwitterAccountRequest,
  sanitizeTwitterAccountError,
} from "@tools/twitter-account/client.js";
import { z } from "zod";

import {
  getLatestRegimeSnapshot,
  insertRegimeSnapshot,
  type InsertRegimeSnapshotInput,
  type RegimeSnapshot,
} from "@vex-agent/db/repos/regime-snapshots.js";
import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import { redact } from "@vex-agent/memory/redaction.js";
import { minRegimeConfidence, type RegimeSource } from "@vex-agent/memory/schema/regime-enums.js";
import { searchAndOptionallyFetch } from "@vex-agent/tools/internal/web.js";
import { freezeWebSearchOptions } from "@vex-agent/tools/internal/web-research/search-options.js";
import {
  REGIME_LLM_TIMEOUT_MS,
  REGIME_MIN_INTERVAL_HOURS,
  REGIME_SOURCE_TIMEOUT_MS,
  REGIME_TICK_INTERVAL_MS,
  REGIME_TWEET_COUNT,
  REGIME_TWEET_MIN_LIKES,
  REGIME_TWEET_QUERY,
  REGIME_WEB_QUERIES,
} from "./policy.js";
import {
  buildRegimeSystemPrompt,
  buildRegimeUserPrompt,
  regimeVerdictSchema,
  type RegimeTweet,
  type RegimeWebResult,
} from "./regime-prompt.js";

// ── Injectable IO ────────────────────────────────────────────────────

export interface RegimeWorkerDeps {
  /** Tavily titles+snippets for one query (no page fetch). Throws on failure. */
  searchWeb: (query: string) => Promise<readonly RegimeWebResult[]>;
  /** Recent high-engagement tweets for the fixed query. Throws on failure. */
  searchTweets: () => Promise<readonly RegimeTweet[]>;
  /** Fresh LLM provider per classification (no caching across vault lock). */
  makeProvider: () => Promise<JudgeProvider>;
  /** Latest snapshot for the cadence gate. */
  getLatestSnapshot: () => Promise<RegimeSnapshot | null>;
  /** Persist the classified snapshot. */
  insertSnapshot: (input: InsertRegimeSnapshotInput) => Promise<RegimeSnapshot>;
  /** Clock (injectable for deterministic cadence tests). */
  now: () => Date;
}

/**
 * Default provider factory — the env-driven OpenRouter provider, constructed
 * FRESH per classification (judge.ts pattern). The constructor throws when
 * OPENROUTER_API_KEY / AGENT_MODEL are absent; the tick's provider gate
 * prevents reaching here without them.
 */
async function defaultProvider(): Promise<JudgeProvider> {
  const { OpenRouterProvider } = await import("@vex-agent/inference/openrouter.js");
  return new OpenRouterProvider();
}

// The web seam returns a ToolResult whose `data` is handler-shaped; validate the
// slice we consume at this boundary (external-ish input — never trust shape).
// W2B renamed the row's text field: a search-only row carries `snippet`, a row
// whose page was read carries `pageText` and no snippet at all.
const webSearchPayloadSchema = z
  .object({
    results: z.array(
      z
        .object({
          title: z.string(),
          snippet: z.string().optional(),
          pageText: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * The classifier's OWN web request — never the tool's agent-facing defaults.
 *
 * 10 rows with no page reads is the evidence set this worker has always used;
 * `web_research` now defaults to 6 rows + 3 page reads for the agent. Spelling
 * every field out here means a change to that default cannot silently shrink a
 * regime snapshot's evidence (the failure that left every snapshot Tavily-only
 * for a month went unnoticed for exactly this class of reason).
 */
const REGIME_WEB_SEARCH_MAX_RESULTS = 10;

async function defaultSearchWeb(query: string): Promise<readonly RegimeWebResult[]> {
  // fetchTop=0 → search-only (titles + snippets): fewer Tavily credits and a
  // smaller prompt-injection surface than full page bodies.
  const result = await searchAndOptionallyFetch(
    freezeWebSearchOptions({
      query,
      maxResults: REGIME_WEB_SEARCH_MAX_RESULTS,
      fetchTop: 0,
      topic: "general",
      searchDepth: "basic",
      chunksPerSource: null,
      timeRange: null,
    }),
  );
  if (!result.success) {
    throw new Error("regime_web_search_failed");
  }
  const parsed = webSearchPayloadSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new Error("regime_web_search_malformed_payload");
  }
  return parsed.data.results.map((r) => ({
    title: r.title,
    snippet: r.pageText ?? r.snippet ?? "",
  }));
}

// tweet_search returns a cursored payload of serialized rettiwt tweets; pick
// only the fields the evidence needs, skipping malformed items (fail-soft per
// item, fail-loud per source).
const tweetSearchPayloadSchema = z.object({ items: z.array(z.unknown()) }).passthrough();
const tweetItemSchema = z
  .object({
    fullText: z.string(),
    likeCount: z.number().int().nonnegative().optional(),
    retweetCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

async function defaultSearchTweets(): Promise<readonly RegimeTweet[]> {
  try {
    const result = await executeTwitterAccountRequest({
      action: "tweet_search",
      query: REGIME_TWEET_QUERY,
      filter: { top: true, minLikes: REGIME_TWEET_MIN_LIKES },
      count: REGIME_TWEET_COUNT,
    });
    const parsed = tweetSearchPayloadSchema.safeParse(result.data);
    if (!parsed.success) {
      throw new Error("regime_tweet_search_malformed_payload");
    }
    const tweets: RegimeTweet[] = [];
    for (const item of parsed.data.items) {
      const tweet = tweetItemSchema.safeParse(item);
      if (!tweet.success) continue;
      tweets.push({
        text: tweet.data.fullText,
        likes: tweet.data.likeCount ?? 0,
        retweets: tweet.data.retweetCount ?? 0,
      });
    }
    return tweets;
  } catch (err: unknown) {
    // Sanitize BEFORE re-throwing — a rettiwt error can embed the API key.
    throw new Error(`regime_tweet_search_failed: ${sanitizeTwitterAccountError(err)}`);
  }
}

export function defaultRegimeWorkerDeps(): RegimeWorkerDeps {
  return {
    searchWeb: defaultSearchWeb,
    searchTweets: defaultSearchTweets,
    makeProvider: defaultProvider,
    getLatestSnapshot: () => getLatestRegimeSnapshot(),
    insertSnapshot: (input) => insertRegimeSnapshot(input),
    now: () => new Date(),
  };
}

// ── Tick outcome ─────────────────────────────────────────────────────

export type RegimeSkipReason = "no_provider_config" | "no_sources" | "fresh_snapshot";

export type RegimeTickResult =
  | { kind: "skipped"; reason: RegimeSkipReason }
  | { kind: "snapshot_created"; snapshotId: number; source: RegimeSource };

const MS_PER_HOUR = 60 * 60 * 1000;

/** judge.ts-style race timeout (the underlying promise is abandoned, not cancelled). */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

/**
 * Run ONE regime tick (gates → gather → classify → cap → redact → insert).
 * Returns a skip outcome on a gate; THROWS on gather/classify/insert failure
 * (the worker loop logs `tick_failed` and the next hourly tick retries — the
 * cadence gate cannot pass until a snapshot actually lands). Exported for unit
 * tests with injected deps; production runs it from `startRegimeWorker`.
 */
export async function runRegimeTick(
  deps: RegimeWorkerDeps = defaultRegimeWorkerDeps(),
): Promise<RegimeTickResult> {
  // Gate 1 — provider config, read from process.env EVERY tick (vault unlock
  // injects, lock scrubs; a tick before unlock must be a cheap no-op).
  if (!process.env.OPENROUTER_API_KEY || !process.env.AGENT_MODEL) {
    return { kind: "skipped", reason: "no_provider_config" };
  }

  // Gate 2 — evidence sources, also per tick. No linked source = no regime
  // (fail-closed by design — decay degrades to pure time decay).
  const hasTavily = !!process.env.TAVILY_API_KEY;
  const hasTwitter = !!process.env.RETTIWT_API_KEY;
  if (!hasTavily && !hasTwitter) {
    return { kind: "skipped", reason: "no_sources" };
  }

  // Gate 3 — cadence: youngest snapshot < 20h → today is already classified
  // (idempotence + daily rhythm + free retry after a failed day). An
  // unparseable timestamp is treated as stale (proceed), never as fresh.
  const latest = await deps.getLatestSnapshot();
  if (latest) {
    const ageMs = deps.now().getTime() - Date.parse(latest.createdAt);
    if (Number.isFinite(ageMs) && ageMs < REGIME_MIN_INTERVAL_HOURS * MS_PER_HOUR) {
      return { kind: "skipped", reason: "fresh_snapshot" };
    }
  }

  // 4 — gather, per-source try/catch + timeout. A source that errors OR yields
  // zero items contributes nothing (and is logged); one healthy source is
  // enough to continue. Every configured source dead → throw (no snapshot).
  let webResults: readonly RegimeWebResult[] = [];
  let tweets: readonly RegimeTweet[] = [];
  let tavilyUsed = false;
  let twitterUsed = false;

  if (hasTavily) {
    try {
      const gathered = await withTimeout(
        gatherWebEvidence(deps),
        REGIME_SOURCE_TIMEOUT_MS,
        "regime_tavily_timeout",
      );
      if (gathered.length > 0) {
        webResults = gathered;
        tavilyUsed = true;
      } else {
        memLog.warn("regime", "gather_failed", { errorCode: "tavily_empty" });
      }
    } catch (err: unknown) {
      memLog.warn("regime", "gather_failed", {
        errorCode: err instanceof Error ? "tavily_error" : "tavily_unknown",
      });
    }
  }

  if (hasTwitter) {
    try {
      const gathered = await withTimeout(
        deps.searchTweets(),
        REGIME_SOURCE_TIMEOUT_MS,
        "regime_twitter_timeout",
      );
      if (gathered.length > 0) {
        tweets = gathered;
        twitterUsed = true;
      } else {
        memLog.warn("regime", "gather_failed", { errorCode: "twitter_empty" });
      }
    } catch (err: unknown) {
      memLog.warn("regime", "gather_failed", {
        errorCode: err instanceof Error ? "twitter_error" : "twitter_unknown",
      });
    }
  }

  if (!tavilyUsed && !twitterUsed) {
    throw new Error("regime_gather_failed: no usable evidence from any configured source");
  }

  // 5 — classify (judge.ts pattern; throw on every malformed step — there is
  // deliberately NO heuristic fallback, a wrong regime is worse than none).
  const provider = await deps.makeProvider();
  const config = await provider.loadConfig();
  if (!config) {
    memLog.warn("regime", "classify_failed", { errorCode: "provider_config_load_failed" });
    throw new Error("regime_provider_config_load_failed");
  }

  const response = await withTimeout(
    provider.chatCompletionSimple(
      [
        { role: "system", content: buildRegimeSystemPrompt() },
        { role: "user", content: buildRegimeUserPrompt({ webResults, tweets }) },
      ],
      config,
    ),
    REGIME_LLM_TIMEOUT_MS,
    "regime_llm_timeout",
  );

  const text = response.content?.trim() ?? "";
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    memLog.warn("regime", "classify_failed", { errorCode: "malformed_json" });
    throw new Error(`regime_classify_malformed_json: missing braces (len=${text.length})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    memLog.warn("regime", "classify_failed", { errorCode: "malformed_json" });
    throw new Error("regime_classify_malformed_json: JSON.parse failed");
  }

  const validated = regimeVerdictSchema.safeParse(parsed);
  if (!validated.success) {
    memLog.warn("regime", "classify_failed", { errorCode: "schema_invalid" });
    throw new Error(`regime_classify_schema_invalid: ${validated.error.message}`);
  }

  // 6 — F4 cap: fewer than two USABLE sources can never corroborate 'high'.
  const usedSources = (tavilyUsed ? 1 : 0) + (twitterUsed ? 1 : 0);
  const confidence =
    usedSources < 2
      ? minRegimeConfidence(validated.data.confidence, "medium")
      : validated.data.confidence;
  const source: RegimeSource =
    tavilyUsed && twitterUsed ? "hybrid" : tavilyUsed ? "tavily" : "twitter";

  // 7 — defense-in-depth redaction (the LLM could echo a hallucinated key or
  // address straight out of the untrusted evidence into its rationale).
  const rationale = redact(validated.data.rationale).text;

  // 8 — persist + allowlisted telemetry (enum/num/id only; never evidence text).
  const snapshot = await deps.insertSnapshot({
    trendLabel: validated.data.trendLabel,
    volLabel: validated.data.volLabel,
    confidence,
    source,
    rationale,
  });

  memLog("regime", "snapshot_created", {
    regimeTrend: snapshot.trendLabel,
    regimeVol: snapshot.volLabel,
    regimeConfidence: snapshot.confidence,
    regimeSource: snapshot.source,
    regimeSnapshotId: snapshot.id,
  });

  return { kind: "snapshot_created", snapshotId: snapshot.id, source: snapshot.source };
}

/** Both fixed queries, concatenated — one Tavily "source" unit for gather. */
async function gatherWebEvidence(deps: RegimeWorkerDeps): Promise<RegimeWebResult[]> {
  const out: RegimeWebResult[] = [];
  for (const query of REGIME_WEB_QUERIES) {
    out.push(...(await deps.searchWeb(query)));
  }
  return out;
}

// ── Worker loop (executor.ts pattern) ────────────────────────────────

export interface RegimeWorkerHandle {
  stop: () => Promise<void>;
}

export interface StartRegimeWorkerOptions {
  /** Tick interval in ms. Default REGIME_TICK_INTERVAL_MS (1h). */
  tickIntervalMs?: number;
  /** Injectable IO (tests stub sources/provider/repo). */
  deps?: RegimeWorkerDeps;
}

/**
 * Start the regime worker: tick immediately, then re-schedule after each tick
 * completes (non-reentrant — `setTimeout` chain, never an overlapping
 * `setInterval`). The two env gates warn ONCE per outage (executor.ts pattern)
 * and re-arm when the config appears; the cadence skip logs at info (it is the
 * normal state ~23h a day and proves liveness). `stop()` is idempotent and
 * awaits an in-flight tick.
 */
export function startRegimeWorker(options: StartRegimeWorkerOptions = {}): RegimeWorkerHandle {
  const interval = options.tickIntervalMs ?? REGIME_TICK_INTERVAL_MS;
  const deps = options.deps ?? defaultRegimeWorkerDeps();

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let warnedNoProviderConfig = false;
  let warnedNoSources = false;

  const tick = async (): Promise<void> => {
    try {
      const result = await runRegimeTick(deps);
      if (result.kind === "skipped") {
        if (result.reason === "no_provider_config") {
          if (!warnedNoProviderConfig) {
            memLog.warn("regime", "skipped", { errorCode: "no_provider_config" });
            warnedNoProviderConfig = true;
          }
          return;
        }
        warnedNoProviderConfig = false;
        if (result.reason === "no_sources") {
          if (!warnedNoSources) {
            memLog.warn("regime", "skipped", { errorCode: "no_sources" });
            warnedNoSources = true;
          }
          return;
        }
        warnedNoSources = false;
        memLog("regime", "skipped", { errorCode: "fresh_snapshot" });
        return;
      }
      warnedNoProviderConfig = false;
      warnedNoSources = false;
    } catch (err: unknown) {
      memLog.error("regime", "tick_failed", {
        errorCode: err instanceof Error ? "tick_error" : "tick_unknown",
      });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = tick().finally(() => {
      inFlight = null;
      if (!stopped) timer = setTimeout(schedule, interval);
    });
  };

  schedule();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}
