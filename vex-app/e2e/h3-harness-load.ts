/**
 * OPEN AN H3 HARNESS PAGE, and wait until it is whole or say why it never
 * mounted.
 *
 * WHY THE PAGE'S REQUESTS GO THROUGH PLAYWRIGHT. Served by the dev server,
 * one load of the harness is about a thousand module requests, and the
 * browser opens six connections to a host, so for most of a load hundreds of
 * them wait in Chromium's socket pool. When the machine's network
 * configuration changes (on macOS every rewrite of
 * `State:/Network/Global/IPv4`, which some networks do every 15 to 30
 * seconds), Chromium flushes its socket pools and fails every request still
 * waiting there with `net::ERR_NETWORK_CHANGED`, loopback included; the six
 * on the wire finish. One failed module request fails the whole module graph
 * for good: a blank page, no page error, nothing in the server's log, and a
 * spec that waits out its timeout for a ready stamp that cannot come. So
 * every request to the harness is fetched by Playwright from Node and
 * fulfilled into the page: none of them ever waits in the browser's pool, and
 * a change of the machine's network has nothing to fail. The page and what
 * is rendered are unchanged; only the transport is, and the harness server
 * keeps idle connections open for it (`vite.h3-shell.config.ts`), since
 * Node's client reuses sockets the server would otherwise close under it.
 *
 * And if a load fails anyway (the server gone, a request that errors), the
 * harness page stamps `data-vex-h3-load-failed` on its root when its module
 * script fails (`src/renderer/dev/h3-shell/index.html`), and this reads that
 * stamp beside the ready one: the spec fails at once, naming the failed
 * requests, instead of after its timeout on a blank page.
 */

import { test, type Page, type Route } from "@playwright/test";

const READY = '[data-vex-h3-ready="true"]';
const LOAD_FAILED = "html[data-vex-h3-load-failed]";

const served = new WeakSet<Page>();

/** Fetch the request from Node and hand the response to the page. */
async function serveFromNode(route: Route): Promise<void> {
  try {
    await route.fulfill({ response: await route.fetch() });
  } catch {
    // The page closed under the fetch, or the server did not answer: fail the
    // request so a live page shows its load failure rather than hanging.
    await route.abort("failed").catch(() => undefined);
  }
}

/** Open `path` on the harness and wait for its ready stamp. */
export async function openHarness(page: Page, path: string, timeout: number): Promise<void> {
  const baseURL = test.info().project.use.baseURL;
  if (baseURL === undefined) throw new Error("the H3 harness projects set a baseURL");
  const origin = new URL(baseURL).origin;
  if (!served.has(page)) {
    served.add(page);
    await page.route((url) => url.origin === origin, serveFromNode);
  }
  const failed: string[] = [];
  const onFailed = (request: { url: () => string; failure: () => { errorText: string } | null }): void => {
    failed.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`);
  };
  page.on("requestfailed", onFailed);
  try {
    await page.goto(path);
    await page.waitForSelector(`${READY}, ${LOAD_FAILED}`, { timeout });
    const script = await page.locator("html").getAttribute("data-vex-h3-load-failed");
    if (script !== null) {
      throw new Error(
        `The harness never mounted: its module script failed (${script}). ` +
          `${String(failed.length)} failed request(s), first: ${failed.slice(0, 3).join("; ") || "none seen"}`,
      );
    }
  } finally {
    page.off("requestfailed", onFailed);
  }
}
