/**
 * The app wrapper owns engine info/warn/error output in both its dev console
 * and file log. The bridge suppresses those levels in the engine stderr sink;
 * standalone runs and unforwarded debug levels keep their stderr output.
 * Forwarding is one-way and redacted before either app transport sees it.
 */

// winston-transport is the documented base class for custom transports and
// ships as winston's own dependency; the repo's `node-linker=hoisted` .npmrc
// guarantees flat resolution from the root tree (same tree winston bundles
// from — see rules/80-edge-cases.md §4).
import TransportStream from "winston-transport";
import { logger as engineLogger, setForwardedLogLevels } from "@utils/logger.js";
import { log } from "../logger/index.js";

/** Raw (un-colorized) level — winston stores it under this well-known symbol. */
const LEVEL_KEY: symbol = Symbol.for("level");

/**
 * Keys stripped from the forwarded meta: `level`/`message` are carried in the
 * line itself, `timestamp` is re-stamped by electron-log, and `service` is the
 * engine logger's constant defaultMeta ("vex-agent").
 */
const META_EXCLUDE_KEYS: ReadonlySet<string> = new Set([
  "level",
  "message",
  "timestamp",
  "service",
]);

/** Forward error/warn/info; debug and below never cross into the file sink. */
const ENGINE_FORWARD_LEVEL = "info";

/**
 * Synchronous re-entrancy guard. The structural no-loop invariant is that
 * electron-log never writes through winston (zero imports in that direction —
 * pinned by the bridge test's write-spy); this guard additionally stops a
 * same-tick synchronous re-entry into the forward (e.g. a future sink hook
 * misbehaving inside the call). It cannot catch a DEFERRED write-back —
 * only the import-direction invariant prevents that.
 */
let forwarding = false;

function forwardToElectronLog(info: Record<string | symbol, unknown>): void {
  if (forwarding) return;

  const levelRaw = info[LEVEL_KEY] ?? info["level"];
  const level = typeof levelRaw === "string" ? levelRaw : "";
  const sink =
    level === "error"
      ? log.error
      : level === "warn"
        ? log.warn
        : level === "info"
          ? log.info
          : null;
  if (sink === null) return;

  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (!META_EXCLUDE_KEYS.has(key)) meta[key] = value;
  }

  const line = `[engine] ${String(info["message"])}`;
  forwarding = true;
  try {
    // Meta goes through as an object so the wrapper's redactArgs applies
    // full key-based + pattern-based scrubbing before electron-log
    // serializes it (compact JSON) onto the file line.
    if (Object.keys(meta).length > 0) {
      sink(line, meta);
    } else {
      sink(line);
    }
  } finally {
    forwarding = false;
  }
}

class EngineLogForwardTransport extends TransportStream {
  public override log(
    info: Record<string | symbol, unknown>,
    next: () => void,
  ): void {
    forwardToElectronLog(info);
    next();
  }
}

let installedTransport: EngineLogForwardTransport | null = null;

/**
 * Install the forwarding transport on the in-process engine logger. Idempotent
 * (module-level guard) so a hot-reload or double wiring can never double the
 * file output. Call EARLY in `main/index.ts` — after `configureLogger()`,
 * before any worker/IPC code can touch engine modules.
 */
export function installEngineLogBridge(): void {
  if (installedTransport !== null) return;
  installedTransport = new EngineLogForwardTransport({
    level: ENGINE_FORWARD_LEVEL,
  });
  engineLogger.add(installedTransport);
  setForwardedLogLevels(["error", "warn", "info"]);
}

/** Test-only teardown — removes the transport and re-arms the install guard. */
export function __resetEngineLogBridgeForTests(): void {
  if (installedTransport === null) return;
  setForwardedLogLevels([]);
  engineLogger.remove(installedTransport);
  installedTransport = null;
}
