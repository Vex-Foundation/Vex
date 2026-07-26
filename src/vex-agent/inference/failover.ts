/**
 * FailoverProvider — bounded retry → provider failover → recoverable park.
 *
 * Wraps an ORDERED list of {@link InferenceProvider}s (primary first, then an
 * optional fallback) so that a provider blip on one endpoint cannot strand a
 * long unattended run. Every call drives the same state machine:
 *
 *   for each provider, in preference order:
 *     retry the call with exponential backoff + jitter while the error is
 *     TRANSIENT, up to `maxRetriesPerProvider` extra attempts;
 *     ├─ success                 → return immediately;
 *     ├─ PERMANENT error         → throw immediately (fail fast, NO failover:
 *     │                             a bad key or malformed request fails
 *     │                             identically everywhere and must reach the
 *     │                             operator rather than burn a second key);
 *     └─ transient budget spent  → switch to the next provider (logged).
 *   all providers exhausted      → throw {@link AllProvidersFailedError}.
 *
 * ── Relationship to the mission auto-retry classifier ───────────────────────
 *
 * This module deliberately does NOT define its own transient/permanent rules.
 * It delegates to `classifyMissionRunError` — the single, conservative,
 * own-property-based classifier the mission layer already uses (validated
 * `causeCode` via `mission-error-signal.ts`, a closed transient allow-list, and
 * hard exclusions for operator-abort / DNS / TLS / 4xx). A second, competing
 * classifier here would be the exact drift hazard that classifier exists to
 * remove: an error could be "retryable" to the inference layer and "permanent"
 * to the mission layer, or vice versa.
 *
 * Layering note: `mission-error-classifier.ts` and `mission-error-signal.ts`
 * are dependency-free leaf modules (no DB, no engine state, no transport), so
 * importing them here introduces no cycle. If maintainers would rather keep the
 * inference layer strictly free of `engine/` imports, both leaves can move to
 * `src/lib/` unchanged — this module only needs the function.
 *
 * That reuse also gives the terminal error its key property: this layer retries
 * and fails over, and when the whole stack is down it throws an error the
 * SAME classifier still reads as transient, so the mission parks with an
 * auto-retry budget instead of dying.
 *
 * The stack is STATELESS between calls: every call restarts at the primary, so
 * a one-off failover does not stick — the primary is preferred again as soon as
 * it recovers.
 *
 * Bounded by construction: total attempts = providers.length × (1 +
 * maxRetriesPerProvider). No unbounded loop and no uncaught throw, so a
 * recovery pass that re-enters this client backs off and fails over rather than
 * hot-looping.
 */

import type {
  InferenceProvider,
  InferenceConfig,
  InferenceResponse,
  InferenceUsage,
  StreamChunk,
  ProviderBalance,
  ProviderMessage,
  ToolDefinition,
  RequestCost,
} from "./types.js";
import { classifyMissionRunError } from "../engine/core/runner/mission-error-classifier.js";
import { readMissionErrorSignal } from "../engine/core/runner/mission-error-signal.js";
import logger from "@utils/logger.js";

// ── Tuning defaults (technical constants, not ENV) ───────────────

const DEFAULT_MAX_RETRIES_PER_PROVIDER = 2;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 15_000;

export interface FailoverOptions {
  /** Extra retry attempts per provider on a TRANSIENT error (initial attempt not counted). */
  maxRetriesPerProvider: number;
  /** Initial backoff delay. */
  baseDelayMs: number;
  /** Upper bound on a single backoff delay. */
  maxDelayMs: number;
  /** Add up to +baseDelay jitter to spread retries (default true). */
  jitter: boolean;
  /** Injectable clock — tests pass a no-op to make backoff instant. */
  sleep: (ms: number) => Promise<void>;
  /**
   * Injectable classifier seam. Defaults to the shared mission classifier;
   * overridden only in tests. Production code must not pass this.
   */
  isTransient: (err: Error) => boolean;
}

/** Read the HTTP status off an error's validated own-properties (never a message regex). */
function statusOf(err: Error): number | null {
  return readMissionErrorSignal(err).status;
}

function isTransientByMissionClassifier(err: Error): boolean {
  return classifyMissionRunError(err) === "transient";
}

// ── Terminal error ───────────────────────────────────────────────

export interface ProviderFailure {
  readonly providerId: string;
  readonly message: string;
  readonly status: number | null;
}

/**
 * Thrown when EVERY provider in the stack exhausted its transient retries.
 *
 * Deliberately shaped so `classifyMissionRunError` reads it as TRANSIENT — it
 * carries `retryable: true` plus, when known, the last transient HTTP status as
 * lean `status`/`statusCode` own-properties. That keeps a total-outage run
 * RECOVERABLE (parked with an auto-retry budget) instead of permanently halted.
 *
 * Carries only per-provider ids and already-normalized/scrubbed messages —
 * never raw error objects, and never a key or request body.
 */
export class AllProvidersFailedError extends Error {
  override readonly name = "AllProvidersFailedError";
  /** Read by the mission classifier's `retryable` fallback to stay recoverable. */
  readonly retryable = true;
  readonly failures: readonly ProviderFailure[];

  constructor(failures: readonly ProviderFailure[]) {
    const summary = failures
      .map((f) => `${f.providerId}${f.status !== null ? ` (status=${f.status})` : ""}`)
      .join(", ");
    super(`All inference providers failed after retries: ${summary}`);
    this.failures = failures;

    // Surface the last known transient status as a lean own-property so the
    // classifier decides on status (authoritative) rather than the `retryable`
    // marker. Non-enumerable to keep it out of incidental serialization.
    const lastStatus =
      [...failures].reverse().find((f) => f.status !== null)?.status ?? null;
    if (lastStatus !== null) {
      Object.defineProperty(this, "statusCode", { value: lastStatus, enumerable: false });
      Object.defineProperty(this, "status", { value: lastStatus, enumerable: false });
    }
  }
}

// ── FailoverProvider ─────────────────────────────────────────────

export class FailoverProvider implements InferenceProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string | undefined;

  private readonly providers: readonly InferenceProvider[];
  private readonly primary: InferenceProvider;
  private readonly opts: FailoverOptions;

  constructor(providers: InferenceProvider[], options: Partial<FailoverOptions> = {}) {
    const [primary, ...rest] = providers;
    if (primary === undefined) {
      throw new Error("FailoverProvider requires at least one provider");
    }
    this.providers = [primary, ...rest];
    this.primary = primary;

    // Identity mirrors the PRIMARY so existing call sites reading `provider.id`
    // see the same value whether or not a fallback is configured.
    this.id = primary.id;
    this.model = primary.model;
    this.displayName =
      rest.length === 0
        ? primary.displayName
        : `${primary.displayName} (+${rest.length} fallback)`;

    this.opts = {
      maxRetriesPerProvider:
        options.maxRetriesPerProvider ?? DEFAULT_MAX_RETRIES_PER_PROVIDER,
      baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      jitter: options.jitter ?? true,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      isTransient: options.isTransient ?? isTransientByMissionClassifier,
    };
  }

  /** Number of providers in the stack (1 = single provider, no failover target). */
  get size(): number {
    return this.providers.length;
  }

  // ── Central driver ──────────────────────────────────────────────

  private async run<T>(
    label: string,
    op: (p: InferenceProvider) => Promise<T>,
  ): Promise<T> {
    const failures: ProviderFailure[] = [];
    const single = this.providers.length === 1;

    for (const [pIdx, provider] of this.providers.entries()) {
      let lastErr: Error | undefined;

      for (let attempt = 0; attempt <= this.opts.maxRetriesPerProvider; attempt++) {
        try {
          return await op(provider);
        } catch (raw) {
          const error = raw instanceof Error ? raw : new Error(String(raw));
          lastErr = error;

          // Permanent → fail fast. No retry, no failover.
          if (!this.opts.isTransient(error)) {
            logger.warn("inference.failover.permanent", {
              label,
              providerId: provider.id,
              status: statusOf(error),
            });
            throw error;
          }

          // Transient with budget left → back off and retry the SAME provider.
          if (attempt < this.opts.maxRetriesPerProvider) {
            const delayMs = this.backoffDelay(attempt);
            logger.debug("inference.failover.retry", {
              label,
              providerId: provider.id,
              attempt: attempt + 1,
              delayMs: Math.round(delayMs),
              status: statusOf(error),
            });
            await this.opts.sleep(delayMs);
          }
        }
      }

      // Provider exhausted its transient budget.
      failures.push({
        providerId: provider.id,
        message: lastErr?.message ?? "unknown error",
        status: lastErr ? statusOf(lastErr) : null,
      });

      const nextProvider = this.providers[pIdx + 1];
      if (nextProvider !== undefined) {
        logger.warn("inference.failover.switch", {
          label,
          from: provider.id,
          to: nextProvider.id,
          status: lastErr ? statusOf(lastErr) : null,
        });
      } else if (single) {
        // Single-provider stack: nothing to fail over to. Surface the
        // provider's own (already-normalized) error unchanged so a
        // no-fallback install behaves exactly as it did before this change.
        throw lastErr!;
      }
    }

    logger.error("inference.failover.exhausted", {
      label,
      providers: failures.map((f) => f.providerId),
    });
    throw new AllProvidersFailedError(failures);
  }

  /**
   * Retarget the per-turn `config` to the ACTIVE provider's OWN model.
   *
   * The engine builds `config` once per turn from `loadConfig()`, which returns
   * the PRIMARY's config. Delegating that object verbatim to a fallback would
   * request the PRIMARY's model id against the FALLBACK's endpoint/key — a real
   * P1: the failover appears to work, then fails or silently bills the wrong
   * model. Only `model` is swapped, and only when the active provider
   * advertises a different one; every caller-owned per-turn field
   * (reasoningEffort, temperature, limits) is preserved, and the caller's
   * object is never mutated.
   */
  private configFor(
    provider: InferenceProvider,
    config: InferenceConfig,
  ): InferenceConfig {
    if (provider.model !== undefined && provider.model !== config.model) {
      return { ...config, model: provider.model };
    }
    return config;
  }

  private backoffDelay(attempt: number): number {
    const base = this.opts.baseDelayMs * Math.pow(2, attempt);
    const jitter = this.opts.jitter ? Math.random() * this.opts.baseDelayMs : 0;
    return Math.min(base + jitter, this.opts.maxDelayMs);
  }

  // ── InferenceProvider surface ───────────────────────────────────

  /**
   * Load config from the first provider that returns a non-null config.
   * `loadConfig` is null-on-failure (not throw) and each provider serves its
   * own last-good/stale copy, so a first-non-null walk is the correct failover.
   */
  async loadConfig(): Promise<InferenceConfig | null> {
    for (const provider of this.providers) {
      try {
        const config = await provider.loadConfig();
        if (config) return config;
      } catch (err) {
        logger.warn("inference.failover.load_config_failed", {
          providerId: provider.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return null;
  }

  chatCompletion(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    config: InferenceConfig,
  ): Promise<InferenceResponse> {
    return this.run("chatCompletion", (p) =>
      p.chatCompletion(messages, tools, this.configFor(p, config)),
    );
  }

  chatCompletionSimple(
    messages: ProviderMessage[],
    config: InferenceConfig,
  ): Promise<{ content: string; usage: InferenceUsage }> {
    return this.run("chatCompletionSimple", (p) =>
      p.chatCompletionSimple(messages, this.configFor(p, config)),
    );
  }

  /**
   * Streaming failover is CONNECTION-LEVEL only: a provider is retried (with
   * transient backoff) until it yields its FIRST chunk, so a connect-time blip
   * fails over. Once bytes have flowed we cannot silently switch providers
   * mid-stream, so a mid-stream error propagates to the caller. Missions use
   * the non-streaming path; this method backs the interactive UI chat.
   */
  async *chatCompletionStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    config: InferenceConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const opened = await this.run("chatCompletionStream.open", async (p) => {
      const gen = p.chatCompletionStream(
        messages,
        tools,
        this.configFor(p, config),
        signal,
      );
      // Pull the first chunk INSIDE the retry/failover scope so a connect-time
      // transient error triggers backoff/failover instead of surfacing raw.
      const first = await gen.next();
      return { gen, first };
    });

    if (!opened.first.done) {
      yield opened.first.value;
      yield* opened.gen;
    }
  }

  /** Balance is best-effort: the first provider that reports a value wins. */
  async getBalance(): Promise<ProviderBalance | null> {
    for (const provider of this.providers) {
      try {
        const balance = await provider.getBalance();
        if (balance) return balance;
      } catch {
        // Best-effort surface — try the next provider.
      }
    }
    return null;
  }

  /** Cost is a pure local computation over the passed config — delegate to the primary. */
  calculateCost(usage: InferenceUsage, config: InferenceConfig): RequestCost {
    return this.primary.calculateCost(usage, config);
  }
}
