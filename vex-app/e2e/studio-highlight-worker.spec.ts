/**
 * The Studio highlight worker, EXECUTED inside the built Electron app.
 *
 * ## What the build gate could not prove
 *
 * `scripts/check-build-artifacts.mjs` gate 3b asserts two static facts about a
 * finished build: the renderer CSP pins `worker-src` to `'self'`, and a
 * `highlight.worker-<hash>.js` chunk was emitted once anything in the renderer
 * can reach it. Both are necessary and neither is execution. An emitted chunk
 * that throws while its module graph evaluates - a bad grammar import, a
 * `format: "iife"` regression that removes dynamic `import()`, a CSP that grew
 * a directive the worker trips over - passes that gate and still leaves every
 * file in the viewer uncoloured, because `highlighter-port.ts` answers every
 * failure as `{ ok: false, reason }` rather than by throwing. A degradation
 * that is honest to the user is invisible to a test suite that never runs it.
 *
 * So this spec runs it: real built chunk, real `app://vex` origin, real CSP,
 * real shiki grammar load, real structured clone back.
 *
 * ## Why it does not go through the viewer UI
 *
 * Reaching the file viewer needs the shell, which needs the diagnostic setup
 * tour (`VITE_VEX_SETUP_TOUR=1`, `studio.spec.ts`), and then a project, which
 * needs a Postgres this fixture deliberately has not got. Gating the worker's
 * only execution proof behind a dev-only build flag would mean an ordinary
 * `pnpm test:e2e` proves nothing about it. The worker is a renderer-process
 * capability rather than a screen, so it is proven where it lives: in the
 * shell document, whose CSP is the policy that governs it either way. When the
 * DB gate in `studio.spec.ts` opens and the viewer arm is written, THAT test
 * will prove the port and the session on top of what this one proves about the
 * worker itself.
 *
 * ## The URL is the app's own, not a lookalike
 *
 * `highlighter-port.ts` builds the worker from
 * `new URL("./highlight.worker.ts", import.meta.url)`, which Vite rewrites at
 * build time into the hashed chunk name resolved against the importing chunk's
 * own URL - and every renderer chunk lives in `dist/renderer/assets/`. So the
 * app's worker URL is `<assets>/highlight.worker-<hash>.js`. This spec derives
 * the same name from the built output with the same regex the build gate uses,
 * and then CHECKS the derivation: the name must also appear verbatim inside a
 * different built bundle, which is the app's own `new URL(...)` argument. A
 * name that no bundle references would be a stale artifact, and constructing a
 * worker from it would prove nothing about what the app runs.
 *
 * ## A CSP violation FAILS
 *
 * The document's `securitypolicyviolation` events are collected across the
 * whole construction and exchange and asserted empty. A `worker-src` that
 * stopped allowing `'self'` therefore turns this red, rather than turning it
 * into a silent skip or a timeout with no cause.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type VexElectronFixture } from "./fixtures/electron-app.js";
import type { TestInfo } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where `vite.renderer.config.ts` writes the renderer build. */
const RENDERER_ASSETS = path.resolve(__dirname, "../dist/renderer/assets");

/**
 * The emitted worker entry name, as `worker.rolldownOptions.output.entryFileNames`
 * spells it. Same pattern as `HIGHLIGHT_WORKER_CHUNK` in
 * `scripts/check-privileged-bundles.mjs`, on purpose: if the build ever renames
 * the chunk, the build gate and this spec must go red together rather than one
 * silently passing on a file the other cannot find.
 */
const HIGHLIGHT_WORKER_CHUNK = /^highlight\.worker-[A-Za-z0-9_-]+\.js$/;

/**
 * The sample. Small, real TypeScript, and LF-only so the round-trip below has
 * one definition of a line ending.
 *
 * `export`, `const` and the string literal are three different grammar scopes,
 * which is what makes "at least one coloured token" evidence that a TextMate
 * grammar actually ran rather than that the plain-text fallback answered.
 */
const SAMPLE = [
  "export const greeting: string = \"hello\";",
  "",
  "export function shout(word: string): string {",
  "  return `${word.toUpperCase()}!`;",
  "}",
].join("\n");

/** The bounds `file-viewer-session.ts` sends; the worker enforces them. */
const MAX_LINE_LENGTH = 1_000;
const MAX_TOKENS = 250_000;

/** How long the worker may take to evaluate its module graph and answer. */
const WORKER_DEADLINE_MS = 45_000;

/**
 * Resolve the built worker chunk the app itself would load, and prove it is
 * that one.
 */
function resolveBuiltWorkerChunk(): { readonly name: string; readonly referencedBy: string } {
  const assetNames = readdirSync(RENDERER_ASSETS);
  const workerChunks = assetNames.filter((name) => HIGHLIGHT_WORKER_CHUNK.test(name));
  if (workerChunks.length !== 1) {
    throw new Error(
      `expected exactly one highlight.worker-<hash>.js in ${RENDERER_ASSETS}, ` +
        `found ${String(workerChunks.length)}: ${workerChunks.join(", ") || "none"}. ` +
        "Run `pnpm --dir vex-app build` first.",
    );
  }
  const name = workerChunks[0] as string;
  const referencedBy = assetNames.find(
    (candidate) =>
      candidate !== name &&
      candidate.endsWith(".js") &&
      readFileSync(path.join(RENDERER_ASSETS, candidate), "utf8").includes(name),
  );
  if (referencedBy === undefined) {
    throw new Error(
      `${name} exists but no other built bundle references it, so it is not the ` +
        "chunk `highlighter-port.ts` would construct. The worker URL rewrite in " +
        "vite.renderer.config.ts is the thing to look at.",
    );
  }
  return { name, referencedBy };
}

interface WorkerRun {
  readonly url: string;
  readonly ready: boolean;
  readonly response: unknown;
  readonly violations: readonly string[];
  readonly failure: string | null;
}

test("the built highlight worker executes under the app's CSP and round-trips a highlight", async ({
  vexApp,
}: {
  vexApp: VexElectronFixture;
}, testInfo: TestInfo) => {
  // A real Electron boot plus a shiki grammar load; the config-wide 30s budget
  // is the smoke test's, not this one's.
  test.setTimeout(120_000);

  const chunk = resolveBuiltWorkerChunk();
  testInfo.annotations.push({
    type: "worker-chunk",
    description: `${chunk.name} (referenced by ${chunk.referencedBy})`,
  });

  const page = vexApp.firstWindow;
  await page.waitForLoadState("domcontentloaded");

  // The policy that governs the construction below, read off the document that
  // will own the worker rather than off the file the build gate read.
  const csp = await page.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? "",
  );
  expect(csp, "the shell document carries no CSP meta tag").not.toEqual("");
  expect(csp).toContain("worker-src 'self'");

  const run: WorkerRun = await page.evaluate(
    async ({ chunkName, sample, maxLineLength, maxTokens, deadlineMs }) => {
      const violations: string[] = [];
      const onViolation = (event: Event): void => {
        const violation = event as SecurityPolicyViolationEvent;
        violations.push(
          `${violation.effectiveDirective} blocked ${violation.blockedURI || "(unnamed)"}`,
        );
      };
      document.addEventListener("securitypolicyviolation", onViolation);

      // The same URL `highlighter-port.ts` resolves: the hashed chunk, in the
      // assets directory of this document's own origin.
      const url = new URL(`assets/${chunkName}`, document.baseURI).href;
      let worker: Worker | null = null;
      let ready = false;
      let response: unknown = null;
      let failure: string | null = null;

      try {
        worker = new Worker(url, { type: "module" });
        const requestId = 1;
        response = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                `no result within ${String(deadlineMs)}ms (ready=${String(ready)})`,
              ),
            );
          }, deadlineMs);
          const settle = (value: unknown): void => {
            clearTimeout(timer);
            resolve(value);
          };
          worker?.addEventListener("message", (event: MessageEvent<unknown>) => {
            const message = event.data as { readonly kind?: unknown };
            if (message?.kind === "ready") {
              ready = true;
              // Posted only after `ready` on purpose: the port does not wait
              // for it, but a request sent first would let a worker that never
              // evaluated still look alive through the channel's own queueing.
              worker?.postMessage({
                kind: "highlight",
                requestId,
                language: "typescript",
                text: sample,
                maxLineLength,
                maxTokens,
              });
              return;
            }
            settle(event.data);
          });
          worker?.addEventListener("error", (event: ErrorEvent) => {
            clearTimeout(timer);
            reject(new Error(`worker error: ${event.message || "(no message)"}`));
          });
          worker?.addEventListener("messageerror", () => {
            clearTimeout(timer);
            reject(new Error("worker messageerror: a response failed to deserialize"));
          });
        });
      } catch (cause: unknown) {
        failure = cause instanceof Error ? cause.message : String(cause);
      } finally {
        worker?.terminate();
        document.removeEventListener("securitypolicyviolation", onViolation);
      }

      return { url, ready, response, violations, failure };
    },
    {
      chunkName: chunk.name,
      sample: SAMPLE,
      maxLineLength: MAX_LINE_LENGTH,
      maxTokens: MAX_TOKENS,
      deadlineMs: WORKER_DEADLINE_MS,
    },
  );

  testInfo.annotations.push({ type: "worker-url", description: run.url });

  // CSP first: it is the failure whose cause the other assertions would hide
  // behind a timeout.
  expect(
    run.violations,
    `CSP refused the worker: ${run.violations.join(" | ")}`,
  ).toEqual([]);
  expect(run.failure, `the worker never answered: ${run.failure ?? ""}`).toBeNull();
  // `ready` is posted after the worker's module graph has evaluated, which is
  // the single fact the emission-only build gate cannot establish.
  expect(run.ready, "the worker chunk never posted `ready`").toBe(true);

  const response = run.response as {
    readonly kind?: unknown;
    readonly requestId?: unknown;
    readonly ok?: unknown;
    readonly reason?: unknown;
    readonly longLines?: unknown;
    readonly lines?: readonly (readonly {
      readonly text: string;
      readonly color: string | null;
      readonly italic: boolean;
      readonly bold: boolean;
      readonly underline: boolean;
    }[])[];
  };

  expect(response.kind).toBe("result");
  expect(response.requestId).toBe(1);
  // A refusal here is a real product failure, not a tolerated degradation: the
  // hot set contains typescript and the sample is five short lines.
  expect(
    response.ok,
    `the worker refused a five-line TypeScript sample: ${String(response.reason ?? "")}`,
  ).toBe(true);
  expect(response.longLines).toBe(0);

  const lines = response.lines ?? [];
  expect(Array.isArray(lines)).toBe(true);
  expect(lines).toHaveLength(SAMPLE.split("\n").length);
  for (const line of lines) {
    for (const token of line) {
      expect(typeof token.text).toBe("string");
      expect(token.color === null || typeof token.color === "string").toBe(true);
      expect(typeof token.italic).toBe("boolean");
      expect(typeof token.bold).toBe("boolean");
      expect(typeof token.underline).toBe("boolean");
    }
  }

  // THE ROUND TRIP. `projectLines` guarantees every line's tokens concatenate
  // back to the source line, so the whole file must reassemble byte for byte.
  // Nothing was dropped, reordered or truncated crossing the worker boundary.
  const reassembled = lines.map((line) => line.map((token) => token.text).join("")).join("\n");
  expect(reassembled).toBe(SAMPLE);

  // A grammar really ran: the plain-text fallback colours nothing.
  const coloured = lines.flat().filter((token) => token.color !== null);
  expect(
    coloured.length,
    "every token came back colourless, so the plain fallback answered rather than the TypeScript grammar",
  ).toBeGreaterThan(0);
});
