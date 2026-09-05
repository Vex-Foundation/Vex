/**
 * The portfolio READ KEY and the card-scope mapper.
 *
 * ## The defect these pin
 *
 * `portfolioKeys.read` used to take `(scope, activeSessionId)`, which was
 * exactly right for the two scopes that existed and silently wrong for the
 * third. A project has no session id, so every project keyed as
 * `["portfolio", "project", null]`: ONE cache row shared by every project in
 * Vex, handing whichever project rendered second the first one's balances. The
 * same `null` came out of `scopeSessionId`, the card-scope adapter, so a
 * project scope also READ as the global inventory aggregate - every wallet Vex
 * knows about, rendered under a project's name.
 *
 * Both halves are money display, so both are asserted here: distinct inputs
 * must produce distinct keys, and the mapper must never turn a project scope
 * into a global read.
 */

import { describe, expect, it } from "vitest";

import type { PortfolioReadInput } from "@shared/schemas/portfolio.js";
import { portfolioKeys } from "../queryKeys.js";
import {
  portfolioReadInputFor,
  type PortfolioCardScope,
} from "../../../features/appShell/book/portfolio/portfolio-scope.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const WALLET = "33333333-3333-4333-8333-333333333333";

function key(input: PortfolioReadInput): string {
  return JSON.stringify(portfolioKeys.read(input));
}

describe("portfolioKeys.read", () => {
  it("gives two projects that SHARE an inventory wallet distinct keys", () => {
    // The exact production case: two Studio projects pointed at the same
    // wallet. Under the old key both were `["portfolio","project",null]`, so
    // the second to render got the first's cached portfolio.
    expect(key({ scope: "project", projectId: PROJECT_A })).not.toBe(
      key({ scope: "project", projectId: PROJECT_B }),
    );
  });

  it("keys a project's per-wallet read apart from its aggregate", () => {
    const aggregate = key({ scope: "project", projectId: PROJECT_A });
    const narrowed = key({
      scope: "project",
      projectId: PROJECT_A,
      walletId: WALLET,
    });
    expect(narrowed).not.toBe(aggregate);
  });

  it("keys every distinct read input distinctly", () => {
    const inputs: readonly PortfolioReadInput[] = [
      { scope: "global" },
      { scope: "global", walletAddress: "0xabc" },
      { scope: "global", walletAddress: "0xdef" },
      { scope: "session", sessionId: PROJECT_A },
      { scope: "session", sessionId: PROJECT_B },
      { scope: "project", projectId: PROJECT_A },
      { scope: "project", projectId: PROJECT_B },
      { scope: "project", projectId: PROJECT_A, walletId: WALLET },
    ];
    const keys = inputs.map(key);
    expect(new Set(keys).size).toBe(inputs.length);
  });

  it("keeps every key under the `portfolio` prefix the invalidations use", () => {
    // `usePortfolioRefresh` and the activity-push invalidations both target
    // `portfolioKeys.all` (`["portfolio"]`) as a PREFIX. A key that did not
    // start with it would go stale next to a freshly confirmed transaction.
    for (const input of [
      { scope: "global" } as const,
      { scope: "session", sessionId: PROJECT_A } as const,
      { scope: "project", projectId: PROJECT_A } as const,
    ]) {
      expect(portfolioKeys.read(input)[0]).toBe(portfolioKeys.all[0]);
    }
  });

  it("did not move the global or session keys", () => {
    // These two shapes are unchanged from the key this replaced, so no existing
    // cache entry or test moves.
    expect(portfolioKeys.read({ scope: "global" })).toEqual([
      "portfolio",
      "global",
      null,
    ]);
    expect(portfolioKeys.read({ scope: "session", sessionId: PROJECT_A })).toEqual([
      "portfolio",
      "session",
      PROJECT_A,
    ]);
  });
});

describe("portfolioReadInputFor", () => {
  it("NEVER produces a global read from a project scope", () => {
    // The lossy adapter's whole failure mode, asserted directly.
    const scopes: readonly PortfolioCardScope[] = [
      { kind: "project", projectId: PROJECT_A },
      { kind: "project", projectId: PROJECT_B, walletId: WALLET },
    ];
    for (const scope of scopes) {
      const input = portfolioReadInputFor(scope);
      expect(input.scope).toBe("project");
      expect(input).not.toEqual({ scope: "global" });
    }
  });

  it("carries the project id and the optional wallet id through", () => {
    expect(portfolioReadInputFor({ kind: "project", projectId: PROJECT_A })).toEqual({
      scope: "project",
      projectId: PROJECT_A,
    });
    expect(
      portfolioReadInputFor({
        kind: "project",
        projectId: PROJECT_A,
        walletId: WALLET,
      }),
    ).toEqual({ scope: "project", projectId: PROJECT_A, walletId: WALLET });
  });

  it("maps global and session exactly as before", () => {
    expect(portfolioReadInputFor({ kind: "global" })).toEqual({ scope: "global" });
    expect(
      portfolioReadInputFor({ kind: "session", sessionId: PROJECT_A }),
    ).toEqual({ scope: "session", sessionId: PROJECT_A });
  });
});
