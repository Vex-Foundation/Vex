import { describe, expect, it } from "vitest";
import type { VexError } from "@shared/ipc/result.js";
import { getErrorCopy } from "../error-copy.js";

function makeError(partial: Partial<VexError> & { code: VexError["code"] }): VexError {
  return {
    domain: "wallet",
    message: "default",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId: "test-id",
    ...partial,
  };
}

describe("getErrorCopy", () => {
  it("returns generic copy for wallet.password_invalid (no auto-close)", () => {
    const c = getErrorCopy(makeError({ code: "wallet.password_invalid" }));
    expect(c.message).toBe("Master password is incorrect.");
    expect(c.autoCloseMs).toBeUndefined();
  });

  it("formats backoff seconds for wallet.export_throttled", () => {
    const c = getErrorCopy(
      makeError({ code: "wallet.export_throttled", retryAfterMs: 8000 }),
    );
    expect(c.message).toBe("Too many attempts. Try again in 8s.");
  });

  it("formats backoff minutes for >= 60s wait (secrets.unlock_throttled)", () => {
    const c = getErrorCopy(
      makeError({ code: "secrets.unlock_throttled", retryAfterMs: 300_000 }),
    );
    expect(c.message).toMatch(/5m/);
  });

  it("floors backoff to 1s if retryAfterMs is missing or 0", () => {
    const c = getErrorCopy(
      makeError({ code: "wallet.export_throttled" /* no retryAfterMs */ }),
    );
    expect(c.message).toBe("Too many attempts. Try again in 1s.");
  });

  it("returns auto-close hint for wallet.keystore_locked", () => {
    const c = getErrorCopy(makeError({ code: "wallet.keystore_locked" }));
    expect(c.autoCloseMs).toBe(3000);
    expect(c.message).toMatch(/Vault session locked/);
  });

  it("specialises wallet.keystore_missing copy when a chain is provided", () => {
    const evm = getErrorCopy(
      makeError({ code: "wallet.keystore_missing" }),
      { chain: "evm" },
    );
    expect(evm.message).toBe("EVM wallet keystore not found.");
    const sol = getErrorCopy(
      makeError({ code: "wallet.keystore_missing" }),
      { chain: "solana" },
    );
    expect(sol.message).toBe("Solana wallet keystore not found.");
  });

  it("uses generic copy for wallet.keystore_missing when chain is absent", () => {
    const c = getErrorCopy(makeError({ code: "wallet.keystore_missing" }));
    expect(c.message).toBe(
      "Wallet keystore not found. Generate or import a wallet first.",
    );
  });

  it("returns provider.unavailable static copy", () => {
    const c = getErrorCopy(makeError({ code: "provider.unavailable" }));
    expect(c.message).toBe(
      "The connected provider is temporarily unavailable. Try again in a moment.",
    );
  });

  it("returns onboarding.env_persist_failed copy", () => {
    const c = getErrorCopy(makeError({ code: "onboarding.env_persist_failed" }));
    expect(c.message).toBe("Failed to save credentials to vault.");
  });

  it("returns a fallback message for codes not in the mapping", () => {
    const c = getErrorCopy(
      makeError({
        code: "internal.unexpected",
        domain: "internal",
        message: "unspecified runtime failure",
      }),
    );
    expect(c.message).toBe("unspecified runtime failure");
  });

  it("returns fallback copy for wallet.risk_confirmation_required (caller is expected to branch first)", () => {
    const c = getErrorCopy(
      makeError({ code: "wallet.risk_confirmation_required" }),
    );
    expect(c.message).toBe("Risk confirmation required.");
    expect(c.autoCloseMs).toBeUndefined();
  });
});
