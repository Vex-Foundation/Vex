/**
 * IPC channel ↔ register-all reconciliation guard (grounding item B-009).
 *
 * The IPC surface is a renderer→main trust boundary. Two kinds of drift are
 * silent failures that this guard turns into a red test:
 *
 *  1. A request channel constant is declared in `channels.ts` (CH) but no
 *     main handler is registered for it. The renderer can then call a dead
 *     channel that `ipcRenderer.invoke` leaves pending forever (no
 *     `ipcMain.handle` responder). Every such channel MUST be either wired
 *     to a handler OR listed in the reserved allowlist below with a comment
 *     explaining why it is intentionally unimplemented.
 *
 *  2. A handler is registered with a raw `ipcMain.handle(...)` call instead
 *     of going through `registerHandler` in `register-handler.ts`. That
 *     bypasses sender validation, payload/output Zod validation, the
 *     redacted `VexError` shape, correlation IDs, and the cancel registry —
 *     the entire main-side boundary enforcement. The only legitimate raw
 *     `ipcMain.handle` lives in `register-handler.ts`; everything else must
 *     route through it.
 *
 * Mechanism notes:
 *
 *  - The "actually registered" set is captured by a STATIC REACHABILITY scan
 *    rooted at `register-all.ts`. A runtime spy on `ipcMain.handle` driven by
 *    `registerAllIpcHandlers()` was the first design, but importing the full
 *    registration graph in a unit harness pulls the entire agent/DB/wallet/
 *    Docker dependency tree (it does not settle in a unit test). The static
 *    scan reproduces what the runtime would register, deterministically and
 *    with no import side effects.
 *
 *  - A NAIVE static scan of EVERY main source file for `channel: CH...` is
 *    NOT sufficient: a handler module that declares `registerHandler({ channel:
 *    CH.foo.bar })` but whose `register*Handlers()` function is never called by
 *    `registerAllIpcHandlers()` would still be counted as registered, even
 *    though the renderer's `invoke` for that channel hangs forever at runtime
 *    (no `ipcMain.handle` responder is ever installed). That is the EXACT
 *    failure this guard must catch. So the registered set is computed from
 *    REACHABILITY, not mere declaration:
 *
 *      1. statically parse `register-all.ts` for the `register*`/`setup*`
 *         identifiers actually CALLED inside `registerAllIpcHandlers()`;
 *      2. resolve each called identifier to its source module via the matching
 *         `import { … } from "…"` statement in `register-all.ts`;
 *      3. transitively walk the static relative-import/export graph from those
 *         seed modules (facade shims like `runtime.ts` re-export a `./runtime/
 *         index.ts` barrel which imports the per-handler modules — the walk
 *         follows that chain);
 *      4. scan ONLY the reachable modules for the `channel:` argument passed to
 *         `registerHandler(...)` and resolve it against `CH`.
 *
 *    A channel declared in a module that is NOT reachable from `register-all.ts`
 *    therefore counts as UNREGISTERED — the reconciliation FAILS for it (unless
 *    it is in the reserved allowlist). The mutation test below proves this:
 *    excluding a seed (simulating a `register*Handlers()` that is never called)
 *    flips that subtree's channels to unregistered.
 *
 *    Dynamic `import()` calls in handler modules all target aliased packages
 *    (`@vex-agent/*`, `@shared/*`), never relative paths, so they are correctly
 *    NOT walked — and none of those targets declare request channels.
 *
 *  - The raw-handler scan (concern #2) independently proves no handler can
 *    register OUTSIDE `registerHandler` — so the reachability scan and the
 *    raw-handler scan together pin the same invariant a runtime spy would.
 *
 *  - Push channels (`vex:event:*`) and stream channels (`vex:stream:*`) are
 *    EXCLUDED from the request reconciliation — they are `webContents.send`
 *    broadcasts, not `ipcMain.handle` request/response responders. `CH`
 *    currently holds only request channels (events live in `EV`), but the
 *    filter is defensive against a future event constant landing in `CH`.
 */

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 15_000 });
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CH } from "@shared/ipc/channels.js";

// ── Source roots (resolved from this test file's location) ──────────────────
const MAIN_ROOT = path.resolve(__dirname, "..", "..");
const REGISTER_HANDLER_PATH = path.resolve(
  __dirname,
  "..",
  "register-handler.ts",
);
const REGISTER_ALL_PATH = path.resolve(__dirname, "..", "register-all.ts");

/**
 * The ONLY request channels that may stay unregistered. Every entry is a
 * declared `CH.*` request constant with no main handler today. Each key is
 * the resolved channel string; each value is the justifying comment.
 *
 * This allowlist must be EXHAUSTIVE: the reconciliation test asserts that the
 * set of unregistered request channels equals EXACTLY the keys here. A new
 * unregistered channel fails the test until it is wired OR added here with a
 * reason; a channel that becomes registered while still listed here also
 * fails (stale-allowlist guard) so the allowlist cannot rot.
 */
const RESERVED_UNREGISTERED: Readonly<Record<string, string>> = {
  // Reserved status surface. Only `database.migrate` is wired today; the
  // renderer reads DB readiness through the system-check + migrate flows.
  // A standalone status responder is declared for a future health panel.
  [CH.database.status]:
    "Reserved DB status responder — only database.migrate is wired; status is a future health-panel surface.",

  // Wizard provider step persists via the verify-then-persist
  // `providerPersist` handler (verify happens inside persist). A standalone
  // connection-test responder remains reserved; model listing is now wired.
  [CH.onboarding.providerTest]:
    "Reserved provider connection-test responder — verify is folded into providerPersist; standalone test is not wired yet.",

};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively collect every string leaf value under a CH-shaped object. */
function collectStringLeaves(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) collectStringLeaves(value, out);
  }
}

/**
 * Flatten CH to request channels only. Excludes push (`vex:event:*`) and
 * stream (`vex:stream:*`) channels per the B-009 spec — they are not
 * request/response responders.
 */
function flattenRequestChannels(): ReadonlySet<string> {
  const leaves: string[] = [];
  collectStringLeaves(CH, leaves);
  return new Set(
    leaves.filter(
      (c) => !c.startsWith("vex:event:") && !c.startsWith("vex:stream:"),
    ),
  );
}

/** Map `CH.<domain>.<action>` / `CH.<domain>` reference text → channel string. */
function buildChannelRefIndex(): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const [domain, value] of Object.entries(CH)) {
    if (typeof value === "string") {
      index.set(`CH.${domain}`, value);
    } else if (value !== null && typeof value === "object") {
      for (const [action, leaf] of Object.entries(value)) {
        if (typeof leaf === "string") {
          index.set(`CH.${domain}.${action}`, leaf);
        }
      }
    }
  }
  return index;
}

/** Recursively list `.ts` files under `dir`, skipping any `__tests__` dir. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") files.push(...listSourceFiles(full));
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Resolve a relative import/export specifier (`./x`, `../y/z.js`) against the
 * importing file to an on-disk `.ts` module path. Returns `null` for bare or
 * aliased specifiers (`electron`, `@vex-agent/...`, `node:fs`) — those never
 * declare main IPC handlers and are intentionally NOT walked.
 *
 * The repo uses NodeNext ESM, so relative imports carry a `.js` extension that
 * resolves to a sibling `.ts` source; barrels are imported as `./dir/index.js`.
 */
function resolveRelativeModule(spec: string, fromFile: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates: string[] = [];
  if (base.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"));
  candidates.push(`${base}.ts`, base, path.join(base, "index.ts"));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this candidate — try the next shape
    }
  }
  return null;
}

/**
 * Map every named import in `register-all.ts` to its module specifier, so a
 * called `register*` identifier can be resolved back to the module that defines
 * it. Only named imports are needed — `register-all.ts` imports handler register
 * functions exclusively as named bindings.
 */
function buildRegisterAllImportIndex(): ReadonlyMap<string, string> {
  const source = readFileSync(REGISTER_ALL_PATH, "utf8");
  const index = new Map<string, string>();
  // `import { a, b as c } from "spec"` (also tolerates a `type` modifier).
  const importRe =
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const spec = match[2]!;
    for (const raw of match[1]!.split(",")) {
      const local = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (local) index.set(local, spec);
    }
  }
  return index;
}

/**
 * Extract the `register*`/`setup*` identifiers actually INVOKED inside the body
 * of `registerAllIpcHandlers()`. An identifier that is imported but never called
 * there does NOT seed the reachable set — its channels stay unregistered.
 */
function collectCalledRegisterIdentifiers(): ReadonlySet<string> {
  const source = readFileSync(REGISTER_ALL_PATH, "utf8");
  const bodyStart = source.indexOf("export function registerAllIpcHandlers");
  // Defensive: if the entry point is renamed, fail loudly via empty seeds
  // (the "scan found registered handlers" sanity assertion below would trip).
  const body = bodyStart >= 0 ? source.slice(bodyStart) : "";
  const called = new Set<string>();
  // A call site is `ident(` or `...ident(` (spread of an array-returning
  // register function). Restrict to register*/setup* to ignore unrelated calls.
  const callRe = /(?:\.{3})?\b((?:register|setup)[A-Za-z0-9]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(body)) !== null) {
    const id = match[1]!;
    if (id !== "registerAllIpcHandlers") called.add(id);
  }
  return called;
}

/**
 * Compute the transitive set of main source modules reachable from
 * `register-all.ts` through the `register*`/`setup*` functions it CALLS, by
 * following static relative import/export edges. `excludeSeeds` lets a test drop
 * a seed to simulate a `register*Handlers()` that is never wired in.
 */
function computeReachableModules(
  excludeSeeds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const importIndex = buildRegisterAllImportIndex();
  const seeds: string[] = [];
  for (const id of collectCalledRegisterIdentifiers()) {
    if (excludeSeeds.has(id)) continue;
    const spec = importIndex.get(id);
    if (spec === undefined) continue; // call to a locally-defined fn, not a seed
    const mod = resolveRelativeModule(spec, REGISTER_ALL_PATH);
    if (mod !== null) seeds.push(mod);
  }

  const visited = new Set<string>();
  const stack = [...seeds];
  // `import … from "spec"` and `export … from "spec"` static edges only.
  const edgeRe = /(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g;
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = edgeRe.exec(content)) !== null) {
      const next = resolveRelativeModule(match[1]!, file);
      if (next !== null && !visited.has(next)) stack.push(next);
    }
  }
  return visited;
}

/**
 * Capture the set of request channels actually registered by main handlers.
 *
 * A channel counts as registered ONLY if its declaring module is REACHABLE from
 * `register-all.ts` (its `register*Handlers()` is called there, transitively
 * through any facade/barrel) AND that module passes the channel to
 * `registerHandler(...)`. Channels in unreachable modules are excluded, exactly
 * as the runtime would leave them without an `ipcMain.handle` responder.
 *
 * `excludeSeeds` drops a seed register function for the mutation test.
 */
function captureRegisteredChannels(
  excludeSeeds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const refIndex = buildChannelRefIndex();
  const reachable = computeReachableModules(excludeSeeds);
  const registered = new Set<string>();
  // Matches `channel: CH.domain.action` and `channel: CH.cancel`.
  const channelArgRe = /channel:\s*(CH\.[A-Za-z]+(?:\.[A-Za-z]+)?)/g;
  for (const file of reachable) {
    // register-handler.ts is the helper itself — its `channel` is a runtime
    // arg (`args.channel`), never a CH literal, so it contributes nothing,
    // but skip it explicitly to keep the intent clear.
    if (file === REGISTER_HANDLER_PATH) continue;
    const source = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = channelArgRe.exec(source)) !== null) {
      const resolved = refIndex.get(match[1]!);
      if (resolved !== undefined) registered.add(resolved);
    }
  }
  return registered;
}

/**
 * Detect raw `ipcMain.handle(` calls in a source string. Matches ONLY the
 * `ipcMain` receiver — `protocol.handle(` (the app:// protocol responder in
 * app-protocol.ts) and `args.handle(` (the handler callback invocation
 * inside register-handler.ts) must NOT match.
 */
function findRawIpcMainHandleCalls(source: string): number {
  const matches = source.match(/\bipcMain\s*\.\s*handle\s*\(/g);
  return matches ? matches.length : 0;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("IPC channel ↔ register-all reconciliation (B-009)", () => {
  const requestChannels = flattenRequestChannels();
  const registeredChannels = captureRegisteredChannels();

  it("flattens CH request channels and excludes event/stream push channels", () => {
    // Sanity: the flatten step found the surface and dropped nothing real.
    expect(requestChannels.size).toBeGreaterThan(0);
    for (const channel of requestChannels) {
      expect(channel.startsWith("vex:event:")).toBe(false);
      expect(channel.startsWith("vex:stream:")).toBe(false);
    }
    // The scan must actually have found registered handlers (guards against a
    // broken regex / path that would make EVERY channel look unregistered).
    expect(registeredChannels.size).toBeGreaterThan(0);
  });

  it("every registered channel is a declared CH request constant", () => {
    // No handler may register a channel that isn't in the shared source of
    // truth. (The scan only resolves CH.* refs, so this also proves the
    // index resolution stayed in sync.)
    for (const channel of registeredChannels) {
      expect(requestChannels.has(channel)).toBe(true);
    }
  });

  it("every unregistered request channel is in the reserved allowlist (and vice versa)", () => {
    const unregistered = [...requestChannels]
      .filter((c) => !registeredChannels.has(c))
      .sort();
    const reserved = Object.keys(RESERVED_UNREGISTERED).sort();

    // Exact equality both ways:
    //  - an unregistered channel NOT in the allowlist → drift, fail (a new
    //    declared channel forgot its handler or its reserved entry);
    //  - an allowlist entry that IS registered → stale allowlist, fail.
    expect(unregistered).toEqual(reserved);
  });

  it("every reserved allowlist entry has a non-empty justifying comment", () => {
    for (const [channel, reason] of Object.entries(RESERVED_UNREGISTERED)) {
      expect(typeof reason).toBe("string");
      expect(reason.trim().length).toBeGreaterThan(0);
      // The comment must say something specific, not a placeholder.
      expect(reason.trim().length).toBeGreaterThanOrEqual(12);
      // And the key must be a real declared request channel.
      expect(requestChannels.has(channel)).toBe(true);
    }
  });

  it("no reserved allowlist entry is actually registered (stale-allowlist guard)", () => {
    for (const channel of Object.keys(RESERVED_UNREGISTERED)) {
      expect(registeredChannels.has(channel)).toBe(false);
    }
  });

  it("reachability follows facade/barrel delegation (delegated channels are registered)", () => {
    // `registerRuntimeHandlers` is exported by the `runtime.ts` facade, which
    // re-exports `./runtime/index.ts`, which imports the five per-handler
    // modules. If the walk did NOT follow that chain, these would look
    // unregistered. They must be registered in the full closure — this is the
    // positive counterpart to the mutation test below.
    for (const channel of [
      CH.runtime.getState,
      CH.runtime.requestPause,
      CH.runtime.requestStop,
      CH.runtime.requestResume,
      CH.runtime.cancelWake,
    ]) {
      expect(registeredChannels.has(channel)).toBe(true);
    }
  });

  it("a channel whose register function is NOT called by register-all is flagged unregistered (mutation)", () => {
    // This is the EXACT runtime failure B-009 must catch and the Codex blocker
    // it must close: a module declares `registerHandler({ channel: CH... })`,
    // but its `register*Handlers()` is never invoked by `registerAllIpcHandlers`,
    // so no `ipcMain.handle` responder is installed and the renderer's `invoke`
    // hangs forever. A declaration-only scan would still count it as registered;
    // the reachability scan must NOT.
    //
    // Simulate it by dropping the `registerRuntimeHandlers` seed (as if the call
    // were removed from register-all.ts). Its five channels are uniquely owned
    // by the runtime subtree, so they must flip to unregistered, and the
    // reconciliation must then FAIL (those channels are neither registered nor
    // reserved).
    const mutated = captureRegisteredChannels(
      new Set(["registerRuntimeHandlers"]),
    );

    const runtimeChannels = [
      CH.runtime.getState,
      CH.runtime.requestPause,
      CH.runtime.requestStop,
      CH.runtime.requestResume,
      CH.runtime.cancelWake,
    ];
    // Each runtime channel is registered in the real closure but UNregistered
    // once its register function is no longer reachable.
    for (const channel of runtimeChannels) {
      expect(registeredChannels.has(channel)).toBe(true);
      expect(mutated.has(channel)).toBe(false);
    }

    // Dropping ONLY that seed must not collaterally drop any other channel:
    // the mutated registered set equals the real one minus the runtime
    // channels. This proves the walk isolates per-seed subtrees correctly.
    const expectedAfterMutation = new Set(registeredChannels);
    for (const channel of runtimeChannels) expectedAfterMutation.delete(channel);
    expect([...mutated].sort()).toEqual([...expectedAfterMutation].sort());

    // And the reconciliation now FAILS: the dropped, non-reserved runtime
    // channels are unregistered drift that is not in the allowlist.
    const unregisteredAfterMutation = [...requestChannels]
      .filter((c) => !mutated.has(c))
      .sort();
    const reserved = Object.keys(RESERVED_UNREGISTERED).sort();
    expect(unregisteredAfterMutation).not.toEqual(reserved);
    for (const channel of runtimeChannels) {
      expect(unregisteredAfterMutation).toContain(channel);
      expect(reserved).not.toContain(channel);
    }
  });
});

describe("raw ipcMain.handle scan (B-009)", () => {
  const mainFiles = listSourceFiles(MAIN_ROOT);

  it("no raw ipcMain.handle exists outside register-handler.ts", () => {
    const offenders: string[] = [];
    for (const file of mainFiles) {
      if (file === REGISTER_HANDLER_PATH) continue;
      if (findRawIpcMainHandleCalls(readFileSync(file, "utf8")) > 0) {
        offenders.push(path.relative(MAIN_ROOT, file));
      }
    }
    // Every handler must route through registerHandler (sender/payload/output
    // validation + redacted error shape + cancel registry). A raw
    // ipcMain.handle anywhere else is a boundary bypass.
    expect(offenders).toEqual([]);
  });

  it("register-handler.ts holds exactly one legitimate raw ipcMain.handle", () => {
    const source = readFileSync(REGISTER_HANDLER_PATH, "utf8");
    expect(findRawIpcMainHandleCalls(source)).toBe(1);
  });

  it("protocol.handle (app:// responder) is NOT flagged by the raw scan", () => {
    // app-protocol.ts legitimately calls `protocol.handle(...)` — a different
    // API from ipcMain.handle. The scanner must read it and not flag it.
    const appProtocolPath = path.resolve(
      __dirname,
      "..",
      "..",
      "protocol",
      "app-protocol.ts",
    );
    const source = readFileSync(appProtocolPath, "utf8");
    // It contains protocol.handle but zero ipcMain.handle.
    expect(source).toContain("protocol.handle(");
    expect(findRawIpcMainHandleCalls(source)).toBe(0);
  });

  it("the detector matches ipcMain.handle but not protocol.handle / args.handle (discrimination)", () => {
    // Positive controls — these SHOULD count (so the scan can actually fail
    // on a real raw handler outside register-handler.ts).
    expect(findRawIpcMainHandleCalls('ipcMain.handle("vex:x:y", fn)')).toBe(1);
    expect(findRawIpcMainHandleCalls("ipcMain . handle ( ch, fn )")).toBe(1);
    // Negative controls — these must NOT count.
    expect(findRawIpcMainHandleCalls("protocol.handle(SCHEME, fn)")).toBe(0);
    expect(findRawIpcMainHandleCalls("args.handle(payload, ctx)")).toBe(0);
    expect(
      findRawIpcMainHandleCalls("// see ipcMainXhandle note"),
    ).toBe(0);
  });
});
