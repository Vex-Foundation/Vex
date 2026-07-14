import { describe, expect, it } from "vitest";

// Type-only imports of the exported types: compile-time assertion that the
// barrel still surfaces every type. Referenced below so the import is not
// elided as unused.
import type {
  JsonValue,
  Result,
  VexDomain,
  VexError,
  VexErrorCode,
} from "../result.js";
import * as resultModule from "../result.js";
import { assertNever, err, ok, VEX_DOMAINS, VEX_ERROR_CODES } from "../result.js";

// ── Type-only references ─────────────────────────────────────────────────────
// Force the type imports to be load-bearing without emitting runtime code.
type _JsonValue = JsonValue;
type _VexDomain = VexDomain;
type _VexErrorCode = VexErrorCode;
type _VexError = VexError;
type _Result = Result<number>;

describe("result barrel surface", () => {
  it("exposes exactly the documented runtime export keys", () => {
    expect(Object.keys(resultModule).sort()).toEqual(
      [
        "VEX_DOMAINS",
        "VEX_ERROR_CODES",
        "assertNever",
        "err",
        "ok",
      ].sort()
    );
  });

  it("pins the runtime typeof of each value export", () => {
    expect(typeof ok).toBe("function");
    expect(typeof err).toBe("function");
    expect(typeof assertNever).toBe("function");
    expect(Array.isArray(VEX_ERROR_CODES)).toBe(true);
    expect(Array.isArray(VEX_DOMAINS)).toBe(true);
  });

  it("pins VEX_ERROR_CODES contents and order (deep equality)", () => {
    expect(VEX_ERROR_CODES).toEqual([
      "validation.invalid_input",
      "validation.invalid_sender",
      "wallet.signer_mismatch",
      "validation.archive_incomplete",
      "validation.archive_manifest_malformed",
      "permissions.denied",
      "wallet.insufficient_funds",
      "wallet.user_rejected",
      "wallet.risk_confirmation_required",
      "wallet.policy_blocked",
      "wallet.export_throttled",
      "wallet.keystore_locked",
      "wallet.keystore_corrupt",
      "wallet.keystore_missing",
      "wallet.password_invalid",
      "wallet.vault_not_configured",
      "wallet.cap_reached",
      "wallet.address_exists",
      "wallet.not_found",
      "secrets.unlock_throttled",
      "services.docker_unavailable",
      "services.port_in_use",
      "services.healthcheck_failed",
      "services.compose_failed",
      "data.search_unavailable",
      "data.migration_failed",
      "update.check_failed",
      "update.download_failed",
      "update.apply_failed",
      "onboarding.step_failed",
      "onboarding.env_persist_failed",
      "embedding.dim_locked",
      "embedding.db_unavailable",
      "embedding.defaults_unavailable",
      "provider.invalid_api_key",
      "provider.insufficient_credits",
      "provider.model_unsupported",
      "provider.polymarket_setup_failed",
      "provider.unavailable",
      "provider.test_failed",
      "support.persist_failed",
      "wallets.invalid_selection",
      "approvals.expired",
      "approvals.already_resolved",
      "approvals.run_terminated",
      "approvals.dispatch_failed",
      "approvals.policy_drift_blocked",
      "compaction.not_found",
      "compaction.invalid_state",
      "internal.contract_violation",
      "internal.cancelled",
      "internal.unexpected",
    ]);
  });

  it("pins VEX_DOMAINS contents and order (deep equality)", () => {
    expect(VEX_DOMAINS).toEqual([
      "wallet",
      "agents",
      "chat",
      "services",
      "data",
      "settings",
      "updater",
      "telemetry",
      "support",
      "permissions",
      "system",
      "docker",
      "database",
      "onboarding",
      "embedding",
      "capabilities",
      "messages",
      "runtime",
      "mission",
      "approvals",
      "wallets",
      "models",
      "usage",
      "compaction",
      "memory",
      "portfolio",
      // Hyperliquid adds a dedicated main-owned IPC error domain.
      "hyperliquid",
      "market",
      "sessions",
      "preload",
      "internal",
    ]);
  });

  it("constructors and assert behave as before", () => {
    const okResult = ok(7);
    expect(okResult).toEqual({ ok: true, data: 7 });

    const sample: _VexError = {
      code: "internal.unexpected",
      domain: "internal",
      message: "x",
      retryable: false,
      userActionable: false,
      redacted: true,
      correlationId: "cid",
    };
    expect(err(sample)).toEqual({ ok: false, error: sample });
    expect(() => assertNever("nope" as never)).toThrow();
  });
});
