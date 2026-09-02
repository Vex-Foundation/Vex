/**
 * BOARD TOKEN ICONS - the one owner of icon bytes for the agent-composed board.
 *
 * WHAT IT IS FOR. A board card names a token; a token's logo is the fastest way
 * a reader confirms the card is about the token they think it is. The handle
 * for that logo (`cmsProfile.iconId`) is stamped into the persisted board at
 * compose time, and this service is the only thing in the app that turns such a
 * handle into pixels.
 *
 * WHY IT LIVES IN `images/`. This folder already owns the app's image trust
 * boundary: `image-validation.ts` decides what a byte string IS from its magic
 * bytes and its header, with no decode and no transcode, because no runtime
 * image codec ships with Vex. Board icons are foreign bytes off a CDN, which is
 * strictly MORE hostile than the locker's user-picked files, so they go through
 * that same validator rather than a second one written to be lenient about a
 * provider we like.
 *
 * THE BOUNDARY, stated as a list because every line of it is load-bearing:
 *  - the renderer never sees a URL, a host, or a byte. It sends an opaque
 *    `iconId` and receives a `data:` URL or a typed absence, so `img-src 'self'
 *    data:` stays exactly as it is and the renderer keeps zero network
 *    authority;
 *  - the URL is composed HERE from a pattern-checked id, and the fetch still
 *    passes the bridge's host-and-prefix allowlist, so neither a persisted
 *    document nor a compromised renderer can point this capability at another
 *    origin;
 *  - the body is read with a running byte count and the transfer is stopped at
 *    {@link BOARD_ICON_MAX_BYTES}. A bound applied after a buffered read is not
 *    a bound;
 *  - the declared MIME and the magic bytes must AGREE, and the header
 *    dimensions must fit {@link BOARD_ICON_MAX_DIMENSION}. Disagreement is a
 *    policy refusal, never a "probably fine";
 *  - `nsfw` never gets this far. The compose-time stamp writes null for a
 *    flagged profile, so a flagged id is not in the durable document and cannot
 *    be asked for. That gate is in `src/vex-agent/tools/internal/board/
 *    hydrate.ts` and is proven by its own test.
 *
 * EVERY ABSENCE IS A FIRST-CLASS ANSWER. Roughly half of solana pairs carry no
 * profile at all, so "this token has no icon" is the ORDINARY outcome and the
 * board draws a designed monogram for it. Nothing here retries a signing-shaped
 * action, nothing here throws at the caller, and the three failure families
 * stay distinct: a 404 is a settled ABSENCE, a malformed or over-cap image is a
 * settled POLICY REFUSAL of published artwork, and a transport failure is
 * unknown and may be asked again.
 *
 * LIFECYCLE. One owner, mounted beside the DexScreener bridge whose fetcher it
 * borrows, disposed on the same teardown. `dispose()` closes admission first,
 * then aborts and drains what is in flight, then clears both caches. A disposed
 * service answers `unavailable`; it never resolves a stale promise into a
 * renderer that has already gone.
 */

import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import type { TransportResponse } from "@tools/dexscreener/transport.js";
import { log } from "../logger/index.js";
import { validateLockerImageBytes } from "./image-validation.js";

/**
 * The largest icon body this service will read, in bytes. 256 KiB.
 *
 * A RESOURCE BOUND on a remote host, not a claim about what an icon should
 * weigh: the measured icon was 2,684 bytes, so this is roughly a hundred times
 * the observed size and exists so a host that answered with something enormous
 * cannot pull it into this process. Over-cap is a refusal naming the size, and
 * the transfer is stopped rather than drained.
 */
export const BOARD_ICON_MAX_BYTES = 262_144;

/**
 * Dimension ceiling for an accepted icon, per side.
 *
 * The CDN is ASKED for 64x64 and honours it (measured), so anything past this
 * means the host ignored the request or the bytes are not what they claim.
 * `image-validation.ts` supplies the header-read dimensions; this is the
 * board's own tighter band on top of the locker's 8192 plausibility ceiling,
 * which is sized for a user's photograph and far too generous for a logo.
 */
export const BOARD_ICON_MAX_DIMENSION = 512;

/** The measured icon endpoint. Composed here, from a pattern-checked id only. */
const CDN_ORIGIN = "https://cdn.dexscreener.com";
const CDN_PATH_PREFIX = "/cms/images/";

/**
 * The size the CDN is asked for, and the size it was MEASURED to honour.
 *
 * 64 px into a card slot around 28 px wide leaves headroom for a high-density
 * display without paying for a full-size asset.
 */
const REQUEST_WIDTH = 64;
const REQUEST_HEIGHT = 64;

/**
 * `format=auto` lets the CDN pick, so the Accept header is what keeps the
 * answer inside the three formats this app can identify without a codec.
 * Asking for a format we cannot validate would turn a good icon into an
 * "unsupported image" absence.
 */
const ACCEPT = "image/png,image/webp";

/** Fixed deadline for one icon fetch. An icon is never worth a long wait. */
const FETCH_TIMEOUT_MS = 10_000;

/** Distinct ids fetched at once. Icons are decoration; they yield the pipe. */
const MAX_CONCURRENT_FETCHES = 2;

/** Waiting distinct ids. A ninth board's worth of icons is dropped, not queued. */
const QUEUE_MAX = 16;

/**
 * Resolved icons held in memory. An id names one immutable asset, so there is
 * no TTL here and a hit is always correct; the bound is the memory bound.
 * 64 entries at the 256 KiB ceiling is a worst case nothing realistic reaches
 * (the measured icon is 2.7 KB).
 */
const POSITIVE_CACHE_MAX = 64;

/**
 * How long a 404 is remembered. The provider deleting or adding artwork is
 * rare but not impossible, so "no such icon" is settled for a while rather than
 * forever. Transient failures are NEVER cached: caching an unknown would turn
 * one bad minute into ten minutes of missing logos.
 *
 * EXPORTED because the renderer holds the same window: a card that re-asks
 * sooner spends an IPC round trip on an answer main already has in memory. The
 * renderer cannot import a main-process module, so it declares its own copy
 * (`BOARD_ICON_NOT_FOUND_STALE_MS`) and a test pins the two together.
 */
export const BOARD_ICON_NOT_FOUND_TTL_MS = 600_000;

/** What the caller gets back. Four families, deliberately not collapsed. */
export type BoardIconResolution =
  | {
      readonly kind: "image";
      /** `data:<mime>;base64,<...>`, bounded by {@link BOARD_ICON_MAX_BYTES}. */
      readonly dataUrl: string;
    }
  | {
      /** Settled: the provider has no icon under this handle. */
      readonly kind: "absent";
      readonly reason: "not_found";
    }
  | {
      /**
       * Settled: the provider HAS artwork here and this app declined it. Not
       * `absent` (the token does have a picture) and not `unavailable` (the
       * verdict is deterministic for these bytes, so re-asking is pointless).
       */
      readonly kind: "refused_by_policy";
      readonly reason: "unsupported_image" | "over_cap";
    }
  | {
      /** Unknown: nothing was learned about the icon. May be asked again. */
      readonly kind: "unavailable";
      readonly reason: "busy" | "transport" | "not_mounted";
    };

/** The narrow slice of the bridge transport this service needs. */
export type BoardIconFetcher = (
  url: string,
  options: {
    readonly timeoutMs: number;
    readonly accept?: string;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
  },
) => Promise<TransportResponse>;

export interface BoardIconService {
  resolve(iconId: string): Promise<BoardIconResolution>;
  /** Idempotent. Closes admission, aborts in-flight work, clears both caches. */
  dispose(): Promise<void>;
}

/**
 * One waiting request. `admit(true)` hands it a fetch slot that has ALREADY
 * been counted against the ceiling by whoever admitted it; `admit(false)` is
 * the shutdown path, and a request refused that way never took a slot and must
 * not release one.
 */
interface QueueEntry {
  readonly admit: (admitted: boolean) => void;
}

/**
 * Build a service over one fetcher.
 *
 * Exported for tests and for the mount below; production has exactly one
 * instance, owned by `setupAgentBridges`.
 */
export function createBoardIconService(fetcher: BoardIconFetcher): BoardIconService {
  const positive = new Map<string, string>();
  const negativeUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<BoardIconResolution>>();
  const controllers = new Set<AbortController>();
  const queue: QueueEntry[] = [];
  let active = 0;
  let closed = false;
  /** The one drain. Every `dispose()` caller joins it (see `dispose`). */
  let pendingDispose: Promise<void> | undefined;

  function rememberPositive(iconId: string, dataUrl: string): void {
    // Insertion-ordered Map as an LRU: re-inserting moves an entry to the end,
    // so the oldest key is always the first one iteration yields.
    positive.delete(iconId);
    positive.set(iconId, dataUrl);
    while (positive.size > POSITIVE_CACHE_MAX) {
      const oldest = positive.keys().next();
      if (oldest.done === true) break;
      positive.delete(oldest.value);
    }
  }

  function pump(): void {
    while (active < MAX_CONCURRENT_FETCHES) {
      const next = queue.shift();
      if (next === undefined) return;
      // The slot is taken HERE, by the pump, so the waiter wakes already
      // counted and no second increment can happen on its side.
      active += 1;
      next.admit(true);
    }
  }

  /** Acquire one of the two fetch slots, or refuse when the queue is full. */
  function acquireSlot(): Promise<boolean> {
    if (active < MAX_CONCURRENT_FETCHES) {
      active += 1;
      return Promise.resolve(true);
    }
    if (queue.length >= QUEUE_MAX) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      queue.push({ admit: resolve });
    });
  }

  function releaseSlot(): void {
    active -= 1;
    pump();
  }

  async function fetchOne(iconId: string): Promise<BoardIconResolution> {
    const admitted = await acquireSlot();
    // Not admitted: either the queue was full, or teardown woke every waiter.
    // Both are transient refusals rather than absences - the icon may well
    // exist, this instant simply had no room for it - but they are told apart
    // so a shutdown does not read as backpressure.
    if (!admitted) {
      return { kind: "unavailable", reason: closed ? "not_mounted" : "busy" };
    }
    // Admission can close while a request waits in the queue.
    if (closed) {
      releaseSlot();
      return { kind: "unavailable", reason: "not_mounted" };
    }

    const controller = new AbortController();
    controllers.add(controller);
    try {
      const url =
        `${CDN_ORIGIN}${CDN_PATH_PREFIX}${iconId}` +
        `?width=${REQUEST_WIDTH}&height=${REQUEST_HEIGHT}&fit=crop&quality=95&format=auto`;
      const response = await fetcher(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        accept: ACCEPT,
        maxBytes: BOARD_ICON_MAX_BYTES,
        signal: controller.signal,
      });
      return classify(iconId, response);
    } catch (cause) {
      // Every transport refusal from the bridge is typed, and the two that
      // matter here are told apart by CODE, never by message text.
      const code = errorCode(cause);
      if (code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP) {
        log.info(`[board-icons] refused id-bytes over ${BOARD_ICON_MAX_BYTES} bytes`);
        return { kind: "refused_by_policy", reason: "over_cap" };
      }
      // Timeout, cancellation, host refusal, disposal mid-flight. Nothing is
      // known about the icon, so nothing is cached and the card shows its
      // placeholder until something asks again.
      log.info(`[board-icons] icon fetch produced no usable response code=${code}`);
      return { kind: "unavailable", reason: "transport" };
    } finally {
      controllers.delete(controller);
      releaseSlot();
    }
  }

  /** Turn one response into the resolution, cache side effects included. */
  function classify(iconId: string, response: TransportResponse): BoardIconResolution {
    if (response.status === 404) {
      negativeUntil.set(iconId, Date.now() + BOARD_ICON_NOT_FOUND_TTL_MS);
      return { kind: "absent", reason: "not_found" };
    }
    if (response.status !== 200) {
      // A 5xx or a 429 says nothing about whether the icon exists.
      log.info(`[board-icons] icon endpoint answered status=${response.status}`);
      return { kind: "unavailable", reason: "transport" };
    }

    const declared = declaredMime(response.headers.get("content-type"));
    const validation = validateLockerImageBytes(response.body);
    if (!validation.ok) {
      log.info(`[board-icons] icon bytes refused kind=${validation.rejection.kind}`);
      return { kind: "refused_by_policy", reason: "unsupported_image" };
    }
    // MIME AND MAGIC BYTES MUST AGREE. Either alone is weaker than it looks: a
    // header is a claim by the host, and magic bytes alone would accept a
    // payload the host itself labelled something other than an image.
    if (declared !== validation.mime) {
      log.info(
        `[board-icons] icon refused: declared type disagrees with the bytes sniffed=${validation.mime}`,
      );
      return { kind: "refused_by_policy", reason: "unsupported_image" };
    }
    if (
      validation.width > BOARD_ICON_MAX_DIMENSION ||
      validation.height > BOARD_ICON_MAX_DIMENSION
    ) {
      log.info(
        `[board-icons] icon refused: ${validation.width}x${validation.height} is past the ${BOARD_ICON_MAX_DIMENSION} px board ceiling`,
      );
      return { kind: "refused_by_policy", reason: "unsupported_image" };
    }

    const dataUrl = `data:${validation.mime};base64,${Buffer.from(response.body).toString("base64")}`;
    rememberPositive(iconId, dataUrl);
    return { kind: "image", dataUrl };
  }

  return {
    async resolve(iconId: string): Promise<BoardIconResolution> {
      if (closed) return { kind: "unavailable", reason: "not_mounted" };

      const cached = positive.get(iconId);
      if (cached !== undefined) {
        rememberPositive(iconId, cached);
        return { kind: "image", dataUrl: cached };
      }
      const missUntil = negativeUntil.get(iconId);
      if (missUntil !== undefined) {
        if (missUntil > Date.now()) return { kind: "absent", reason: "not_found" };
        negativeUntil.delete(iconId);
      }

      // SINGLE-FLIGHT PER ID. Eight cards can name one token and a grid mounts
      // them in the same tick; without this the same asset would be fetched
      // eight times. Different ids proceed independently, bounded by the
      // concurrency ceiling rather than by each other.
      const running = inFlight.get(iconId);
      if (running !== undefined) return running;

      const attempt = fetchOne(iconId).finally(() => {
        inFlight.delete(iconId);
      });
      inFlight.set(iconId, attempt);
      return attempt;
    },

    dispose(): Promise<void> {
      // MEMOIZED, not early-returned. `if (closed) return;` resolved a second
      // caller IMMEDIATELY while the first was still draining, so the quit path
      // could dispose the bridge - Chromium session, hidden window and all -
      // under a fetch that was still running. Every caller joins the SAME drain.
      pendingDispose ??= (async () => {
        // Order matters: close admission BEFORE aborting, so nothing queued
        // starts a fetch into a service that is tearing down.
        closed = true;
        // Refused, not admitted: a queued request never held a slot, so waking
        // it with `true` would let it release one it never took.
        for (const waiting of queue.splice(0)) waiting.admit(false);
        for (const controller of controllers) controller.abort();
        // Drain: every in-flight attempt settles (as `unavailable`) rather than
        // being abandoned, so no fetch outlives the owner that started it.
        await Promise.allSettled([...inFlight.values()]);
        inFlight.clear();
        controllers.clear();
        positive.clear();
        negativeUntil.clear();
      })();
      return pendingDispose;
    },
  };
}

/** The media type a `content-type` header declares, without its parameters. */
function declaredMime(headerValue: string | undefined): string | null {
  if (headerValue === undefined) return null;
  // A parsing split, not a content cut: this removes the `; charset=...`
  // parameter section to read the type, and discards nothing a caller needs.
  const [type] = headerValue.split(";");
  return type === undefined ? null : type.trim().toLowerCase();
}

/** The typed code of a bridge refusal, or the error's class name. */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return cause instanceof Error ? cause.name : typeof cause;
}

// ── The mounted instance ──────────────────────────────────────────────────

let mounted: BoardIconService | null = null;

/**
 * Mount the one production instance and return its teardown.
 *
 * Called from `setupAgentBridges` with the DexScreener bridge's own `httpGet`,
 * because the bridge owns the Chromium session, the allowlist and the header
 * policy, and a second fetch path would be a second trust surface. The teardown
 * unmounts BEFORE disposing, so a call arriving during shutdown gets
 * `not_mounted` rather than racing a draining service.
 *
 * THE TEARDOWN IS ASYNC, AND ITS PROMISE IS THE POINT. `dispose()` drains what
 * is in flight, and those fetches run on the DexScreener bridge's transport.
 * Dropping this promise would let the caller dispose that bridge - Chromium
 * session, hidden window and all - underneath fetches that are still running.
 * Callers await it, and only then dispose the bridge it borrows from.
 * Idempotent: a second call unmounts nothing and `dispose()` returns at once.
 */
export function mountBoardIconService(fetcher: BoardIconFetcher): () => Promise<void> {
  const service = createBoardIconService(fetcher);
  mounted = service;
  return async () => {
    if (mounted === service) mounted = null;
    await service.dispose();
  };
}

/**
 * Resolve one icon through the mounted service.
 *
 * The IPC handler's single door. An unmounted service is a typed `unavailable`,
 * never a throw and never a silent empty image: a board opened before the agent
 * bridges finished mounting simply draws its placeholders.
 */
export async function resolveBoardIcon(iconId: string): Promise<BoardIconResolution> {
  const service = mounted;
  if (service === null) return { kind: "unavailable", reason: "not_mounted" };
  return service.resolve(iconId);
}
