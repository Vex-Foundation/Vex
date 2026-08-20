/**
 * `runTool` reachability guard (grounding item B-010).
 *
 * WHY THIS GUARD EXISTS
 * ─────────────────────
 * `runTool` (src/vex-agent/engine/core/run-tool.ts, re-exported from
 * `@vex-agent/engine/index.js`) builds its tool context with `approved: true`.
 * That makes it the ONE dispatch path that BYPASSES the approval gate:
 * mutating tools execute immediately with no approval card, even under a
 * `restricted` session. It is a deliberate OPERATOR / LOCAL-SHELL-ONLY escape
 * hatch — the "shell settings panel" where the human at the keyboard is the
 * operator and the call already carries explicit privileged intent.
 *
 * The vex-app renderer is UNTRUSTED UI. If `runTool` were ever reachable from
 * a vex-app surface (an IPC handler, the preload bridge, or the renderer),
 * untrusted input could execute mutating tools with the approval gate already
 * lifted — defeating the agent-policy approval invariant. vex-app must drive
 * the normal agent/turn-loop dispatch path instead, where mutating tools under
 * `restricted` still require approval (`dispatchTool` → `routeInternalTool`'s
 * `pendingApproval` gate; canonical regression: the dispatcher
 * "polymarket_setup under restricted + unapproved → pendingApproval" test in
 * src/__tests__/vex-agent/tools/dispatcher-misc.test.ts).
 *
 * Today NO file under `vex-app/src/` imports `runTool`. Nothing PINS that, so
 * a future feature could wire it to the desktop UI silently. This guard turns
 * that into a red test.
 *
 * WHAT IT CATCHES (and how)
 * ─────────────────────────
 * It parses every `vex-app/src/` source file with the TypeScript compiler API
 * (an AST, not a raw string scan, to avoid false negatives from formatting,
 * comments, or unusual spacing) and FAILS if `runTool` is reachable through
 * any of these import shapes:
 *
 *   (a) NAMED import of `runTool` from any module:
 *         import { runTool } from "@vex-agent/engine/index.js";
 *         import { runTool as rt } from "...";            // alias still flagged
 *         const { runTool } = await import("@vex-agent/engine/index.js");
 *         const { runTool: rt } = await import("...");    // dynamic + rename
 *
 *   (b) BARREL import where `runTool` is named — the engine barrel
 *       (`@vex-agent/engine`, `.../engine/index.js`, `.../engine/index.ts`,
 *       `.../engine`) and the module itself (`.../engine/core/run-tool.js`,
 *       `@vex-agent/engine/core/run-tool.js`) re-export `runTool`, so a named
 *       binding from any of them is the same risk as (a). The named-binding
 *       scanner in (a) already covers these regardless of specifier; the
 *       NAMESPACE check below additionally pins barrel namespace access.
 *
 *   (c) NAMESPACE import of an engine-barrel/run-tool module whose `.runTool`
 *       member is then accessed:
 *         import * as engine from "@vex-agent/engine/index.js";
 *         engine.runTool(...)                              // flagged
 *         const engine = await import("@vex-agent/engine/index.js");
 *         engine.runTool(...)                              // flagged
 *         (await import("@vex-agent/engine/index.js")).runTool(...)  // flagged
 *
 * The check is conservative/fail-closed in two ways that matter for a security
 * guard:
 *   - A NAMED `runTool` binding is flagged regardless of which module it comes
 *     from. There is no legitimate reason for vex-app to import a symbol named
 *     `runTool`; flagging it from any specifier removes the "import it from a
 *     re-export I didn't list" escape.
 *   - A `.runTool` member access is flagged when the receiver is a namespace
 *     binding of an engine-barrel/run-tool module, OR is a direct
 *     `(await import(<engine-ish>)).runTool` / `import(<engine-ish>).runTool`
 *     expression.
 *
 * Self-test controls below feed each shape through the same detector on
 * synthetic source so a future refactor of the detector cannot silently stop
 * catching a real wiring (mutation coverage).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// ── Source root: vex-app/src (this file is at vex-app/src/main/ipc/__tests__) ─
const VEX_APP_SRC = path.resolve(__dirname, "..", "..", "..");

/** The symbol that must never be reachable from vex-app. */
const FORBIDDEN_SYMBOL = "runTool";

/**
 * Module specifiers that re-export / define `runTool`. Used ONLY for the
 * namespace-member check — named imports of `runTool` are flagged regardless
 * of specifier (see header). Matching is suffix/substring based so the `.js`
 * NodeNext extension and the `@vex-agent` alias both resolve.
 */
const ENGINE_MODULE_HINTS: readonly string[] = [
  "@vex-agent/engine",
  "/engine/index",
  "/engine/core/run-tool",
  "/run-tool",
];

function isEngineSpecifier(spec: string): boolean {
  // Any specifier hitting the engine barrel / the run-tool module. Covers the
  // alias-root barrel (`@vex-agent/engine`), explicit-index spellings
  // (`.../engine/index.js`), and relative/run-tool forms via substring match.
  return ENGINE_MODULE_HINTS.some((hint) => spec.includes(hint));
}

/** Recursively list `.ts`/`.tsx` files under `dir`, skipping `__tests__`. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__" && entry !== "node_modules") {
        files.push(...listSourceFiles(full));
      }
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

/** A single reachability hit in a scanned file. */
interface RunToolHit {
  readonly file: string;
  readonly kind: "named-import" | "namespace-member";
  readonly detail: string;
}

/**
 * The literal string argument of an `import(...)` call expression, or null if
 * the argument is not a single string literal.
 */
function dynamicImportSpecifier(node: ts.CallExpression): string | null {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const [arg] = node.arguments;
  if (arg && ts.isStringLiteralLike(arg)) return arg.text;
  return null;
}

/**
 * Core scanner — walk a parsed `ts.SourceFile` for `runTool` reachability.
 * This is the SINGLE detection code path; both the real file scan and the
 * synthetic self-tests run through it so the self-tests exercise exactly what
 * guards the build (no parallel implementation can drift).
 *
 * Three detectors run over the AST:
 *   1. static `import { runTool } from "..."` (named, with/without `as`) and
 *      destructuring of a dynamic import (`const { runTool } = await import`).
 *   2. namespace bindings (`import * as ns from <engine-ish>` and
 *      `const ns = await import(<engine-ish>)`), collected so member-access
 *      detection can flag `ns.runTool`.
 *   3. member access on a namespace binding or on a direct
 *      `(await import(<engine-ish>)).runTool`.
 */
function scanSourceFile(sf: ts.SourceFile, file: string): RunToolHit[] {
  const hits: RunToolHit[] = [];
  // Local identifiers bound to an engine-barrel/run-tool namespace, so
  // `<ident>.runTool` can be flagged. Populated by static `import * as ns`
  // and by `const ns = await import(<engine-ish>)`.
  const engineNamespaceBindings = new Set<string>();

  // Pass 1 — collect namespace bindings and flag named/destructured runTool.
  const collect = (node: ts.Node): void => {
    // 1a. Static `import ... from "..."`.
    if (ts.isImportDeclaration(node) && node.importClause) {
      const named = node.importClause.namedBindings;
      const spec = (node.moduleSpecifier as ts.StringLiteral).text;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          // `propertyName` is the imported name when an `as` alias is present;
          // otherwise `name` is the imported name. We flag on the IMPORTED name.
          const importedName = (element.propertyName ?? element.name).text;
          if (importedName === FORBIDDEN_SYMBOL) {
            hits.push({
              file,
              kind: "named-import",
              detail: `static named import of ${FORBIDDEN_SYMBOL} from "${spec}"`,
            });
          }
        }
      }
      if (named && ts.isNamespaceImport(named) && isEngineSpecifier(spec)) {
        engineNamespaceBindings.add(named.name.text);
      }
    }

    // 1b. `const X = await import(...)` / `const X = import(...)` /
    //     `const { runTool } = await import(...)`.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      // Unwrap a leading `await`.
      const init = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isCallExpression(init)) {
        const spec = dynamicImportSpecifier(init);
        if (spec !== null) {
          // Destructured: `const { runTool } = await import(...)`.
          if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              // `propertyName` is the source key when renamed
              // (`{ runTool: rt }`); else `name` holds the key.
              const sourceKey =
                element.propertyName && ts.isIdentifier(element.propertyName)
                  ? element.propertyName.text
                  : ts.isIdentifier(element.name)
                    ? element.name.text
                    : null;
              if (sourceKey === FORBIDDEN_SYMBOL) {
                hits.push({
                  file,
                  kind: "named-import",
                  detail: `dynamic import destructure of ${FORBIDDEN_SYMBOL} from "${spec}"`,
                });
              }
            }
          }
          // Whole-namespace binding: `const engine = await import(<engine>)`.
          if (ts.isIdentifier(node.name) && isEngineSpecifier(spec)) {
            engineNamespaceBindings.add(node.name.text);
          }
        }
      }
    }

    ts.forEachChild(node, collect);
  };
  collect(sf);

  // Pass 2 — member access `<x>.runTool`.
  const checkMemberAccess = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === FORBIDDEN_SYMBOL
    ) {
      const receiver = node.expression;
      // `ns.runTool` where `ns` is a collected engine namespace binding.
      if (
        ts.isIdentifier(receiver) &&
        engineNamespaceBindings.has(receiver.text)
      ) {
        hits.push({
          file,
          kind: "namespace-member",
          detail: `${receiver.text}.${FORBIDDEN_SYMBOL} (namespace member of an engine module)`,
        });
      }
      // `(await import(<engine>)).runTool` / `(import(<engine>)).runTool`.
      const inner = ts.isParenthesizedExpression(receiver)
        ? receiver.expression
        : receiver;
      const callNode = ts.isAwaitExpression(inner) ? inner.expression : inner;
      if (ts.isCallExpression(callNode)) {
        const spec = dynamicImportSpecifier(callNode);
        if (spec !== null && isEngineSpecifier(spec)) {
          hits.push({
            file,
            kind: "namespace-member",
            detail: `inline import("${spec}").${FORBIDDEN_SYMBOL}`,
          });
        }
      }
    }
    ts.forEachChild(node, checkMemberAccess);
  };
  checkMemberAccess(sf);

  return hits;
}

/** Parse an on-disk file and scan it for `runTool` reachability. */
function scanFile(file: string): RunToolHit[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return scanSourceFile(sf, file);
}

/** Scan a synthetic source string through the SAME core (self-tests). */
function scanSource(source: string, fileName = "synthetic.ts"): RunToolHit[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  return scanSourceFile(sf, fileName);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("runTool reachability guard (B-010)", () => {
  // Explicit budget: this test walks the whole vex-app/src tree and
  // AST-parses every .ts/.tsx file — I/O-bound, and the default 5s is
  // not enough on slow filesystems (WSL drvfs mounts). A longer timeout
  // does not weaken the guard; the assertion stays byte-identical.
  it(
    "no file under vex-app/src imports runTool (named, barrel, or namespace)",
    { timeout: 60_000 },
    () => {
    const files = listSourceFiles(VEX_APP_SRC);
    // Sanity: the walker actually found the vex-app source tree.
    expect(files.length).toBeGreaterThan(0);

    const hits: RunToolHit[] = [];
    for (const file of files) hits.push(...scanFile(file));

    // `runTool` sets `approved: true`, bypassing the approval gate. It is an
    // OPERATOR / LOCAL-SHELL-ONLY escape hatch and must never be reachable from
    // the untrusted vex-app renderer/preload/main. If this fails, do NOT relax
    // the guard — move the call back behind the operator shell and drive
    // vex-app through the normal turn-loop dispatch path (which keeps the
    // restricted-mode approval gate).
    const rendered = hits.map(
      (h) => `${path.relative(VEX_APP_SRC, h.file)} :: ${h.kind} - ${h.detail}`,
    );
    expect(rendered).toEqual([]);
  });

  // ── Detector self-tests (mutation coverage) ──────────────────────────────
  // Each shape MUST be flagged, so a future refactor of the scanner cannot
  // silently stop catching a real wiring. Negative controls prove it does not
  // over-match unrelated symbols.

  it("flags a static named import of runTool (a)", () => {
    expect(
      scanSource('import { runTool } from "@vex-agent/engine/index.js";'),
    ).toHaveLength(1);
  });

  it("flags a renamed static named import of runTool (a)", () => {
    expect(
      scanSource('import { runTool as rt } from "@vex-agent/engine/index.js";'),
    ).toHaveLength(1);
  });

  it("flags a named import of runTool from ANY specifier (a, fail-closed)", () => {
    // No legitimate reason for vex-app to import a symbol named runTool from
    // anywhere — flagged regardless of module to remove a re-export escape.
    expect(scanSource('import { runTool } from "./somewhere.js";')).toHaveLength(1);
  });

  it("flags a dynamic import destructure of runTool (a)", () => {
    expect(
      scanSource(
        'const { runTool } = await import("@vex-agent/engine/index.js");',
      ),
    ).toHaveLength(1);
  });

  it("flags a renamed dynamic import destructure of runTool (a)", () => {
    expect(
      scanSource(
        'const { runTool: rt } = await import("@vex-agent/engine/index.js");',
      ),
    ).toHaveLength(1);
  });

  it("flags a static namespace import + member access (c)", () => {
    expect(
      scanSource(
        'import * as engine from "@vex-agent/engine/index.js";\nengine.runTool("s", "t", {});',
      ),
    ).toHaveLength(1);
  });

  it("flags a dynamic namespace binding + member access (c)", () => {
    expect(
      scanSource(
        'const engine = await import("@vex-agent/engine/index.js");\nengine.runTool("s", "t", {});',
      ),
    ).toHaveLength(1);
  });

  it("flags an inline (await import(...)).runTool member access (c)", () => {
    expect(
      scanSource(
        '(await import("@vex-agent/engine/index.js")).runTool("s", "t", {});',
      ),
    ).toHaveLength(1);
  });

  it("flags barrel reachability via the alias-root specifier and run-tool module", () => {
    expect(
      scanSource('import { runTool } from "@vex-agent/engine";'),
    ).toHaveLength(1);
    expect(
      scanSource(
        'import * as rt from "@vex-agent/engine/core/run-tool.js";\nrt.runTool("s", "t", {});',
      ),
    ).toHaveLength(1);
  });

  it("does NOT flag unrelated symbols or unrelated member access (no over-match)", () => {
    // Different engine export — must not match.
    expect(
      scanSource(
        'const { processAgentTurn } = await import("@vex-agent/engine/index.js");',
      ),
    ).toHaveLength(0);
    // A `.runTool` member on a NON-engine namespace binding must not match
    // (e.g. an unrelated local object). Only engine-bound namespaces count.
    expect(
      scanSource(
        'import * as helpers from "./helpers.js";\nhelpers.runTool();',
      ),
    ).toHaveLength(0);
    // A local property literally named runTool on a plain object is not an
    // engine import and must not match.
    expect(
      scanSource('const obj = { runTool: 1 };\nconsole.log(obj.runTool);'),
    ).toHaveLength(0);
  });
});
