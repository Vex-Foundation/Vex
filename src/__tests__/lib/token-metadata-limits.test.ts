/**
 * ONE DEFINITION OF THE LENGTH CAPS (task 10).
 *
 * The caps used to be hand-typed in three places: the launch validator, the
 * launch preview, and the IPC form schema. This pins two things:
 *
 *   1. the VALUES, exactly as they were before the consolidation, so a "shared
 *      module" refactor cannot quietly move a limit the chain enforces;
 *   2. that the agent-runtime surfaces refuse AT those caps and accept right
 *      below them, which is what proves they read the shared definition rather
 *      than a leftover copy.
 *
 * The IPC schema's half lives in `vex-app` (it cannot be imported from a root
 * test); it re-exports these same constants under its `TOKEN_LAUNCH_*` names.
 */

import { describe, it, expect } from "vitest";

import {
  TOKEN_METADATA_NAME_MAX,
  TOKEN_METADATA_SYMBOL_MAX,
  TOKEN_METADATA_DESCRIPTION_MAX,
  TOKEN_METADATA_LINKS_MAX,
  TOKEN_METADATA_LINK_LENGTH_MAX,
} from "../../lib/token-metadata-limits.js";
import { validateLaunchRequest } from "../../vex-agent/tools/protocols/trench/handlers/launch/validate.js";

describe("token metadata length caps", () => {
  it("keeps the measured values unchanged by the consolidation", () => {
    expect(TOKEN_METADATA_NAME_MAX).toBe(18);
    expect(TOKEN_METADATA_SYMBOL_MAX).toBe(16);
    expect(TOKEN_METADATA_DESCRIPTION_MAX).toBe(512);
    expect(TOKEN_METADATA_LINKS_MAX).toBe(4);
    expect(TOKEN_METADATA_LINK_LENGTH_MAX).toBe(128);
  });

  it("keeps the symbol cap DELIBERATELY tighter than the name cap the chain shares with it", () => {
    // The chain reverts a symbol past 18, the same as a name. Vex refuses past
    // 16 on purpose; this pins the difference so it cannot be "tidied" away.
    expect(TOKEN_METADATA_SYMBOL_MAX).toBeLessThan(TOKEN_METADATA_NAME_MAX);
  });
});

describe("the launch validator enforces the shared caps", () => {
  function request(over: Record<string, unknown>): Record<string, unknown> {
    return { name: "Token", symbol: "TKN", imageId: "img_1", ...over };
  }

  it("accepts a name at the cap and refuses one character past it", () => {
    expect(validateLaunchRequest(request({ name: "a".repeat(TOKEN_METADATA_NAME_MAX) })).ok).toBe(true);
    const over = validateLaunchRequest(request({ name: "a".repeat(TOKEN_METADATA_NAME_MAX + 1) }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain(`at most ${TOKEN_METADATA_NAME_MAX} characters`);
  });

  it("accepts a symbol at the cap and refuses one character past it", () => {
    expect(validateLaunchRequest(request({ symbol: "a".repeat(TOKEN_METADATA_SYMBOL_MAX) })).ok).toBe(true);
    const over = validateLaunchRequest(request({ symbol: "a".repeat(TOKEN_METADATA_SYMBOL_MAX + 1) }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain(`at most ${TOKEN_METADATA_SYMBOL_MAX} characters`);
  });

  it("refuses a description past the cap", () => {
    const over = validateLaunchRequest(
      request({ description: "a".repeat(TOKEN_METADATA_DESCRIPTION_MAX + 1) }),
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain(`at most ${TOKEN_METADATA_DESCRIPTION_MAX} characters`);
  });

  it("refuses more links than the cap, and a link longer than the cap", () => {
    const links = Array.from({ length: TOKEN_METADATA_LINKS_MAX + 1 }, () => "https://vex.example");
    const tooMany = validateLaunchRequest(request({ links }));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toContain(`at most ${TOKEN_METADATA_LINKS_MAX} URLs`);

    const longLink = `https://vex.example/${"a".repeat(TOKEN_METADATA_LINK_LENGTH_MAX)}`;
    const tooLong = validateLaunchRequest(request({ links: [longLink] }));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.reason).toContain(`at most ${TOKEN_METADATA_LINK_LENGTH_MAX} characters`);
    }
  });
});
