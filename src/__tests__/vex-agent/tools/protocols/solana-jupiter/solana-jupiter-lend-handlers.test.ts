/**
 * Regression test for the `solana.lend.positions` earnings sub-call.
 *
 * `GET /earn/earnings` wants the Earn/vault "position token" address
 * (`pos.token.address`), not the underlying asset mint
 * (`pos.token.assetAddress`) — confirmed by the module's own doc
 * (`earn-api/JupiterLendEarnApi.md`: "earnings accepts one wallet address
 * plus one or more position token addresses") and by
 * https://developers.jup.ag/docs/openapi-spec/lend/lend.yaml, whose
 * `positions` query param is documented as "User token positions
 * (comma-separated)" while `assetAddress` is documented as the "underlying
 * asset address" — a distinct field.
 *
 * Deliberately a new sibling file rather than an addition to the existing
 * `solana-jupiter-handlers.test.ts` (515 lines, mid-split under a parallel
 * card in this same batch) — keeps this bugfix's test isolated from that
 * unrelated move-only work.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const {
  getJupiterLendEarnTokens,
  getJupiterLendEarnPositions,
  getJupiterLendEarnEarnings,
} = vi.hoisted(() => ({
  getJupiterLendEarnTokens: vi.fn(),
  getJupiterLendEarnPositions: vi.fn(),
  getJupiterLendEarnEarnings: vi.fn(),
}));

// B2 deleted `executeJupiterLendEarnDeposit`/`executeJupiterLendEarnWithdraw`
// (unreachable since K6's staged-seam conversion) — this file only exercises
// `solana.lend.positions`, which never touched them; the mock keys were
// obsolete cruft (B3, item 5).
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/service.js", () => ({
  getJupiterLendEarnTokens,
  getJupiterLendEarnPositions,
  getJupiterLendEarnEarnings,
}));

import { LEND_HANDLERS } from "@vex-agent/tools/protocols/solana-jupiter/handlers/lend.js";

/** Type-complete ProtocolExecutionContext for handler tests (mirrors solana-jupiter-handlers.test.ts). */
function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}

const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
// Position/vault ("Earn"/jlToken) address — what /earn/earnings' `positions` param wants.
const POSITION_TOKEN_ADDRESS = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
// Underlying asset mint (real USDC) — a distinct field, NOT what /earn/earnings wants.
const UNDERLYING_ASSET_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function fakePosition(overrides: { address?: string; assetAddress?: string } = {}) {
  return {
    token: {
      address: overrides.address ?? POSITION_TOKEN_ADDRESS,
      assetAddress: overrides.assetAddress ?? UNDERLYING_ASSET_ADDRESS,
      symbol: "jlUSDC",
    },
    ownerAddress: WALLET_ADDRESS,
    shares: "1000000",
    underlyingAssets: "1000000",
    underlyingBalance: "1000000",
    allowance: "0",
  };
}

describe("solana.lend.positions — earnings sub-call address", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the /earnings request from pos.token.address (the position/vault token), not pos.token.assetAddress (the underlying mint)", async () => {
    getJupiterLendEarnPositions.mockResolvedValueOnce([fakePosition()]);
    getJupiterLendEarnEarnings.mockResolvedValueOnce({ earnings: [], raw: [] });

    const result = await LEND_HANDLERS["solana.lend.positions"]!(
      { address: WALLET_ADDRESS },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(getJupiterLendEarnEarnings).toHaveBeenCalledWith(
      WALLET_ADDRESS,
      [POSITION_TOKEN_ADDRESS],
    );
    // The confirmed defect: the handler must NOT query with the underlying-asset mint.
    expect(getJupiterLendEarnEarnings).not.toHaveBeenCalledWith(
      WALLET_ADDRESS,
      [UNDERLYING_ASSET_ADDRESS],
    );
  });

  it("skips the earnings sub-call when the wallet has no open positions (genuine empty state, distinct from a masked bug)", async () => {
    getJupiterLendEarnPositions.mockResolvedValueOnce([]);

    const result = await LEND_HANDLERS["solana.lend.positions"]!(
      { address: WALLET_ADDRESS },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(getJupiterLendEarnEarnings).not.toHaveBeenCalled();
    const data = result.data as { positions: unknown[]; earnings: unknown[] };
    expect(data.positions).toEqual([]);
    expect(data.earnings).toEqual([]);
  });
});
