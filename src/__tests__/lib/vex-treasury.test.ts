/**
 * Pins the Vex treasury destination addresses. These are money-routing
 * constants (swap-integrator fees accrue to them), so an accidental edit MUST
 * fail loudly — a wrong address silently redirects fees to a stranger.
 */

import { describe, expect, it } from "vitest";
import { VEX_TREASURY_EVM, VEX_TREASURY_SOLANA } from "../../lib/vex-treasury.js";

describe("Vex treasury addresses", () => {
  it("EVM treasury is the exact reviewed address", () => {
    expect(VEX_TREASURY_EVM).toBe("0xe341f3da256C38356bce4Afd456d7fa36E356E94");
  });

  it("EVM treasury is a valid hex address", () => {
    expect(VEX_TREASURY_EVM).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("Solana treasury is the exact reviewed base58 address", () => {
    expect(VEX_TREASURY_SOLANA).toBe("EvA1d9zMBXKFVXjSUFyHphiKUpwHJcLfZfmUH9GCd1sX");
  });
});
