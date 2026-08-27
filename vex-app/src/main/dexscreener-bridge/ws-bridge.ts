/**
 * WebSocket half of the DexScreener site bridge.
 *
 * The main process has no Chromium WebSocket, and Node WebSocket clients are
 * refused by the site's edge on the TLS fingerprint. The measured way in
 * (evidence/report-electron-spike.md, main4.cjs) is a hidden, sandboxed,
 * context-isolated window in its own session, with `Origin:
 * https://dexscreener.com` injected by `webRequest.onBeforeSendHeaders` for
 * that partition only: the screener channel opened and delivered a 106 KB frame
 * in 648 ms with no remote code loaded.
 *
 * The spike loaded a `data:` URL. Production may not: the project's Electron
 * security rule allows only `app://vex/` documents. This bridge therefore
 * registers an `app` protocol handler ON ITS OWN SESSION that serves exactly
 * one in-memory document at `app://vex/dexscreener-bridge` and 404s everything
 * else. It never touches the filesystem, so it has no traversal surface at all,
 * and the app-wide handler on the default session is untouched.
 *
 * LIFECYCLE OWNER: `DexScreenerWsBridge`. It owns the session, the header
 * hook, the hidden window and every in-flight exchange, and `dispose()` is the
 * one place any of them are released. Nothing here outlives it:
 *
 *  - the window is created lazily on the first exchange and reused;
 *  - the session carries TWO webRequest hooks, both detached by `dispose()`:
 *    `onBeforeSendHeaders` injects the site's Origin, and `onHeadersReceived`
 *    reads the WebSocket handshake status, which the page's own `WebSocket`
 *    cannot see and which is the only way a refused upgrade (HTTP 422) is
 *    distinguishable from a dead socket;
 *  - `dispose()` is idempotent: it closes admission, then destroys the window,
 *    which makes every in-flight exchange reject with a typed transport
 *    failure rather than hang, and detaches the header hook;
 *  - each exchange owns its own deadline timer and page-side abort, and clears
 *    both on every exit path;
 *  - identical concurrent URLs are single-flighted; different URLs run up to
 *    `MAX_CONCURRENT_EXCHANGES` and are rejected by name beyond that (reject,
 *    not queue: a queued market snapshot is a stale one).
 */

import { BrowserWindow, session as electronSession } from "electron";
import { createHash, randomUUID } from "node:crypto";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import type { WsExchangeOptions } from "@tools/dexscreener/transport.js";
import {
  checkWsUrl,
  DEXSCREENER_ORIGIN,
  ORIGIN_INJECTION_URL_PATTERNS,
} from "./allowlist.js";
import { CHROME_USER_AGENT } from "./http.js";

/** Partition name. Its own jar, its own header hook, shared with nothing. */
export const BRIDGE_PARTITION = "dexscreener-bridge";

/** The only document the bridge window ever loads. */
const BRIDGE_URL = "app://vex/dexscreener-bridge";

/**
 * Concurrent exchanges across all URLs. The measured channels push a full
 * snapshot every ~3.2 s at ~29 KB/s each; four at once is comfortably inside
 * one window's budget and is a ceiling, not a target.
 */
const MAX_CONCURRENT_EXCHANGES = 4;

/** How long the bridge document itself may take to load. */
const PAGE_LOAD_TIMEOUT_MS = 15_000;

const BRIDGE_DOCUMENT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>vex-dexscreener-bridge</title></head>
<body></body></html>
`;

/**
 * The page-side runtime, injected once per window load.
 *
 * It is injected rather than inlined in the document so the document can keep a
 * `default-src 'none'` CSP: nothing the page itself declares may execute or
 * load. It opens the socket, answers the site's `"ping"` keepalive with
 * `"pong"` (measured: every channel sends one about every 27 s and closes the
 * connection without it), collects binary frames up to the caller's bounds, and
 * closes. Frames come back as base64 because only structured-cloneable values
 * survive `executeJavaScript`.
 *
 * Exported so the frame-accounting regression can evaluate this exact source
 * against a scripted socket. A fake `BridgeWindow` stubs the runtime out, so
 * nothing else in the suite executes the message handler that decides which
 * frames count.
 */
export const PAGE_RUNTIME = `
(() => {
  if (window.__vexDsBridge) return true;
  const sockets = new Map();
  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };
  window.__vexDsBridge = {
    open(id, url, sendFrames, binaryFrames, maxTotalBytes) {
      return new Promise((resolve) => {
        let socket;
        try {
          socket = new WebSocket(url);
        } catch (error) {
          resolve({ outcome: "failed", detail: "socket-construction", frames: [] });
          return;
        }
        socket.binaryType = "arraybuffer";
        sockets.set(id, socket);
        const frames = [];
        let total = 0;
        let settled = false;
        const finish = (outcome, detail) => {
          if (settled) return;
          settled = true;
          sockets.delete(id);
          try { socket.close(); } catch (error) { /* already closing */ }
          resolve({ outcome: outcome, detail: detail, frames: frames });
        };
        socket.onopen = () => {
          for (const frame of sendFrames) {
            if (typeof frame === "string") socket.send(frame);
            else socket.send(Uint8Array.from(atob(frame.b64), (c) => c.charCodeAt(0)));
          }
        };
        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            if (event.data === '"ping"' || event.data === "ping") socket.send('"pong"');
            return;
          }
          // Zero-length BINARY frames are the site's own keepalive (measured on
          // feed/ws: real binary frames of length 0 at a ~17/31/47 s cadence).
          // They carry no payload, so they must not consume the caller's frame
          // budget: counting them discarded the real answer and timed out.
          if (event.data.byteLength === 0) return;
          total += event.data.byteLength;
          if (total > maxTotalBytes) {
            finish("over_cap", String(total));
            return;
          }
          frames.push(toBase64(event.data));
          if (frames.length >= binaryFrames) finish("complete", "");
        };
        socket.onerror = () => finish("failed", "socket-error");
        socket.onclose = (event) => finish("closed", String(event.code));
      });
    },
    abort(id) {
      const socket = sockets.get(id);
      if (socket === undefined) return false;
      sockets.delete(id);
      try { socket.close(); } catch (error) { /* already closing */ }
      return true;
    },
  };
  return true;
})();
`;

interface PageResult {
  readonly outcome: "complete" | "over_cap" | "closed" | "failed";
  readonly detail: string;
  readonly frames: string[];
}

/**
 * The exact session surface the bridge and its HTTP half drive.
 *
 * Narrow on purpose: the test fake implements it directly and Electron's real
 * `Session` satisfies it structurally, so no unsafe cast sits between a fake
 * and this contract. Method syntax throughout - parameter bivariance is what
 * lets Electron's richer listener detail types satisfy the narrower ones here.
 */
export interface BridgeSession {
  setUserAgent(userAgent: string): void;
  readonly webRequest: {
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener:
        | ((
            details: { url: string; requestHeaders: Record<string, string> },
            callback: (response: { requestHeaders?: Record<string, string> }) => void,
          ) => void)
        | null,
    ): void;
    onBeforeSendHeaders(listener: null): void;
    onHeadersReceived(
      filter: { urls: string[] },
      listener:
        | ((
            details: { url: string; statusCode: number },
            callback: (response: object) => void,
          ) => void)
        | null,
    ): void;
    onHeadersReceived(listener: null): void;
  };
  setPermissionCheckHandler(handler: (() => boolean) | null): void;
  setPermissionRequestHandler(
    handler:
      | ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | null,
  ): void;
  setDevicePermissionHandler(handler: (() => boolean) | null): void;
  readonly protocol: {
    handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
    unhandle(scheme: string): void;
  };
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Minimal surface of `session` and `BrowserWindow` the bridge uses, for testing. */
export interface BridgeRuntime<S extends BridgeSession = BridgeSession> {
  fromPartition(partition: string): S;
  createWindow(session: S): BridgeWindow;
}

/** The hidden window, reduced to what the bridge drives. */
export interface BridgeWindow {
  load(url: string): Promise<void>;
  run<T>(script: string): Promise<T>;
  destroy(): void;
  isUsable(): boolean;
}

const electronRuntime: BridgeRuntime<Electron.Session> = {
  fromPartition: (partition) => electronSession.fromPartition(partition),
  createWindow(session) {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        session,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        backgroundThrottling: false,
        images: false,
        webgl: false,
        spellcheck: false,
      },
    });
    // Nothing may navigate, open a window, or ask for a permission. The page
    // has one job and no user.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    return {
      load: (url) => window.loadURL(url),
      run: <T,>(script: string) =>
        window.webContents.executeJavaScript(script, true) as Promise<T>,
      destroy: () => {
        if (!window.isDestroyed()) window.destroy();
      },
      isUsable: () => !window.isDestroyed(),
    };
  },
};

export class DexScreenerWsBridge {
  private session: BridgeSession | null = null;
  private window: BridgeWindow | null = null;
  private loading: Promise<BridgeWindow> | null = null;
  private readonly inFlight = new Map<string, Promise<Uint8Array[]>>();
  /**
   * Upgrade status observed for each in-flight channel URL.
   *
   * A browser `WebSocket` never exposes the handshake status: a refused upgrade
   * and a dead network both surface as `onerror`. The bridge owns this session,
   * though, so it can watch the handshake response itself and keep the one fact
   * the page cannot see. Bounded by construction: an entry is created when an
   * exchange starts and deleted when it ends, so this map never holds more than
   * `MAX_CONCURRENT_EXCHANGES` entries.
   */
  private readonly upgradeStatus = new Map<string, number>();
  /**
   * How many in-flight exchanges are using each `upgradeStatus` slot.
   *
   * Different commands can now share one URL (see the exchange key), so the
   * slot outlives whichever exchange finishes first.
   */
  private readonly upgradeClaims = new Map<string, number>();
  /** The session holding this bridge's `app://` handler, until dispose. */
  private protocolHandled: BridgeSession | null = null;
  private disposed = false;

  constructor(private readonly runtime: BridgeRuntime = electronRuntime) {}

  /**
   * Open `url`, send what the caller asked, collect the frames it expects.
   *
   * Rejects with a typed outcome for every failure: refused URL, bridge
   * disposed, too many concurrent exchanges, over cap, cancelled, timed out,
   * or a channel that closed before delivering.
   */
  async exchange(url: string, options: WsExchangeOptions): Promise<Uint8Array[]> {
    if (this.disposed) {
      throw siteError(
        DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
        "The DexScreener bridge has been disposed and accepts no new exchanges",
        "The app is shutting down or the bridge was torn down; nothing was sent."
      );
    }
    const decision = checkWsUrl(url);
    if (!decision.allowed) {
      throw siteError(
        DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED,
        `The DexScreener bridge refused to open this channel: ${decision.reason}`,
        "Only the measured DexScreener WebSocket channels are reachable through the bridge."
      );
    }
    const resolvedUrl = decision.url.toString();
    /*
     * S10-61. THE URL ALONE IS NOT THE IDENTITY OF AN EXCHANGE.
     *
     * The feed channel takes its query as a COMMAND FRAME, not as a query
     * string, so several different requests share one URL:
     * `feed/ws getHistoricalTransactions` and `getHistoricalBars` are the same
     * endpoint with different bytes on the wire. Coalescing on the URL made two
     * concurrent, genuinely different exchanges join, and the joiner was
     * returned the FIRST caller's frames - an answer to a question it never
     * asked, decoded against its own schema, with nothing anywhere marking it
     * as someone else's data. That is the worst failure shape this bridge has:
     * silently correct-looking wrong data.
     *
     * The key is therefore the URL plus a digest of everything that decides
     * what comes back: the frames sent and the expectations the collector stops
     * on. Two callers coalesce only when they would have sent identical bytes
     * and accepted identical answers, which is the case single-flight exists
     * for (the same snapshot fetched twice) and no other.
     */
    const key = `${resolvedUrl}\n${this.exchangeDigest(options)}`;

    // Single-flight: an identical concurrent request joins the running one
    // rather than opening a second socket for the same snapshot.
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;

    if (this.inFlight.size >= MAX_CONCURRENT_EXCHANGES) {
      throw siteError(
        DexScreenerSiteErrorCodes.TRANSPORT_FAILED,
        `The DexScreener bridge already has ${this.inFlight.size} exchanges open, its ceiling`,
        "Retry once one finishes. Requests are refused rather than queued so a returned snapshot is never a stale one."
      );
    }

    // Claim the status slot BEFORE the socket exists, so the handshake hook has
    // somewhere to write; released with the exchange on every exit path.
    //
    // KEYED BY URL AND NOT BY `key`, because the header hook sees only the
    // URL. Two different commands can now be in flight on one URL, so the slot
    // is reference-counted: releasing on the first completion would delete a
    // slot the other exchange is still writing into.
    this.claimUpgradeSlot(resolvedUrl);
    const exchange = this.runExchange(resolvedUrl, options).finally(() => {
      this.inFlight.delete(key);
      this.releaseUpgradeSlot(resolvedUrl);
    });
    this.inFlight.set(key, exchange);
    return exchange;
  }

  /**
   * A stable digest of everything that decides what an exchange returns.
   *
   * Not a security boundary and not a hash of secrets: it exists so that two
   * DIFFERENT requests cannot be mistaken for one. Binary frames are digested
   * as bytes, text frames as text, and the expectations are included because a
   * caller asking for two frames must not be handed a one-frame result
   * collected for somebody else.
   *
   * `coalesceScope` joins the digest when the caller sets one, because WHO owns
   * the socket decides whose signal and whose deadline control it. A scoped
   * caller therefore never joins an unscoped one and never joins a differently
   * scoped one. An ABSENT scope contributes nothing at all - not an empty
   * string, not a marker - so the digest of every call that existed before this
   * option is byte-identical to what it was.
   */
  private exchangeDigest(options: WsExchangeOptions): string {
    const hash = createHash("sha256");
    for (const frame of options.send ?? []) {
      if (typeof frame === "string") {
        hash.update("s:");
        hash.update(frame, "utf8");
      } else {
        hash.update("b:");
        hash.update(Buffer.from(frame));
      }
      hash.update("\u0000");
    }
    hash.update(
      `expect:${options.expect.binaryFrames}:${options.expect.maxTotalBytes}`
    );
    if (options.coalesceScope !== undefined) {
      // The delimiter is written as an ESCAPE, never as the raw byte: a literal
      // NUL in the source is invisible in a diff and unreviewable. These are
      // the same seven bytes the digest has always mixed in (0x00 then
      // "scope:"), pinned by `ws-bridge-coalesce-scope.test.ts`.
      hash.update("\u0000scope:");
      hash.update(options.coalesceScope, "utf8");
    }
    return hash.digest("hex");
  }

  /** Open a handshake-status slot for `url`, counting concurrent claimants. */
  private claimUpgradeSlot(url: string): void {
    this.upgradeClaims.set(url, (this.upgradeClaims.get(url) ?? 0) + 1);
    if (!this.upgradeStatus.has(url)) this.upgradeStatus.set(url, 0);
  }

  /** Release one claim, dropping the slot only when the last one leaves. */
  private releaseUpgradeSlot(url: string): void {
    const claims = (this.upgradeClaims.get(url) ?? 1) - 1;
    if (claims <= 0) {
      this.upgradeClaims.delete(url);
      this.upgradeStatus.delete(url);
      return;
    }
    this.upgradeClaims.set(url, claims);
  }

  /**
   * The bridge's own session, configured on first use.
   *
   * The HTTP half shares it, so both halves present one client identity and one
   * cookie jar to the site and the session has exactly one owner.
   */
  sessionForRequests(): BridgeSession {
    if (this.session === null) this.session = this.createSession();
    return this.session;
  }

  /**
   * Idempotent teardown.
   *
   * Admission closes first (`disposed`), so no new exchange can start midway.
   * Destroying the window rejects the page promise of every exchange still
   * running, which surfaces as a typed transport failure at their callers: no
   * exchange is left hanging and none reports a partial result as complete.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inFlight.clear();
    const window = this.window;
    this.window = null;
    this.loading = null;
    window?.destroy();
    const session = this.session;
    this.session = null;
    this.upgradeStatus.clear();
    this.upgradeClaims.clear();
    session?.webRequest.onBeforeSendHeaders(null);
    session?.webRequest.onHeadersReceived(null);
    // Idempotent by construction: the reference is cleared before the call, so
    // a second dispose finds nothing to unhandle. `unhandle` throws when the
    // scheme is not registered, which a partially-constructed session can
    // produce, and that must not stop the rest of teardown.
    const handled = this.protocolHandled;
    this.protocolHandled = null;
    if (handled !== null) {
      try {
        handled.protocol.unhandle("app");
      } catch {
        // Already unregistered, or a session torn down beneath us. Either way
        // the claim this dispose exists to release is gone.
      }
    }
  }

  private async runExchange(
    url: string,
    options: WsExchangeOptions
  ): Promise<Uint8Array[]> {
    const window = await this.ensureWindow();
    const id = randomUUID();
    const sendFrames = (options.send ?? []).map((frame) =>
      typeof frame === "string"
        ? frame
        : { b64: Buffer.from(frame).toString("base64") }
    );

    let timedOut = false;
    const abortInPage = (): void => {
      if (!window.isUsable()) return;
      void window
        .run(`window.__vexDsBridge.abort(${JSON.stringify(id)})`)
        .catch(() => undefined);
    };
    const onAbort = (): void => abortInPage();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abortInPage();
    }, options.timeoutMs);

    try {
      if (options.signal?.aborted === true) {
        throw siteError(
          DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
          `The exchange with ${new URL(url).host} was cancelled before it opened`,
          "Nothing was sent."
        );
      }
      const script = `window.__vexDsBridge.open(${JSON.stringify(id)}, ${JSON.stringify(
        url
      )}, ${JSON.stringify(sendFrames)}, ${options.expect.binaryFrames}, ${
        options.expect.maxTotalBytes
      })`;
      const result = await window.run<PageResult>(script);
      return this.interpret(url, options, result, timedOut);
    } catch (error) {
      if (isDexScreenerSiteError(error)) throw error;
      const refusal = this.upgradeRefusal(url);
      if (refusal !== null) throw refusal;
      if (timedOut) throw this.timeoutError(url, options.timeoutMs);
      if (options.signal?.aborted === true) throw this.cancelledError(url);
      throw siteError(
        DexScreenerSiteErrorCodes.TRANSPORT_FAILED,
        `The DexScreener bridge could not complete the exchange with ${new URL(url).host}`,
        "The bridge window failed to run the exchange. No frames were received."
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private interpret(
    url: string,
    options: WsExchangeOptions,
    result: PageResult,
    timedOut: boolean
  ): Uint8Array[] {
    const host = new URL(url).host;
    if (result.outcome === "complete") {
      return result.frames.map((frame) =>
        Uint8Array.from(Buffer.from(frame, "base64"))
      );
    }
    if (result.outcome === "over_cap") {
      throw siteError(
        DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP,
        `The channel at ${host} sent ${result.detail} bytes, over the caller's cap of ${options.expect.maxTotalBytes} bytes`,
        "Raise maxTotalBytes or ask for fewer frames. The frames were discarded whole, not truncated."
      );
    }
    // A refused upgrade outranks both, because it is not a deadline the caller
    // can extend nor a cancellation: the request never became a socket at all.
    const refusal = this.upgradeRefusal(url);
    if (refusal !== null) throw refusal;
    if (timedOut) throw this.timeoutError(url, options.timeoutMs);
    if (options.signal?.aborted === true) throw this.cancelledError(url);
    throw siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_FAILED,
      `The channel at ${host} delivered ${result.frames.length} of ${options.expect.binaryFrames} expected frames before it ${
        result.outcome === "closed" ? `closed (code ${result.detail})` : "failed"
      }`,
      "The channel ended early. Nothing partial is returned, because a short frame set is indistinguishable from a complete one at this layer."
    );
  }

  /**
   * The typed refusal for this URL when the provider rejected the handshake,
   * or null when it did not.
   *
   * Only 422 qualifies. Any other non-101 status is left to the ordinary
   * transport classification rather than being guessed at: naming a cause we
   * did not measure would be worse than the generic failure.
   */
  private upgradeRefusal(url: string): Error | null {
    if (this.upgradeStatus.get(url) !== 422) return null;
    return siteError(
      DexScreenerSiteErrorCodes.WS_UPGRADE_REFUSED,
      `The provider refused the WebSocket upgrade at ${new URL(url).host} with HTTP 422 and an empty body, which is how it rejects a request it cannot parse`,
      "This is a permanent refusal of the request as spelled, not an outage: retrying it unchanged will fail identically. The measured causes are all vocabulary: a sort key, sort direction, timeframe or filter value outside what the channel accepts, the right key in the wrong case, or a non-numeric page. The provider gives no reason of its own."
    );
  }

  private timeoutError(url: string, timeoutMs: number): Error {
    return siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
      `The channel at ${new URL(url).host} did not deliver the expected frames within ${timeoutMs} ms`,
      "Retry with a longer timeoutMs. The first frame on the screener channel is usually latestBlock, so ask for enough frames to include the payload."
    );
  }

  private cancelledError(url: string): Error {
    return siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
      `The exchange with ${new URL(url).host} was cancelled by the caller`,
      "The socket was closed; no partial result is reported."
    );
  }

  /** Create the session, hook and window once; reuse them for every exchange. */
  private ensureWindow(): Promise<BridgeWindow> {
    if (this.window !== null && this.window.isUsable()) {
      return Promise.resolve(this.window);
    }
    if (this.loading !== null) return this.loading;

    this.loading = (async () => {
      const session = this.session ?? this.createSession();
      this.session = session;
      const window = this.runtime.createWindow(session);
      try {
        await withTimeout(
          window.load(BRIDGE_URL),
          PAGE_LOAD_TIMEOUT_MS,
          "the bridge document did not load"
        );
        await window.run<boolean>(PAGE_RUNTIME);
      } catch (error) {
        window.destroy();
        throw isDexScreenerSiteError(error)
          ? error
          : siteError(
              DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
              "The DexScreener bridge window could not be prepared",
              "The hidden bridge document failed to load. No request was sent to the provider."
            );
      }
      /*
       * S10-62. DISPOSAL CAN LAND WHILE THIS AWAIT IS OUTSTANDING.
       *
       * `dispose()` sets `window = null` and `loading = null` and destroys what
       * it has, but a creation already in flight resumes afterwards and used to
       * assign its brand-new window onto a disposed bridge - resurrecting a
       * live BrowserWindow and an Electron session that nothing would ever
       * destroy again, because dispose is idempotent and had already run. The
       * window this branch built is therefore checked against the disposal it
       * may have raced, and is destroyed rather than published.
       */
      if (this.disposed) {
        window.destroy();
        throw siteError(
          DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
          "The DexScreener bridge was disposed while its window was being prepared",
          "No request was sent to the provider. This happens when the app shuts down mid-call; nothing needs to be retried."
        );
      }
      this.window = window;
      return window;
    })().finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  private createSession(): BridgeSession {
    const session = this.runtime.fromPartition(BRIDGE_PARTITION);
    session.setUserAgent(CHROME_USER_AGENT);
    // The one privileged thing this bridge does: present the site's own Origin,
    // for one host, on this session only.
    session.webRequest.onBeforeSendHeaders(
      { urls: [...ORIGIN_INJECTION_URL_PATTERNS] },
      (details, callback) => {
        callback({
          requestHeaders: { ...details.requestHeaders, Origin: DEXSCREENER_ORIGIN },
        });
      }
    );
    // The handshake response the page cannot see. A WebSocket upgrade is an
    // ordinary HTTP request on this session, so its status is observable here
    // and nowhere else: 422 with an empty body is the provider refusing the
    // caller's grammar, which is permanent, while an error the page reports
    // without a recorded status is an ordinary transport failure worth
    // retrying. Nothing is modified; this hook only reads.
    session.webRequest.onHeadersReceived(
      { urls: [...ORIGIN_INJECTION_URL_PATTERNS] },
      (details, callback) => {
        if (this.upgradeStatus.has(details.url)) {
          this.upgradeStatus.set(details.url, details.statusCode);
        }
        callback({});
      }
    );
    // Everything a page could ask for is denied; this one asks for nothing.
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    );
    session.setDevicePermissionHandler(() => false);
    // The bridge document is served from memory on THIS session only. No file
    // system is reachable, so there is no traversal surface.
    session.protocol.handle("app", (request) => {
      const url = new URL(request.url);
      if (url.host === "vex" && url.pathname === "/dexscreener-bridge") {
        return new Response(BRIDGE_DOCUMENT, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; connect-src wss://io.dexscreener.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });
    // S10-63: acquired here, released in dispose(). An Electron protocol
    // handler is registered ON THE SESSION and outlives this object otherwise,
    // so a disposed bridge left `app://` claimed on a partition a later bridge
    // reuses, and the second `protocol.handle` for the same scheme is the one
    // that throws.
    this.protocolHandled = session;
    return session;
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  what: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              siteError(
                DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
                `${what} within ${timeoutMs} ms`,
                "The bridge could not be prepared; no request was sent to the provider."
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
