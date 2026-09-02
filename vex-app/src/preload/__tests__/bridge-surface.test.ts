/**
 * Bridge surface test — preload exposes only domain-namespaced methods.
 *
 * Catches the lead-dev gate: no raw `ipcRenderer.invoke/send/on`
 * leaking through `contextBridge.exposeInMainWorld`, plus the
 * shell/agent composer policy from the refactor (must-fix Codex
 * 1+3): a single composer file, explicit named composition, no
 * namespace import / `export *` reaching `window.vex`.
 *
 * Done as a recursive static scan over the entire preload tree so
 * the test stays meaningful as new domain files are added under
 * `shell/` or `agent/`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CH } from "../../shared/ipc/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_ROOT = path.resolve(__dirname, "..");
const PRELOAD_INDEX = path.join(PRELOAD_ROOT, "index.ts");

function walkPreload(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkPreload(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const PRELOAD_FILES = walkPreload(PRELOAD_ROOT);

describe("preload bridge surface", () => {
  it("exposes the bridge through exactly one contextBridge.exposeInMainWorld call (target 'vex', in preload/index.ts)", () => {
    let callCount = 0;
    let matchedTarget: string | null = null;
    let matchedFile: string | null = null;
    // Require the second positional arg to be a bare identifier (the
    // assembled api object) rather than a string or `ipcRenderer`. A
    // loose comment with the text "contextBridge.exposeInMainWorld" is
    // discounted by also requiring `(\s*["']vex["']\s*,\s*<ident>\s*)`.
    const callPattern =
      /contextBridge\.exposeInMainWorld\(\s*(["'])([^"']+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/;

    for (const file of PRELOAD_FILES) {
      const src = readFileSync(file, "utf8");
      const occurrences = src.match(/contextBridge\.exposeInMainWorld/g);
      if (occurrences) callCount += occurrences.length;
      const matched = src.match(callPattern);
      if (matched) {
        matchedTarget = matched[2] ?? null;
        matchedFile = file;
      }
    }
    expect(callCount).toBe(1);
    expect(matchedTarget).toBe("vex");
    expect(matchedFile).toBe(PRELOAD_INDEX);
  });

  it("no preload file exposes raw invoke:/send:/on:/ipcRenderer: keys", () => {
    // These patterns catch object keys of the shape `invoke:`, `send:`,
    // `on:`, `ipcRenderer:`. Subscription helpers like `onProgress:`,
    // `onComposeLog:`, `onInstallProgress:` are safe because the regex
    // anchors the `on` word boundary against `\s*:` directly.
    const forbiddenKeyPatterns: ReadonlyArray<RegExp> = [
      /\binvoke\s*:/,
      /\bsend\s*:/,
      /\bon\s*:/,
      /\bipcRenderer\s*:/,
    ];
    for (const file of PRELOAD_FILES) {
      const src = readFileSync(file, "utf8");
      for (const pattern of forbiddenKeyPatterns) {
        expect(src, `${file} matched forbidden key ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it("no preload barrel uses export * (policy: explicit named exports only)", () => {
    for (const file of PRELOAD_FILES) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} uses export *`).not.toMatch(/\bexport\s*\*\s/);
    }
  });

  it("composer in preload/index.ts uses explicit shellBridge + agentBridge spread and satisfies VexBridge", () => {
    const src = readFileSync(PRELOAD_INDEX, "utf8");
    // No namespace imports (`import * as foo from "..."`) — Codex policy.
    expect(src).not.toMatch(/\bimport\s*\*\s+as\b/);
    // Explicit spread of the two group composers.
    expect(src).toMatch(/\{\s*\.\.\.shellBridge\s*,\s*\.\.\.agentBridge\s*\}/);
    // Pinned type guard.
    expect(src).toMatch(/satisfies\s+VexBridge/);
    // Imports the group barrels by name, not as namespace.
    expect(src).toMatch(/from\s+["']\.\/shell\/index\.js["']/);
    expect(src).toMatch(/from\s+["']\.\/agent\/index\.js["']/);
  });

  /**
   * Request channels that deliberately have NO bridge method.
   *
   * Both are DEAD CONSTANTS: neither has a main handler and neither is reached
   * from anywhere. They are named here rather than deleted because removing a
   * channel constant is a contract change that does not belong in this change,
   * and naming them is what keeps the check below total. The assertion under
   * this list makes the exclusion self-expiring: an entry that stops being a
   * real channel, or that acquires a bridge method, fails.
   */
  const NOT_ON_THE_BRIDGE: readonly string[] = [
    "CH.database.status",
    "CH.onboarding.providerTest",
  ];

  /**
   * EVERY request channel, DERIVED FROM `CH` ITSELF.
   *
   * This replaced a hand-curated `expected` array, and the array's own comments
   * had already diagnosed why: "a live bridge method nobody was pinning", said
   * next to `CH.portfolio.listAgentScan`, which had been missing from it. The
   * list was then kept manual, and it went on to miss `CH.projects.repairFiles`
   * and `CH.projects.delete` - so B0 could add a channel, a main handler and a
   * strict input schema, ship no preload method at all, and watch this suite
   * stay green. A curated list of what must exist can only ever catch omissions
   * somebody remembered to curate.
   *
   * Reading `CH` at runtime inverts that. The registry is the source of truth
   * for what channels exist, so a new one is IN the expectation the moment it is
   * declared, and the only way past this test is an explicit, named entry in
   * `NOT_ON_THE_BRIDGE` above.
   */
  it("every request channel in CH is referenced somewhere in the preload tree", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    const excluded = new Set(NOT_ON_THE_BRIDGE);
    const everyChannel: string[] = [];
    for (const [domain, actions] of Object.entries(CH)) {
      // `CH.cancel` is a bare string, not a domain group.
      if (typeof actions !== "object" || actions === null) continue;
      for (const action of Object.keys(actions)) {
        everyChannel.push(`CH.${domain}.${action}`);
      }
    }
    // A guard against an empty or mis-parsed registry silently making this
    // assertion vacuous.
    expect(everyChannel.length).toBeGreaterThan(100);

    const missing = everyChannel.filter(
      (reference) => !excluded.has(reference) && !corpus.includes(reference),
    );
    expect(missing, "request channels with no preload reference").toEqual([]);
  });

  it("the NOT_ON_THE_BRIDGE exclusions are still real, still unbridged channels", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const reference of NOT_ON_THE_BRIDGE) {
      const [, domain, action] = reference.split(".");
      const group = (CH as Record<string, unknown>)[domain ?? ""];
      expect(
        typeof group === "object" && group !== null
          ? Object.keys(group as Record<string, unknown>)
          : [],
        `${reference} is excluded but is not a channel in CH`,
      ).toContain(action);
      expect(
        corpus.includes(reference),
        `${reference} IS on the bridge now; remove it from NOT_ON_THE_BRIDGE`,
      ).toBe(false);
    }
  });

  it("exposes EV.engine.transcriptAppend and the transcript bridge method", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.engine.transcriptAppend not referenced in preload").toContain(
      "EV.engine.transcriptAppend",
    );
    expect(
      corpus,
      "onTranscriptAppend not exposed by the preload composer",
    ).toContain("onTranscriptAppend");
  });

  it("exposes EV.engine.streamDelta and the stream bridge method", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.engine.streamDelta not referenced in preload").toContain(
      "EV.engine.streamDelta",
    );
    expect(
      corpus,
      "onStreamDelta not exposed by the preload composer",
    ).toContain("onStreamDelta");
  });

  it("exposes EV.engine.controlState and the control-state bridge method (F5)", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.engine.controlState not referenced in preload").toContain(
      "EV.engine.controlState",
    );
    expect(
      corpus,
      "onControlState not exposed by the preload composer",
    ).toContain("onControlState");
  });

  it("exposes EV.engine.error and the error bridge method", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.engine.error not referenced in preload").toContain(
      "EV.engine.error",
    );
    expect(corpus, "onEngineError not exposed by the preload composer").toContain(
      "onEngineError",
    );
  });

  it("exposes EV.engine.missionUpdate and the mission-update bridge method", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.engine.missionUpdate not referenced in preload").toContain(
      "EV.engine.missionUpdate",
    );
    expect(corpus, "onMissionUpdate not exposed by the preload composer").toContain(
      "onMissionUpdate",
    );
  });

  it("exposes EV.engine.compactionPreparation and re-validates it in preload", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(
      corpus,
      "EV.engine.compactionPreparation not referenced in preload",
    ).toContain("EV.engine.compactionPreparation");
    expect(
      corpus,
      "onCompactionPreparation not exposed by the preload composer",
    ).toContain("onCompactionPreparation");
    // The preload is the THIRD validation layer — a malformed emit must be
    // dropped here, not handed to the renderer callback.
    expect(
      corpus,
      "preload does not re-validate the compaction-preparation payload",
    ).toContain("compactionPreparationEventSchema");
  });

  it("exposes EV.market.vex and the market-update bridge method (T1)", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.market.vex not referenced in preload").toContain(
      "EV.market.vex",
    );
    expect(
      corpus,
      "onVexUpdate not exposed by the preload composer",
    ).toContain("onVexUpdate");
  });

  it("exposes only typed Lighter public subscription methods and event channels", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const reference of [
      "EV.lighterTrading.candleSnapshot",
      "EV.lighterTrading.candleUpdate",
      "EV.lighterTrading.candleStatus",
      "onCandleSnapshot",
      "onCandleUpdate",
      "onCandleStatus",
      "EV.lighterTrading.publicBook",
      "EV.lighterTrading.publicTrades",
      "EV.lighterTrading.publicStats",
      "EV.lighterTrading.publicMarketStatus",
      "onPublicBook",
      "onPublicTrades",
      "onPublicStats",
      "onPublicMarketStatus",
    ]) {
      expect(corpus).toContain(reference);
    }
  });

  it("exposes EV.studio.hostStatus and the host-status bridge method (B0)", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(
      corpus,
      "EV.studio.hostStatus not referenced in preload",
    ).toContain("EV.studio.hostStatus");
    expect(
      corpus,
      "onHostStatus not exposed by the preload composer",
    ).toContain("onHostStatus");
  });

});
