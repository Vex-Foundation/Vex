/**
 * D4 live probe (rule 10): does the DexScreener v8 batch channel answer a
 * 64-hex Uniswap v4 pool id?
 *
 * The pair-id grammar was widened on the strength of live evidence: three
 * `labels:["v4"]` rows with a 64-hex `pairAddress` under `chainId: "ethereum"`
 * in a committed capture, a captured live v8 subscribe command carrying a
 * 64-hex id under the EVM slug `robinhood`, and a fresh 200 from the public
 * pairs endpoint (see `docs/dexscreener-friction-probes/
 * dexscreener-v4-pair-identity.json`). This probe re-establishes the claim on
 * the BATCH channel specifically and archives the exchange with provenance.
 *
 * Run it with tsx, which is how every other TypeScript script in this repo is
 * run and what makes the repo's own encoder and decoder reachable:
 *
 *   pnpm exec tsx scripts/probe-dexscreener-v4-pair-batch.ts <out-dir>
 *
 * DEPENDENCIES, deliberately none beyond the platform. It uses the global
 * `WebSocket` (Node 22+; this repo runs Node 24) rather than the `ws` package,
 * which is a TRANSITIVE dependency here and must not be imported by first-party
 * code. The cost is stated rather than hidden: the global client cannot set an
 * `Origin` header, so a refused handshake CANNOT distinguish bot protection
 * from a missing browser origin, and the artifact says so. A successful
 * handshake is unambiguous and is the result this probe exists to capture.
 *
 * The site transport itself is not reusable here: `defaultDexScreenerTransport`
 * throws `SITE_TRANSPORT_UNAVAILABLE` for `wsExchange` outside the desktop app,
 * which is exactly why this is a standalone probe and not a test.
 *
 * Politeness: ONE socket, ONE subscribe, ONE frame, a hard deadline, no
 * retries, then close.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encodeDexScreenerCommand } from "@tools/dexscreener/codec/encode.js";
import { decodeDexScreenerMessageToJson } from "@tools/dexscreener/codec/protobuf.js";

const OUT_DIR = process.argv[2];
if (OUT_DIR === undefined || OUT_DIR === "") {
  console.error("Usage: pnpm exec tsx scripts/probe-dexscreener-v4-pair-batch.ts <out-dir>");
  process.exit(2);
}

const URL_V8 = "wss://io.dexscreener.com/dex/screener/v8/pairs-search";
/** A live-captured Uniswap v4 pool id, from `token-pairs-v1-ethereum-weth.json`. */
const V4_POOL_ID =
  "0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657";
const IDS = [{ chainId: "ethereum", id: V4_POOL_ID }] as const;
const DEADLINE_MS = 20_000;

const command = encodeDexScreenerCommand("dex_screener.PairsSearchChannelCommand", {
  subscribe: {
    ids: IDS.map((entry) => ({ ...entry })),
    filters: { excludedDEXIds: [""] },
    rankBy: { key: 1, order: 1 },
    timeframe: 4,
    page: 1,
  },
});

interface Outcome {
  readonly frames: readonly Uint8Array[];
  readonly failure: string | null;
  readonly opened: boolean;
}

async function exchange(): Promise<Outcome> {
  return await new Promise<Outcome>((resolve) => {
    const socket = new WebSocket(URL_V8);
    socket.binaryType = "arraybuffer";
    const frames: Uint8Array[] = [];
    let failure: string | null = null;
    let opened = false;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closing
      }
      resolve({ frames, failure, opened });
    };

    const timer = setTimeout(() => {
      failure = failure ?? `no frame within ${DEADLINE_MS} ms`;
      finish();
    }, DEADLINE_MS);

    socket.addEventListener("open", () => {
      opened = true;
      socket.send(command);
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer) frames.push(new Uint8Array(data));
      else failure = `unexpected non-binary frame of type ${typeof data}`;
      finish();
    });
    socket.addEventListener("error", () => {
      // The DOM event carries no cause; the close event below usually does.
      failure = failure ?? "socket error before any frame arrived";
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (frames.length === 0) {
        failure = failure
          ?? `closed before any frame: code ${event.code}${event.reason ? ` (${event.reason})` : ""}`;
      }
      finish();
    });
  });
}

const started = new Date().toISOString();
const { frames, failure, opened } = await exchange();

let decoded: unknown = null;
let decodeError: string | null = null;
if (frames.length > 0) {
  const first = frames[0];
  if (first !== undefined) {
    try {
      decoded = decodeDexScreenerMessageToJson(
        "dex_screener.PairsChannelMessage",
        first,
        { maxBytes: 4_000_000 },
      );
    } catch (err) {
      decodeError = err instanceof Error ? err.message : String(err);
    }
  }
}

/** Every `pairAddress` the decoded frame carried, without assuming a shape. */
function returnedPairAddresses(message: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "pairAddress" && typeof value === "string") out.push(value);
      else walk(value);
    }
  };
  walk(message);
  return out;
}

const addresses = returnedPairAddresses(decoded);
const answered = addresses.some((id) => id.toLowerCase() === V4_POOL_ID);

const verdict = failure !== null || frames.length === 0
  ? "NOT MEASURED"
  : decodeError !== null
    ? "FRAME RECEIVED BUT NOT DECODABLE"
    : answered
      ? "PROVIDER ANSWERS THE 64-HEX PAIR ID"
      : "PROVIDER RETURNED NO MATCHING ROW";

const firstFrame = frames[0];
const artifact = {
  probe: "dexscreener-v8-batch-v4-pair-id",
  question: "Does the live v8 batch channel answer a 0x + 64 hex Uniswap v4 pool id?",
  verdict,
  provenance: {
    startedIso: started,
    finishedIso: new Date().toISOString(),
    endpoint: URL_V8,
    method: "platform WebSocket, one binary subscribe frame, NO Origin header (see script header)",
    handshakeOpened: opened,
    nodeVersion: process.version,
  },
  limitation:
    "The platform WebSocket client cannot set an Origin header. A REFUSED handshake here "
    + "therefore cannot separate bot protection from the missing browser origin; only a "
    + "successful exchange is conclusive.",
  sentIds: IDS,
  sentCommandSha256: createHash("sha256").update(command).digest("hex"),
  sentCommandBase64: Buffer.from(command).toString("base64"),
  frameCount: frames.length,
  frameBytes: frames.map((frame) => frame.byteLength),
  firstFrameSha256:
    firstFrame === undefined ? null : createHash("sha256").update(firstFrame).digest("hex"),
  returnedPairAddresses: addresses,
  decodeError,
  failure,
};

await mkdir(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, "dexscreener-v8-batch-v4-pair-id.json");
await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(`${verdict}. frames=${frames.length} opened=${opened} failure=${failure ?? "none"}`);
console.log(`Archived: ${file}`);
