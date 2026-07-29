/**
 * `classifyEngineFailure` — EXHAUSTIVE mapping coverage.
 *
 * The owner's requirement is that every error category the SDK can express is
 * representable in the UI, not a hand-picked subset. So this file asserts a row
 * per member of the installed SDK's `ApiErrorType` (27) PLUS the open-enum
 * escape (28 rows total), and a row per SDK error class for the throw path,
 * where `ApiErrorType` never arrives.
 *
 * "Non-generic" is the bar: a mapping that answered `unknown` for a member the
 * SDK named would be a category the user can never understand. Only two rows
 * are allowed to be `unknown` — the SDK's own `unmapped` member and the
 * open-enum escape — and both are asserted explicitly rather than by omission.
 *
 * The member list is READ MECHANICALLY from the installed SDK's
 * `apierrortype.d.ts` at test time, not transcribed. Transcription was the
 * first design and it is exactly the failure mode `rules/90` warns about — a
 * test that re-implements the thing under test stays green while the product
 * drifts. Reading the declaration means an SDK upgrade that adds a member
 * fails HERE, loudly, instead of silently degrading a new failure mode to
 * "Unable to process the message".
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyEngineFailure,
  ENGINE_ERROR_CATEGORIES,
  type EngineErrorCategory,
} from "../engine-error-classification.js";

/**
 * Parse the `ApiErrorType` const object out of the INSTALLED SDK declaration.
 * Resolved through `require.resolve` rather than a hard-coded path so it
 * follows the real dependency, wherever pnpm put it.
 */
function readInstalledApiErrorTypes(): readonly string[] {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("@openrouter/sdk/package.json");
  const declaration = path.join(
    path.dirname(pkgJson),
    "esm/models/apierrortype.d.ts",
  );
  const source = readFileSync(declaration, "utf8");
  const block = source.slice(
    source.indexOf("export declare const ApiErrorType"),
    source.indexOf("};", source.indexOf("export declare const ApiErrorType")),
  );
  const members = [...block.matchAll(/readonly \w+:\s*"([a-z0-9_]+)"/g)].map(
    (match) => match[1] as string,
  );
  if (members.length === 0) {
    throw new Error(
      "Could not parse ApiErrorType from the installed SDK — the declaration shape changed; fix this parser rather than deleting the check.",
    );
  }
  return members;
}

const INSTALLED_API_ERROR_TYPES = readInstalledApiErrorTypes();

/** Our mapping rows. Every installed member must appear here — asserted below. */
const API_ERROR_TYPE_ROWS: ReadonlyArray<readonly [string, EngineErrorCategory]> = [
  ["context_length_exceeded", "context"],
  ["max_tokens_exceeded", "context"],
  ["token_limit_exceeded", "context"],
  ["string_too_long", "context"],
  ["payload_too_large", "context"],
  ["authentication", "account"],
  ["permission_denied", "account"],
  ["payment_required", "account"],
  ["rate_limit_exceeded", "capacity"],
  ["provider_overloaded", "capacity"],
  ["provider_unavailable", "capacity"],
  ["server", "capacity"],
  ["timeout", "capacity"],
  ["invalid_request", "request"],
  ["invalid_prompt", "request"],
  ["not_found", "request"],
  ["precondition_failed", "request"],
  ["unprocessable", "request"],
  ["content_policy_violation", "policy"],
  ["refusal", "policy"],
  ["invalid_image", "media"],
  ["image_too_large", "media"],
  ["image_too_small", "media"],
  ["unsupported_image_format", "media"],
  ["image_not_found", "media"],
  ["image_download_failed", "media"],
  ["unmapped", "unknown"],
];

describe("classifyEngineFailure — ApiErrorType (stream path)", () => {
  it("has a row for EVERY member the installed SDK declares, and no phantoms", () => {
    const declared = [...INSTALLED_API_ERROR_TYPES].sort();
    const covered = API_ERROR_TYPE_ROWS.map(([member]) => member).sort();
    // Set equality both ways: a new SDK member with no row fails here, and a
    // row for a member the SDK dropped fails here too.
    expect(covered).toEqual(declared);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("is 27 members in the currently installed SDK (v1.1.13)", () => {
    // Not the authority — the set equality above is. This pins the number the
    // Phase 2 spec was written against, so a change in COUNT is visible in the
    // diff rather than only in a set comparison.
    expect(INSTALLED_API_ERROR_TYPES).toHaveLength(27);
  });

  it.each([...INSTALLED_API_ERROR_TYPES])(
    "SDK member %s resolves to a category without throwing",
    (member) => {
      // Drives the classifier with the SDK's own string, not our copy of it.
      expect(ENGINE_ERROR_CATEGORIES).toContain(
        classifyEngineFailure({ errorType: member }),
      );
    },
  );

  it.each(API_ERROR_TYPE_ROWS)("maps %s -> %s", (errorType, expected) => {
    expect(classifyEngineFailure({ errorType })).toBe(expected);
  });

  it("maps every member except `unmapped` to a NON-generic category", () => {
    const generic = API_ERROR_TYPE_ROWS.filter(
      ([member, category]) => category === "unknown" && member !== "unmapped",
    );
    expect(generic).toEqual([]);
  });

  it("row 28 — an open-enum escape survives as data and resolves to `unknown`", () => {
    // `ApiErrorType` is an OpenEnum: at runtime an unrecognized value is a
    // plain string and is a LEGAL provider response. It must not throw and
    // must not be silently treated as "no signal".
    expect(classifyEngineFailure({ errorType: "quantum_flux_exceeded" })).toBe(
      "unknown",
    );
  });

  it("beats a contradicting status — the provider's own taxonomy wins", () => {
    // An SSE stream opens with HTTP 200 and reports the failure mid-body, so a
    // status accompanying an errorType is the LESS trustworthy signal.
    expect(
      classifyEngineFailure({ errorType: "rate_limit_exceeded", statusCode: 200 }),
    ).toBe("capacity");
  });
});

/** The 15 status-mapped SDK response classes, with the status each maps from. */
const STATUS_CLASS_ROWS: ReadonlyArray<
  readonly [string, number, EngineErrorCategory]
> = [
  ["BadRequestResponseError", 400, "request"],
  ["UnauthorizedResponseError", 401, "account"],
  ["PaymentRequiredResponseError", 402, "account"],
  ["ForbiddenResponseError", 403, "account"],
  ["NotFoundResponseError", 404, "request"],
  ["RequestTimeoutResponseError", 408, "capacity"],
  ["ConflictResponseError", 409, "request"],
  ["PayloadTooLargeResponseError", 413, "context"],
  ["UnprocessableEntityResponseError", 422, "request"],
  ["TooManyRequestsResponseError", 429, "capacity"],
  ["InternalServerResponseError", 500, "capacity"],
  ["BadGatewayResponseError", 502, "capacity"],
  ["ServiceUnavailableResponseError", 503, "capacity"],
  ["EdgeNetworkTimeoutResponseError", 524, "capacity"],
  ["ProviderOverloadedResponseError", 529, "capacity"],
];

describe("classifyEngineFailure — SDK classes (throw path)", () => {
  it("covers all 15 status-mapped response classes", () => {
    expect(STATUS_CLASS_ROWS).toHaveLength(15);
  });

  it.each(STATUS_CLASS_ROWS)(
    "%s (status %i) -> %s",
    (errorClass, statusCode, expected) => {
      expect(classifyEngineFailure({ errorClass, statusCode })).toBe(expected);
    },
  );

  it.each(STATUS_CLASS_ROWS)(
    "%s classifies from the class alone, with no status",
    (errorClass, _statusCode, expected) => {
      expect(classifyEngineFailure({ errorClass })).toBe(expected);
    },
  );

  it.each(STATUS_CLASS_ROWS)(
    "status %i classifies with no class either (buffered path)",
    (_errorClass, statusCode, expected) => {
      expect(classifyEngineFailure({ statusCode })).toBe(expected);
    },
  );

  it("both validation classes mean `the provider answered, we could not read it`", () => {
    expect(classifyEngineFailure({ errorClass: "ResponseValidationError" })).toBe(
      "unreadable_response",
    );
    // SDKValidationError extends plain Error and has NO statusCode at all —
    // the class name is the only signal that exists for it.
    expect(classifyEngineFailure({ errorClass: "SDKValidationError" })).toBe(
      "unreadable_response",
    );
  });

  it.each([
    ["ConnectionError", "capacity"],
    ["RequestTimeoutError", "capacity"],
    ["RequestAbortedError", "capacity"],
    ["UnexpectedClientError", "capacity"],
    ["InvalidRequestError", "request"],
  ] as ReadonlyArray<readonly [string, EngineErrorCategory]>)(
    "status-less transport %s -> %s (name is the only discriminator)",
    (errorClass, expected) => {
      expect(classifyEngineFailure({ errorClass })).toBe(expected);
    },
  );
});

describe("classifyEngineFailure — OpenRouterDefaultError catch-all", () => {
  // `M.fail("4XX"|"5XX")` throws OpenRouterDefaultError for ANY status outside
  // the 15 mapped classes, carrying only a status. The status branch must be
  // total over integers, not a 15-case list.
  it.each([
    [418, "request"],
    [451, "request"],
    [499, "request"],
    [507, "capacity"],
    [599, "capacity"],
  ] as ReadonlyArray<readonly [number, EngineErrorCategory]>)(
    "unmapped status %i -> %s",
    (statusCode, expected) => {
      expect(
        classifyEngineFailure({ errorClass: "OpenRouterDefaultError", statusCode }),
      ).toBe(expected);
      expect(classifyEngineFailure({ errorClass: "OpenRouterError", statusCode })).toBe(
        expected,
      );
    },
  );

  it("a status outside the HTTP range does not masquerade as a real category", () => {
    expect(classifyEngineFailure({ statusCode: 0 })).toBe("unknown");
    expect(classifyEngineFailure({ statusCode: 9999 })).toBe("unknown");
  });
});

describe("classifyEngineFailure — transport errno fallback", () => {
  it.each([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ])("%s (no status, no class) -> capacity", (causeCode) => {
    expect(classifyEngineFailure({ causeCode })).toBe("capacity");
  });

  it("an unknown errno is not silently called transient", () => {
    expect(classifyEngineFailure({ causeCode: "ENOTAREALCODE" })).toBe("unknown");
  });
});

describe("classifyEngineFailure — total behaviour", () => {
  it("returns `unknown` rather than throwing when nothing is known", () => {
    expect(classifyEngineFailure({})).toBe("unknown");
    expect(
      classifyEngineFailure({
        errorType: null,
        errorClass: null,
        statusCode: null,
        causeCode: null,
      }),
    ).toBe("unknown");
  });

  it("only ever returns a declared category", () => {
    const declared = new Set<string>(ENGINE_ERROR_CATEGORIES);
    const probes: ReadonlyArray<Parameters<typeof classifyEngineFailure>[0]> = [
      ...API_ERROR_TYPE_ROWS.map(([errorType]) => ({ errorType })),
      ...STATUS_CLASS_ROWS.map(([errorClass, statusCode]) => ({
        errorClass,
        statusCode,
      })),
      { errorType: "not_a_real_member" },
      { causeCode: "ECONNRESET" },
      {},
    ];
    for (const probe of probes) {
      expect(declared.has(classifyEngineFailure(probe))).toBe(true);
    }
  });
});
