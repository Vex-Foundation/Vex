import { describe, expect, it } from "vitest";
import {
  chainTokenDtoSchema,
  portfolioDtoSchema,
  portfolioReadInputSchema,
  positionTokenDtoSchema,
} from "../portfolio.js";

const SESSION = "00000000-0000-4000-8000-000000000003";
const ISO = "2026-05-21T10:00:00.000Z";

describe("portfolio input schema", () => {
  it("accepts a global scope with no sessionId", () => {
    expect(portfolioReadInputSchema.safeParse({ scope: "global" }).success).toBe(
      true,
    );
  });

  it("rejects a stray sessionId on a global request (strict, never widens)", () => {
    expect(
      portfolioReadInputSchema.safeParse({ scope: "global", sessionId: SESSION })
        .success,
    ).toBe(false);
  });

  it("requires a sessionId on a session request", () => {
    expect(portfolioReadInputSchema.safeParse({ scope: "session" }).success).toBe(
      false,
    );
  });

  it("rejects a non-uuid sessionId on a session request", () => {
    expect(
      portfolioReadInputSchema.safeParse({ scope: "session", sessionId: "nope" })
        .success,
    ).toBe(false);
  });

  it("accepts a session request with a valid uuid sessionId", () => {
    const parsed = portfolioReadInputSchema.safeParse({
      scope: "session",
      sessionId: SESSION,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.scope === "session") {
      expect(parsed.data.sessionId).toBe(SESSION);
    }
  });

  it("rejects an unknown scope", () => {
    expect(portfolioReadInputSchema.safeParse({ scope: "all" }).success).toBe(
      false,
    );
  });

  // ── WP-L2: global scope narrowed to one inventory wallet ───────────────

  it("accepts a global scope with an optional walletAddress", () => {
    const parsed = portfolioReadInputSchema.safeParse({
      scope: "global",
      walletAddress: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.scope === "global") {
      expect(parsed.data.walletAddress).toBe(
        "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
      );
    }
  });

  it("rejects an empty walletAddress", () => {
    expect(
      portfolioReadInputSchema.safeParse({ scope: "global", walletAddress: "" })
        .success,
    ).toBe(false);
  });

  it("rejects a walletAddress longer than 128 characters", () => {
    expect(
      portfolioReadInputSchema.safeParse({
        scope: "global",
        walletAddress: "0x" + "a".repeat(128),
      }).success,
    ).toBe(false);
  });

  it("rejects a walletAddress on a session request (strict, never mixes scopes)", () => {
    expect(
      portfolioReadInputSchema.safeParse({
        scope: "session",
        sessionId: SESSION,
        walletAddress: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
      }).success,
    ).toBe(false);
  });
});

describe("portfolio dto schema", () => {
  function dtoFixture(overrides: Record<string, unknown> = {}) {
    return {
      scope: "global",
      walletCount: 2,
      liveTotalUsd: 1234.56,
      snapshotTotalUsd: 1200,
      pnlVsPrev: 34.56,
      snapshotAt: ISO,
      tokens: [
        { chainId: 1, symbol: "ETH", balanceUsd: 1000 },
        { chainId: 137, symbol: "USDC", balanceUsd: 234.56 },
      ],
      chains: [
        {
          chainId: 1,
          family: "evm",
          totalUsd: 1000,
          tokens: [{ symbol: "ETH", balanceUsd: 1000 }],
        },
      ],
      ...overrides,
    };
  }

  it("parses a sample dto", () => {
    expect(portfolioDtoSchema.safeParse(dtoFixture()).success).toBe(true);
  });

  it("accepts the empty portfolio (zero wallets, no snapshot)", () => {
    const parsed = portfolioDtoSchema.safeParse({
      scope: "session",
      walletCount: 0,
      liveTotalUsd: 0,
      snapshotTotalUsd: null,
      pnlVsPrev: null,
      snapshotAt: null,
      tokens: [],
      chains: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown key (strict)", () => {
    expect(
      portfolioDtoSchema.safeParse(dtoFixture({ extraKey: true })).success,
    ).toBe(false);
  });

  it("rejects an invalid scope enum", () => {
    expect(
      portfolioDtoSchema.safeParse(dtoFixture({ scope: "everything" })).success,
    ).toBe(false);
  });

  it("rejects a negative walletCount", () => {
    expect(
      portfolioDtoSchema.safeParse(dtoFixture({ walletCount: -1 })).success,
    ).toBe(false);
  });

  it("allows a null chainId and null symbol on a token line", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: null,
        symbol: null,
        balanceUsd: 0,
      }).success,
    ).toBe(true);
  });

  it("allows an UNPRICED token line (balanceUsd null) carrying an amount", () => {
    const parsed = positionTokenDtoSchema.safeParse({
      chainId: 4663,
      symbol: "ETH",
      balanceUsd: null,
      amount: 0.005,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(0.005);
  });

  it("defaults a missing amount to null (tolerant of pre-amount payloads)", () => {
    const parsed = positionTokenDtoSchema.safeParse({
      chainId: 1,
      symbol: "ETH",
      balanceUsd: 1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBeNull();
  });

  it("rejects an unknown key on a token line (strict)", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "ETH",
        balanceUsd: 1,
        raw: "0xdeadbeef",
      }).success,
    ).toBe(false);
  });

  it("rejects more than 500 token lines (defensive bound)", () => {
    const tokens = Array.from({ length: 501 }, () => ({
      chainId: 1,
      symbol: "ETH",
      balanceUsd: 1,
    }));
    expect(portfolioDtoSchema.safeParse(dtoFixture({ tokens })).success).toBe(
      false,
    );
  });

  // ── Per-chain breakdown strictness (codex plan review) ────────────────

  function chainFixture(overrides: Record<string, unknown> = {}) {
    return {
      chainId: 8453,
      family: "evm",
      totalUsd: 12.5,
      tokens: [{ symbol: "USDC", balanceUsd: 12.5 }],
      ...overrides,
    };
  }

  it("requires the chains field (additive but not optional)", () => {
    const { chains: _chains, ...withoutChains } = dtoFixture();
    expect(portfolioDtoSchema.safeParse(withoutChains).success).toBe(false);
  });

  it("accepts a zero chain totalUsd (unpriced-only chain) but rejects a negative one", () => {
    expect(
      portfolioDtoSchema.safeParse(
        dtoFixture({ chains: [chainFixture({ totalUsd: 0, tokens: [] })] }),
      ).success,
    ).toBe(true);
    expect(
      portfolioDtoSchema.safeParse(
        dtoFixture({ chains: [chainFixture({ totalUsd: -1 })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a zero chain token balanceUsd but accepts null (unpriced line)", () => {
    expect(
      portfolioDtoSchema.safeParse(
        dtoFixture({
          chains: [chainFixture({ tokens: [{ symbol: "X", balanceUsd: 0 }] })],
        }),
      ).success,
    ).toBe(false);
    expect(
      portfolioDtoSchema.safeParse(
        dtoFixture({
          chains: [
            chainFixture({
              totalUsd: 0,
              tokens: [{ symbol: "ETH", balanceUsd: null, amount: 0.005 }],
            }),
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects more than 3 tokens on a chain (top-3 bound)", () => {
    const tokens = Array.from({ length: 4 }, (_, i) => ({
      symbol: `T${i}`,
      balanceUsd: 4 - i,
    }));
    expect(
      portfolioDtoSchema.safeParse(dtoFixture({ chains: [chainFixture({ tokens })] }))
        .success,
    ).toBe(false);
  });

  it("rejects more than 64 chains (defensive bound)", () => {
    const chains = Array.from({ length: 65 }, (_, i) =>
      chainFixture({ chainId: 1000 + i }),
    );
    expect(portfolioDtoSchema.safeParse(dtoFixture({ chains })).success).toBe(
      false,
    );
  });

  it("rejects an unknown key on a chain entry and an invalid family (strict)", () => {
    expect(
      portfolioDtoSchema.safeParse(
        dtoFixture({ chains: [chainFixture({ extra: true })] }),
      ).success,
    ).toBe(false);
    expect(
      portfolioDtoSchema.safeParse(
        dtoFixture({ chains: [chainFixture({ family: "bitcoin" })] }),
      ).success,
    ).toBe(false);
  });

  // ── tokenAddress: address-correct aggregation (position branding) ──────

  it("accepts a valid EVM tokenAddress on a flat token line", () => {
    const parsed = positionTokenDtoSchema.safeParse({
      chainId: 1,
      symbol: "ETH",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      balanceUsd: 1000,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tokenAddress).toBe(
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      );
    }
  });

  it("accepts a valid Solana base58 tokenAddress on a chain-breakdown token line", () => {
    const parsed = chainTokenDtoSchema.safeParse({
      symbol: "SOL",
      tokenAddress: "So11111111111111111111111111111111111111112",
      balanceUsd: 50,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a null tokenAddress and tolerates a missing tokenAddress key entirely (additive, defensive default)", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "ETH",
        tokenAddress: null,
        balanceUsd: 1,
      }).success,
    ).toBe(true);
    const withoutKey = positionTokenDtoSchema.safeParse({
      chainId: 1,
      symbol: "ETH",
      balanceUsd: 1,
    });
    expect(withoutKey.success).toBe(true);
    if (withoutKey.success) {
      expect(withoutKey.data.tokenAddress).toBeUndefined();
    }
  });

  it("rejects a malformed tokenAddress (wrong shape)", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "ETH",
        tokenAddress: "not-an-address",
        balanceUsd: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an oversized tokenAddress", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "ETH",
        tokenAddress: "0x" + "a".repeat(200),
        balanceUsd: 1,
      }).success,
    ).toBe(false);
  });

  // ── tokenName: additive human-readable name (B5) ───────────────────────

  it("accepts a real-world tokenName with an internal space on a flat token line", () => {
    const parsed = positionTokenDtoSchema.safeParse({
      chainId: 1,
      symbol: "USDC",
      tokenName: "USD Coin",
      balanceUsd: 1000,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tokenName).toBe("USD Coin");
  });

  it("accepts a tokenName on a chain-breakdown token line", () => {
    expect(
      chainTokenDtoSchema.safeParse({
        symbol: "USDC",
        tokenName: "USD Coin",
        balanceUsd: 50,
      }).success,
    ).toBe(true);
  });

  it("accepts a null tokenName and tolerates a missing tokenName key entirely (additive)", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "ETH",
        tokenName: null,
        balanceUsd: 1,
      }).success,
    ).toBe(true);
    const withoutKey = positionTokenDtoSchema.safeParse({
      chainId: 1,
      symbol: "ETH",
      balanceUsd: 1,
    });
    expect(withoutKey.success).toBe(true);
    if (withoutKey.success) {
      expect(withoutKey.data.tokenName).toBeUndefined();
    }
  });

  it("rejects a tokenName that is not already in its sanitized form (leading/trailing whitespace)", () => {
    // The schema is a VALIDATION GATE on an already-sanitized shape, not a
    // transformer — main must sanitize before building the DTO.
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "USDC",
        tokenName: "  USD Coin  ",
        balanceUsd: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a hostile tokenName (control character)", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "USDC",
        tokenName: "BAD\nNAME",
        balanceUsd: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts exactly 64 chars and rejects 65 chars for tokenName", () => {
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "X",
        tokenName: "A".repeat(64),
        balanceUsd: 1,
      }).success,
    ).toBe(true);
    expect(
      positionTokenDtoSchema.safeParse({
        chainId: 1,
        symbol: "X",
        tokenName: "A".repeat(65),
        balanceUsd: 1,
      }).success,
    ).toBe(false);
  });
});

describe("portfolioReadInputSchema - the project arm (B0)", () => {
  const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("accepts a bare project read", () => {
    expect(
      portfolioReadInputSchema.safeParse({ scope: "project", projectId: PROJECT })
        .success,
    ).toBe(true);
  });

  it("accepts an inventory-shaped walletId", () => {
    const parsed = portfolioReadInputSchema.safeParse({
      scope: "project",
      projectId: PROJECT,
      walletId: "evm_3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(parsed.success).toBe(true);
  });

  it("REJECTS a missing or non-uuid projectId", () => {
    expect(
      portfolioReadInputSchema.safeParse({ scope: "project" }).success,
    ).toBe(false);
    expect(
      portfolioReadInputSchema.safeParse({ scope: "project", projectId: "nope" })
        .success,
    ).toBe(false);
  });

  it("REJECTS a stray field from another arm", () => {
    // `.strict()` is what stops a malformed request from silently widening
    // into a different scope than the caller asked for.
    expect(
      portfolioReadInputSchema.safeParse({
        scope: "project",
        projectId: PROJECT,
        sessionId: PROJECT,
      }).success,
    ).toBe(false);
    expect(
      portfolioReadInputSchema.safeParse({
        scope: "project",
        projectId: PROJECT,
        walletAddress: "0x1111111111111111111111111111111111111111",
      }).success,
    ).toBe(false);
  });

  it("REJECTS an address supplied where an id belongs", () => {
    // The renderer never supplies an address on any arm; ids are resolved
    // server-side. A 0x address is over the id bound only by accident, so the
    // real guarantee is main's membership check - this pins the intent.
    const parsed = portfolioReadInputSchema.safeParse({
      scope: "project",
      projectId: PROJECT,
      walletId: "x".repeat(129),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("portfolioDtoSchema - the project scope (B0)", () => {
  it("accepts scope: project", () => {
    expect(
      portfolioDtoSchema.safeParse({
        scope: "project",
        walletCount: 1,
        liveTotalUsd: 10,
        snapshotTotalUsd: null,
        pnlVsPrev: null,
        snapshotAt: null,
        tokens: [],
        chains: [],
      }).success,
    ).toBe(true);
  });
});
