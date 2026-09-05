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
      "wallet.policy_blocked",
      "wallet.export_throttled",
      "wallet.keystore_locked",
      "wallet.keystore_corrupt",
      "wallet.keystore_missing",
      "wallet.password_invalid",
      "wallet.vault_corrupt",
  "wallet.vault_unavailable",
      "wallet.vault_incompatible",
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
      "provider.unavailable",
      "provider.test_failed",
      "provider.endpoint_unavailable",
      "provider.api_key_required",
      "support.persist_failed",
      "wallets.invalid_selection",
      "approvals.expired",
      "approvals.already_resolved",
      "approvals.run_terminated",
      "approvals.dispatch_failed",
      "approvals.policy_drift_blocked",
      "compaction.not_found",
      "compaction.invalid_state",
      "images.too_large",
      "images.unsupported_format",
      "images.not_found",
      "images.in_use",
      "images.store_unavailable",
      // The user backdrop under the glass shell: PNG/JPEG only (the measured
      // nativeImage decode set), 8 MiB stat gate, decode proof, one image.
      "shellBackdrop.too_large",
      "shellBackdrop.too_small",
      "shellBackdrop.unsupported_format",
      "shellBackdrop.undecodable",
      "shellBackdrop.store_unavailable",
      "tokenLaunch.preview_stale",
      "tokenLaunch.value_ceiling_exceeded",
      "tokenLaunch.launch_count_exceeded",
      "tokenLaunch.ceiling_not_set",
      // Vex Studio projects (stage P). Seven named refusals rather than a
      // generic failure: a project that cannot be created or edited is always
      // one of a small set of concrete, user-fixable situations.
      "projects.root_changed",
      "projects.root_unavailable",
      "projects.slug_taken",
      "projects.not_found",
      "projects.scope_conflict",
      "projects.wallet_drift",
      "projects.backing_session_integrity",
      "projects.deleting",
      "projects.slug_cleanup_pending",
      "projects.root_unverifiable",
      "projects.root_permission_denied",
      "projects.root_out_of_space",
      "projects.root_path_invalid",
      "projects.name_reserved",
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
      "market",
      "studio",
      "images",
      // The user's own wallpaper: a preference with a byte store behind it,
      // held apart from `images` because nothing downstream signs over it.
      "shellBackdrop",
      "tokenLaunch",
      // P3: a routing/ownership label only. `poolsLaunch` mints no error code
      // of its own — its refusals map onto codes that already exist, so the
      // VEX_ERROR_CODES pin above is deliberately unchanged.
      "poolsLaunch",
      "sessions",
      // Vex Studio projects (stage P): the project entity itself. It grants no
      // authority of its own - a project's permission and wallet scope are
      // enforced by the same session-keyed gates every agent session uses.
      "projects",
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
