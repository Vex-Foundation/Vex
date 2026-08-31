/**
 * Build-artifact checks for the PRIVILEGED process bundles — every emitted
 * `dist/main/*.js` chunk plus `dist/preload/index.cjs`.
 *
 * Extracted from `check-build-artifacts.mjs` (which keeps the renderer bundle,
 * renderer source hygiene, brand assets, compose templates, and packaged
 * migrations) so neither file mixes reasons to change. Everything in here
 * fails for one family of reasons: the Vite/rolldown configuration for main or
 * preload regressed, or the preload bridge started exposing more than it should.
 *
 * NOT the same thing as `scripts/check-process-boundaries.mjs` — that reads
 * SOURCE imports; this reads BUILT output.
 *
 * ONE exception to the "privileged only" scope: the zod-locale check also
 * reads `dist/renderer/assets/*.js`, because the locale is one registration
 * with one owner (`src/lib/zod-locale.ts`) and splitting its proof across two
 * scripts would let a renderer regression pass a green privileged gate.
 *
 * `check-build-artifacts.mjs` owns the runner, the reporting, and the exit
 * code. Each entry below is `{ label, run(root) }` and throws on violation.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const POSTGRES_RUNTIME_EXTERNALS = [
  "pg",
  "pg-types",
  "postgres-array",
  "postgres-bytea",
  "postgres-date",
  "postgres-interval",
  "pgpass",
];

/**
 * Bare `__filename` identifier in an ESM chunk. `\b__filename\b` cannot match
 * `import.meta.filename` (no `__` prefix), so the define substitution we ship
 * is excluded by construction. Non-global so `.test()` stays stateless.
 */
const BARE_FILENAME_RE = /\b__filename\b/;

/**
 * Marker emitted by `src/lib/zod-locale.ts` (`ZOD_LOCALE_MARKER`). It exists
 * only if `registerZodLocale()` is still reachable from the bundle entry.
 */
const ZOD_LOCALE_MARKER = "vex-zod-locale:en";

/**
 * A message template that lives in zod's English locale module
 * (`zod/v4/locales/en.js`).
 *
 * SECONDARY signal only, and deliberately labelled as such: the phrase is NOT
 * unique to a registered locale. It also appears in unrelated vendored text and
 * in chunks that merely CONTAIN the locale module, so a bundle whose
 * `config(en())` call was tree-shaken out still carries it. It can prove the
 * locale module is absent; it can never prove registration happened. Only
 * `ZOD_LOCALE_MARKER` does that.
 */
const ZOD_EN_LOCALE_TEXT = "Too big: expected ";

/**
 * Every bundle set that must carry the marker. The renderer is on this list
 * because renderer form and schema validation degrades to "Invalid input" in
 * exactly the same way, and its entry is minified - only a value the entry
 * actually USES survives, which is what `probeZodLocale()` in
 * `src/renderer/main.tsx` guarantees.
 */
const ZOD_LOCALE_REQUIRED_BUNDLES = Object.freeze([
  "dist/main",
  "dist/preload/index.cjs",
  "dist/renderer/assets",
]);

/**
 * Pure matcher for the zod-locale gate: no filesystem, no paths, just the text
 * of the emitted chunks. Exported so the negative cases (locale phrase present
 * but marker absent; marker in the privileged bundles but not the renderer)
 * are provable by unit test instead of by a build.
 *
 * @param {ReadonlyArray<{ name: string, sources: ReadonlyArray<string> }>} bundles
 *   One entry per bundle set, `sources` being the full text of each emitted
 *   chunk in that set.
 * @returns {{ ok: boolean, violations: string[] }} `ok` is true only when every
 *   required bundle set is present, non-empty, and carries the unique marker.
 */
export function evaluateZodLocaleBundles(bundles) {
  const violations = [];
  const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]));

  for (const required of ZOD_LOCALE_REQUIRED_BUNDLES) {
    if (!byName.has(required)) {
      violations.push(`${required}: bundle set was not scanned at all`);
    }
  }

  for (const { name, sources } of bundles) {
    if (sources.length === 0) {
      violations.push(`${name}: no built files to scan`);
      continue;
    }
    // EXECUTABLE TEXT ONLY. `dist/main` is emitted with `minify: false`, so our
    // own source comments survive into it - and `src/lib/zod-locale.ts`
    // legitimately SPELLS the marker out in the doc block that explains why it
    // exists. Scanning raw text would let that comment satisfy this gate with
    // the registration tree-shaken away, which is the same vacuity the marker's
    // ownership move closes. The sibling `__filename` check already reads
    // chunks this way.
    const code = sources.map(stripWholeLineComments);
    const hasMarker = code.some((src) => src.includes(ZOD_LOCALE_MARKER));
    const hasLocaleText = code.some((src) => src.includes(ZOD_EN_LOCALE_TEXT));
    if (!hasMarker) {
      violations.push(
        `${name}: no \`${ZOD_LOCALE_MARKER}\` marker - registerZodLocale() was tree-shaken out or never called from the entry` +
          (hasLocaleText
            ? ` (the locale module IS bundled - \`${ZOD_EN_LOCALE_TEXT}\` is present - which alone proves nothing)`
            : "")
      );
    }
    if (!hasLocaleText) {
      violations.push(
        `${name}: zod English locale text (\`${ZOD_EN_LOCALE_TEXT}\`) is absent - the locale module itself is not in the bundle`
      );
    }
  }

  return { ok: violations.length === 0, violations };
}


/**
 * Whole-line comment: `//…`, `/*…`, or a JSDoc continuation `*…`. The main
 * bundle is emitted with `minify: false`, so our own source comments survive
 * into it — and the log redactor's note about this very incident legitimately
 * spells the token out.
 *
 * Deliberately conservative: a TRAILING comment after code is NOT recognised.
 * The worst case is therefore a loud false positive that a reword fixes, never
 * a silent miss of a real executable reference.
 */
const COMMENT_LINE_RE = /^(?:\/\/|\/\*|\*)/;

/**
 * Drop every whole-line comment, keeping the line count so a caller that
 * resolves positions is unaffected.
 *
 * Shared by the `__filename` scan and the zod-locale scan, because both ask
 * the same question: does the EXECUTED code contain this token? Same
 * conservative rule as {@link COMMENT_LINE_RE}: a trailing comment after code
 * is not recognised, so the worst case is a loud false positive, never a
 * silent miss.
 */
export function stripWholeLineComments(source) {
  return source
    .split("\n")
    .map((line) => (COMMENT_LINE_RE.test(line.trim()) ? "" : line))
    .join("\n");
}

function walkFiles(dir, predicate) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      found.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      found.push(full);
    }
  }
  return found;
}

/** Emitted main chunks only — `.js.map` sourcemaps carry the ORIGINAL text and
 * would report hits that do not exist in the executed code. */
function mainChunkFiles(root) {
  return walkFiles(path.join(root, "dist", "main"), (file) => file.endsWith(".js"));
}

/** Line-resolved hits so a failure points at the offending chunk position. */
export function findBareFilenameHits(file) {
  const hits = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (COMMENT_LINE_RE.test(trimmed)) continue;
    if (BARE_FILENAME_RE.test(trimmed)) {
      hits.push({ line: i + 1, text: trimmed.slice(0, 120) });
    }
  }
  return hits;
}

export const privilegedBundleChecks = [
  {
    label: "preload bundle is CJS + uses contextBridge + NO raw ipcRenderer exposure",
    run(root) {
      const distPreload = path.join(root, "dist", "preload", "index.cjs");
      if (!existsSync(distPreload)) throw new Error(`missing: ${distPreload}`);
      const src = readFileSync(distPreload, "utf8");
      if (!src.includes('require("electron")') && !src.includes("require('electron')")) {
        throw new Error("preload bundle is not CJS-style (no `require('electron')` found)");
      }
      if (!src.includes("contextBridge")) {
        throw new Error("preload bundle does not use contextBridge.exposeInMainWorld");
      }
      // Heuristic: preload may use ipcRenderer.invoke under the hood; we forbid only
      // exposing it directly. exposeInMainWorld must be called with `vex` as first arg.
      if (!src.includes("exposeInMainWorld") || !src.includes('"vex"')) {
        throw new Error("preload does not expose `window.vex`");
      }
      // Reject patterns that would leak the entire ipcRenderer to renderer.
      const leaks = [
        /exposeInMainWorld\(\s*["']vex["']\s*,\s*ipcRenderer\b/,
        /exposeInMainWorld\(\s*["']ipcRenderer["']/,
        /exposeInMainWorld\(\s*["'][^"']+["']\s*,\s*\{\s*invoke\s*:\s*ipcRenderer\.invoke\b/,
      ];
      for (const pattern of leaks) {
        if (pattern.test(src)) {
          throw new Error(`preload leaks ipcRenderer surface (matched ${pattern.source})`);
        }
      }
    },
  },
  {
    label: "main bundle — entrypoint exists + uses single-instance lock",
    run(root) {
      const distMain = path.join(root, "dist", "main", "index.js");
      if (!existsSync(distMain)) throw new Error(`missing: ${distMain}`);
      const src = readFileSync(distMain, "utf8");
      if (!src.includes("requestSingleInstanceLock")) {
        throw new Error("main bundle missing single-instance lock guard");
      }
      if (!src.includes("registerSchemesAsPrivileged")) {
        throw new Error("main bundle missing custom protocol registration");
      }
      if (!src.includes("setPermissionRequestHandler")) {
        throw new Error("main bundle missing permission deny handlers");
      }
      // M10 regression guard #1 — first-order browser-compat stub.
      // `__vite-browser-external` is the stub Vite emits when it tries to
      // externalize a bare Node built-in (`os`, `fs`, `http`, …) using its
      // browser-compat policy. That stub is `{}` and crashes at runtime the
      // moment any consumer calls `os.release()` etc. (real-world repro:
      // @colors/colors → supports-colors.js on Windows.)
      // If this gate trips, audit `vite.main.config.ts` — bare builtins must
      // be in `external` and `resolve.conditions` must include `"node"`.
      if (src.includes("__vite-browser-external")) {
        throw new Error(
          "main bundle contains __vite-browser-external stubs — a Node built-in is being resolved through Vite's browser-compat path. Check vite.main.config.ts (bareNodeBuiltins + resolve.conditions including 'node')."
        );
      }
      // M10 regression guard #2 — second-order throwing `__require` shim.
      // When CJS deps are bundled into ESM main without `platform: "node"`,
      // rolldown emits a shim that throws "Calling `require` for X in an
      // environment that doesn't expose the `require` function". Real-world
      // repro: safe-buffer / secp256k1 / bn.js → `require("buffer")`.
      // Fix: `rolldownOptions.platform = "node"` so rolldown injects
      // `createRequire(import.meta.url)` instead.
      if (src.includes("environment that doesn't expose the `require` function")) {
        throw new Error(
          "main bundle contains a throwing __require shim — CJS deps are bundled into the ESM main without a Node platform setting. Set `rolldownOptions.platform = 'node'` in vite.main.config.ts."
        );
      }
    },
  },
  {
    // `pg` is pure JS and small enough to bundle. Leaving it external makes
    // packaged startup depend on electron-builder copying the full pnpm
    // transitive graph into app.asar/node_modules; v0.1.0 crashed on macOS when
    // `pg-types -> postgres-array` was missing there. Fail at postbuild if that
    // packaging risk comes back.
    label: "main bundle — Postgres runtime deps are bundled, not external ASAR imports",
    run(root) {
      const jsFiles = mainChunkFiles(root);
      if (jsFiles.length === 0) {
        throw new Error(`no built main JS files in ${path.join(root, "dist", "main")}`);
      }

      const violations = [];
      for (const file of jsFiles) {
        const rel = path.relative(root, file);
        const src = readFileSync(file, "utf8");
        for (const mod of POSTGRES_RUNTIME_EXTERNALS) {
          const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const patterns = [
            new RegExp(`\\bfrom\\s+["']${escaped}["']`),
            new RegExp(`\\bimport\\s*\\(\\s*["']${escaped}["']\\s*\\)`),
          ];
          if (patterns.some((pattern) => pattern.test(src))) {
            violations.push(`${rel}: leaves ${mod} as a runtime module import`);
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `Postgres runtime deps must be bundled into dist/main to avoid ASAR node_modules drift:\n    ${violations.join("\n    ")}`
        );
      }
    },
  },
  {
    // The MCP SDK is a ROOT dependency (`@modelcontextprotocol/server` +
    // `/core`), imported by the engine's Studio server through the
    // `@vex-agent` alias and reached from main via a dynamic import. It is NOT
    // in `vite.main.config.ts`'s `external` list, so it must be BUNDLED into
    // dist/main. If it is ever left as a runtime module import, the packaged
    // app resolves it out of app.asar/node_modules - the same packaging drift
    // that made v0.1.0 crash on macOS when `pg-types -> postgres-array` was
    // missing there - and the Vex Studio host dies at the first connection
    // instead of at build time.
    // Fix if this trips: remove the package from `external`, or bundle it
    // explicitly. Never "just add it to extraResources".
    label: "main bundle — MCP SDK is bundled, not an unresolved @modelcontextprotocol import",
    run(root) {
      const jsFiles = mainChunkFiles(root);
      if (jsFiles.length === 0) {
        throw new Error(`no built main JS files in ${path.join(root, "dist", "main")}`);
      }
      // Static `from "@modelcontextprotocol/..."`, bare `import "..."`,
      // dynamic `import("...")` and CJS `require("...")`.
      //
      // Scanned LINE BY LINE with whole-line comments skipped, exactly as the
      // `__filename` gate does and for the same reason: `minify: false` keeps
      // the bundled SDK's own JSDoc in the chunk, and its usage example spells
      // `import { serveStdio } from '@modelcontextprotocol/server/stdio'` in
      // prose. A file-wide regex reports that as a runtime import. Trailing
      // comments after code are deliberately NOT recognised, so the worst case
      // stays a loud false positive rather than a silent miss.
      const patterns = [
        /\bfrom\s*["']@modelcontextprotocol\/[^"']*["']/,
        /\bimport\s*["']@modelcontextprotocol\/[^"']*["']/,
        /\bimport\s*\(\s*["']@modelcontextprotocol\/[^"']*["']\s*\)/,
        /\brequire\s*\(\s*["']@modelcontextprotocol\/[^"']*["']\s*\)/,
      ];
      const violations = [];
      for (const file of jsFiles) {
        const rel = path.relative(root, file);
        const lines = readFileSync(file, "utf8").split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const trimmed = (lines[i] ?? "").trim();
          if (COMMENT_LINE_RE.test(trimmed)) continue;
          for (const pattern of patterns) {
            if (pattern.test(trimmed)) {
              violations.push(
                `${rel}:${i + 1}: leaves @modelcontextprotocol/* as a runtime module import — ${trimmed.slice(0, 120)}`
              );
            }
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `The MCP SDK must be bundled into dist/main; a packaged app cannot resolve it from ASAR node_modules:\n    ${violations.join("\n    ")}`
        );
      }
    },
  },
  {
    // The ESM main bundle must contain NO bare `__filename`. Rolldown inlines
    // CJS dependencies whose code reads it — `@solana/spl-token` →
    // `buffer-layout-utils` → `bigint-buffer` → `bindings` — and in an ESM
    // chunk that identifier does not exist. `bindings.getFileName()` reads it
    // from INSIDE an `Error.prepareStackTrace` hook, so the ReferenceError
    // escapes through `dummy.stack` and the next line, which restores the
    // previous hook, never runs. `Error.prepareStackTrace` then stays poisoned
    // process-wide: EVERY later `error.stack` read in main throws, our log
    // redactor throws while formatting, handled errors turn into unhandled
    // rejections, and the app spams "[ReferenceError: __filename is not
    // defined]" instead of the real error.
    // Fix if this trips: `define: { __filename: "import.meta.filename" }` in
    // vite.main.config.ts. NEVER add `__dirname` there — main sources DECLARE
    // `const __dirname`, and a define would rewrite those declaration sites.
    label: "main bundle — no bare `__filename` in any ESM chunk (Error.prepareStackTrace poisoning)",
    run(root) {
      const jsFiles = mainChunkFiles(root);
      if (jsFiles.length === 0) {
        throw new Error(`no built main JS files in ${path.join(root, "dist", "main")}`);
      }

      const violations = [];
      for (const file of jsFiles) {
        const rel = path.relative(root, file);
        for (const hit of findBareFilenameHits(file)) {
          violations.push(`${rel}:${hit.line}: ${hit.text}`);
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `bare \`__filename\` in ESM main chunk(s) — poisons Error.prepareStackTrace at runtime.\n` +
            `    Set \`define: { __filename: "import.meta.filename" }\` in vite.main.config.ts (NEVER __dirname).\n    ${violations.join("\n    ")}`
        );
      }
    },
  },
  {
    // zod 4.4.3 ships `"sideEffects": false` and registers its English error
    // map as a module-level side effect in `zod/v4/classic/external.js`
    // (`config(en());`). Rollup/rolldown drops that statement, and every zod
    // issue in the bundled process then degrades to the generic core message
    // `"Invalid input"` - a model or a user is told a field is wrong but never
    // WHY. Measured: 32 stored tool outputs carried the generic message and
    // zero carried a specific one; the pre-fix preload bundle contained no
    // English locale text at all.
    // Fix if this trips: call `registerZodLocale()` from `src/lib/zod-locale.ts`
    // at the composition root of the affected process. NEVER a bare
    // side-effect-only import - the same tree-shaking drops it again.
    label: "zod english locale registered in every bundle (main + preload + renderer)",
    run(root) {
      const bundleSets = [
        { name: "dist/main", files: mainChunkFiles(root) },
        {
          name: "dist/preload/index.cjs",
          files: [path.join(root, "dist", "preload", "index.cjs")],
        },
        {
          name: "dist/renderer/assets",
          files: walkFiles(path.join(root, "dist", "renderer", "assets"), (f) =>
            f.endsWith(".js")
          ),
        },
      ];

      const { ok, violations } = evaluateZodLocaleBundles(
        bundleSets.map(({ name, files }) => ({
          name,
          sources: files
            .filter((file) => existsSync(file))
            .map((file) => readFileSync(file, "utf8")),
        }))
      );

      if (!ok) {
        throw new Error(
          `zod English locale is not registered in every bundle; validation failures there would read "Invalid input":\n    ${violations.join("\n    ")}`
        );
      }
    },
  },
];

/* ------------------------------------------------------------------ *
 * Studio highlight worker (stage B3c)
 * ------------------------------------------------------------------ */

/**
 * The string that proves the highlighter PORT is in the renderer bundle.
 *
 * It is a `console.warn` message in `highlight/highlighter-port.ts`, sitting in
 * the same module as the `new Worker(new URL(...))` factory, so a minifier
 * keeps it verbatim (it is a string literal, not an identifier) and it cannot
 * be present without the factory being present. Same technique as the zod
 * locale marker above, and for the same reason: a phrase that could ride along
 * in an unrelated chunk would prove nothing.
 */
export const HIGHLIGHT_PORT_MARKER =
  "studio viewer highlight: could not start the worker";

/**
 * The worker chunk, as Vite's `worker.rolldownOptions.output.entryFileNames`
 * (`assets/[name]-[hash].js`) names it. MEASURED on a real build:
 * `highlight.worker-C-1Hp9s1.js`, 168789 bytes.
 */
const HIGHLIGHT_WORKER_CHUNK = /^highlight\.worker-[A-Za-z0-9_-]+\.js$/;

/**
 * Two facts about the built renderer, as ONE pure verdict.
 *
 * 1. `worker-src` is declared and is EXACTLY `'self'`. A `blob:` worker is how
 *    injected code runs past a strict `script-src`, and inheriting the
 *    directive from `default-src` would leave nothing for a gate to pin.
 * 2. If any chunk carries {@link HIGHLIGHT_PORT_MARKER}, a worker chunk exists.
 *    CONDITIONAL because the Studio surface is not mounted in the shell until
 *    stage B4: today the marker is absent and the second check is vacuous, and
 *    the day the shell mounts the viewer it arms itself with nobody having to
 *    remember. An unconditional demand would fail every build until B4; a
 *    permanent skip would be a gate that never ran.
 *
 * Pure - no fs, no process - so both RED cases are provable on synthetic input.
 *
 * @param {{ csp: string, assetFileNames: string[], bundleSources: string[] }} input
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function evaluateHighlightWorkerBundle({ csp, assetFileNames, bundleSources }) {
  const violations = [];

  const directives = new Map();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    directives.set(tokens[0], tokens.slice(1));
  }
  const workerSrc = directives.get("worker-src");
  if (!workerSrc) {
    violations.push(
      "CSP declares no `worker-src`: the Studio highlight worker would inherit " +
        "default-src and no gate could pin it. Add `worker-src 'self'`.",
    );
  } else if (workerSrc.length !== 1 || workerSrc[0] !== "'self'") {
    violations.push(
      `CSP worker-src must be exactly 'self' (found: worker-src ${workerSrc.join(" ")})`,
    );
  }

  const reachable = bundleSources.some((src) => src.includes(HIGHLIGHT_PORT_MARKER));
  if (reachable && !assetFileNames.some((name) => HIGHLIGHT_WORKER_CHUNK.test(name))) {
    violations.push(
      "the renderer bundle reaches the highlighter port but no " +
        "`highlight.worker-<hash>.js` chunk was emitted - the worker would fail " +
        "to construct at runtime and every file would silently render as plain " +
        "text. Check `worker.format`/`worker.rolldownOptions` in " +
        "vite.renderer.config.ts.",
    );
  }

  return { ok: violations.length === 0, violations };
}
