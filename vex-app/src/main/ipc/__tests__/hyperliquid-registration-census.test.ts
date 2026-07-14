import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = path.resolve(__dirname, "..", "hyperliquid.ts");

const EXPECTED_CHANNEL_REFS = [
  "CH.hyperliquid.acknowledgeRisk",
  "CH.hyperliquid.confirmRiskProposal",
  "CH.hyperliquid.enterWorkspace",
  "CH.hyperliquid.exitWorkspace",
  "CH.hyperliquid.getBook",
  "CH.hyperliquid.getCandles",
  "CH.hyperliquid.getFundingHistory",
  "CH.hyperliquid.getMarkets",
  "CH.hyperliquid.getOpenOrders",
  "CH.hyperliquid.getOrderHistory",
  "CH.hyperliquid.getPositions",
  "CH.hyperliquid.getSessionRiskPolicy",
  "CH.hyperliquid.getTradeHistory",
  "CH.hyperliquid.getTwapHistory",
  "CH.hyperliquid.getWorkspaceMode",
  "CH.hyperliquid.listRiskProposals",
  "CH.hyperliquid.setSessionRiskPolicy",
  "CH.hyperliquid.unwatchLive",
  "CH.hyperliquid.watchLive",
] as const;

function resolveRelativeModule(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = base.endsWith(".js")
    ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]
    : [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next NodeNext source shape.
    }
  }
  return null;
}

function reachableHyperliquidIpcModules(): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [ENTRYPOINT];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const imports = source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g);
    for (const match of imports) {
      const resolved = resolveRelativeModule(match[1] ?? "", file);
      if (resolved !== null && resolved.includes(`${path.sep}ipc${path.sep}hyperliquid`)) {
        pending.push(resolved);
      }
    }
  }
  return visited;
}

describe("Hyperliquid IPC registration census", () => {
  it("keeps every existing channel reachable from the public registrar exactly once", () => {
    const refs: string[] = [];
    for (const file of reachableHyperliquidIpcModules()) {
      const source = readFileSync(file, "utf8");
      refs.push(...[...source.matchAll(/channel:\s*(CH\.hyperliquid\.[A-Za-z0-9]+)/g)].map((match) => match[1] ?? ""));
    }
    expect(refs.sort()).toEqual([...EXPECTED_CHANNEL_REFS].sort());
  });
});
