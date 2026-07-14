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

  it("every bridge CH.* channel is referenced somewhere in the preload tree", () => {
    const expected = [
      "CH.messages.list",
      "CH.messages.getTail",
      "CH.messages.getAround",
      "CH.runtime.getState",
      "CH.runtime.requestPause",
      "CH.runtime.requestStop",
      "CH.runtime.requestResume",
      "CH.runtime.cancelWake",
      "CH.mission.getDraft",
      "CH.mission.updateDraft",
      "CH.mission.getDiff",
      "CH.mission.acceptContract",
      "CH.mission.start",
      "CH.mission.continue",
      "CH.mission.recover",
      "CH.mission.renew",
      "CH.mission.retry",
      "CH.mission.edit",
      "CH.mission.stop",
      // Phase 7 — read-only resolver for /mission-renew lineage.
      "CH.mission.getRenewableSource",
      "CH.approvals.listPending",
      "CH.approvals.listPendingAll",
      "CH.approvals.get",
      "CH.approvals.approve",
      "CH.approvals.reject",
      "CH.approvals.getHistory",
      "CH.wallets.listSessionWallets",
      "CH.wallets.setSessionWalletScope",
      "CH.wallets.getPreparedIntent",
      "CH.wallets.cancelPreparedIntent",
      "CH.models.listAvailable",
      "CH.onboarding.providerListModels",
      "CH.usage.getSessionTotals",
      "CH.usage.getLastTurn",
      "CH.usage.getContextWindow",
      "CH.compaction.getStatus",
      "CH.compaction.listHistory",
      "CH.compaction.retry",
      "CH.longMemory.list",
      // Memory-system S10 — read-only memory-manager inspector.
      "CH.memoryInspector.listCandidates",
      "CH.memoryInspector.listDecisions",
      "CH.memoryInspector.jobsSummary",
      "CH.memory.listSession",
      "CH.memory.getStats",
      // Stage 3 — read-only dual-scope POSITION portfolio.
      "CH.portfolio.read",
      // Move 0.3 — read-only per-session executed-trade activity (MOVES).
      "CH.portfolio.listMoves",
      "CH.sessions.getModel",
      // Error-diagnostics phase (D-FOLDER) — "Open logs folder".
      "CH.support.openLogsFolder",
      // Updater (M13) — user-triggered in-app update bridge.
      "CH.updater.check",
      "CH.updater.getStatus",
      "CH.updater.startUpdateNow",
      "CH.updater.cancelDownload",
      "CH.updater.restartAndInstallNow",
      "CH.updater.openReleaseNotes",
      // T1 — read-only live VEX market snapshot bridge.
      "CH.market.getVexSnapshot",
      // Hyperliquid — renderer-safe positions and user-confirmed session risk.
      "CH.hyperliquid.getPositions",
      "CH.hyperliquid.listRiskProposals",
      "CH.hyperliquid.confirmRiskProposal",
      "CH.hyperliquid.setSessionRiskPolicy",
      "CH.hyperliquid.getSessionRiskPolicy",
      "CH.hyperliquid.acknowledgeRisk",
      "CH.hyperliquid.getCandles",
      "CH.hyperliquid.getMarkets",
      "CH.hyperliquid.getBook",
      "CH.hyperliquid.getWorkspaceMode",
      "CH.hyperliquid.enterWorkspace",
      "CH.hyperliquid.exitWorkspace",
      // Live WebSocket feed — session-gated watch control.
      "CH.hyperliquid.watchLive",
      "CH.hyperliquid.unwatchLive",
      // User-owned global Hyperliquid settings stay on the settings bridge.
      "CH.settings.setHyperliquidPolicy",
    ];
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const channel of expected) {
      expect(corpus, `missing reference: ${channel}`).toContain(channel);
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

  it("exposes typed Hyperliquid position and risk-proposal events", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.hyperliquid.positionsUpdate not referenced in preload").toContain(
      "EV.hyperliquid.positionsUpdate",
    );
    expect(corpus, "EV.hyperliquid.riskProposalUpdate not referenced in preload").toContain(
      "EV.hyperliquid.riskProposalUpdate",
    );
    expect(corpus, "Hyperliquid position subscription not exposed").toContain(
      "onPositionsUpdate",
    );
    expect(corpus, "Hyperliquid proposal subscription not exposed").toContain(
      "onRiskProposalUpdate",
    );
    expect(corpus, "EV.hyperliquid.workspaceMode not referenced in preload").toContain(
      "EV.hyperliquid.workspaceMode",
    );
    expect(corpus, "Hyperliquid workspace subscription not exposed").toContain(
      "onWorkspaceMode",
    );
    expect(corpus, "Manual Hyperliquid workspace exit not exposed").toContain(
      "exitWorkspace",
    );
    expect(corpus, "Manual Hyperliquid workspace re-entry not exposed").toContain(
      "enterWorkspace",
    );
  });

  it("exposes the Hyperliquid live-feed watch control and candle/mids events", () => {
    const corpus = PRELOAD_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "EV.hyperliquid.candleUpdate not referenced in preload").toContain(
      "EV.hyperliquid.candleUpdate",
    );
    expect(corpus, "EV.hyperliquid.midsUpdate not referenced in preload").toContain(
      "EV.hyperliquid.midsUpdate",
    );
    expect(corpus, "Hyperliquid live watch not exposed").toContain("watchLive");
    expect(corpus, "Hyperliquid live unwatch not exposed").toContain("unwatchLive");
    expect(corpus, "Hyperliquid candle subscription not exposed").toContain("onCandleUpdate");
    expect(corpus, "Hyperliquid mids subscription not exposed").toContain("onMidsUpdate");
  });
});
