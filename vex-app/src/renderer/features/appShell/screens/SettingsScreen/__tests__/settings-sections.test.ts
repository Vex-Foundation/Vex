import { describe, expect, it } from "vitest";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { LINE_ICON_NAMES } from "../../../../../components/icons/line/index.js";
import {
  SETTINGS_SECTIONS,
  settingsNav,
  settingsStatusSwatch,
  superboardRegisterStatus,
} from "../settings-sections.js";

// The nav every launch shows: the bundled native runtime's.
const SETTINGS_NAV = settingsNav(true);

const SHARE = "A".repeat(43);

function failedPending(): SuperboardKeyStatus {
  return {
    kind: "pending",
    shareToken: SHARE,
    attempt: {
      kind: "failed",
      at: "2026-09-08T12:00:00.000Z",
      failure: { kind: "transport", reason: "timeout" },
      detail: "VexError: Request timed out after 15000ms",
      correlationId: "corr-1",
      durationMs: 15012,
    },
  };
}

describe("superboardRegisterStatus", () => {
  it("keeps the loading dash unguessed", () => {
    expect(superboardRegisterStatus(null)).toEqual({ word: "-", tone: "neutral" });
  });

  it("keeps Not ready and Not set distinct", () => {
    expect(superboardRegisterStatus({ kind: "not_ready" })).toEqual({
      word: "Not ready",
      tone: "warning",
    });
    expect(superboardRegisterStatus({ kind: "missing" })).toEqual({
      word: "Not set",
      tone: "warning",
    });
  });

  it("links quietly and warns only on a failed attempt", () => {
    expect(
      superboardRegisterStatus({ kind: "pending", shareToken: SHARE, attempt: { kind: "none" } }),
    ).toEqual({ word: "Linking", tone: "neutral" });
    expect(superboardRegisterStatus(failedPending())).toEqual({
      word: "Not linked",
      tone: "warning",
    });
  });

  it("stays Linked whatever the rotation capability says", () => {
    for (const rotation of [
      { kind: "available" },
      { kind: "unavailable", reason: "server" },
      { kind: "unavailable", reason: "unknown" },
    ] as const) {
      expect(
        superboardRegisterStatus({
          kind: "registered",
          shareToken: SHARE,
          rotation,
          rotatedAt: null,
        }),
      ).toEqual({ word: "Linked", tone: "success" });
    }
  });

  it("names a rotation in flight Rotating", () => {
    const pending = failedPending();
    if (pending.kind !== "pending") throw new Error("fixture must be pending");
    for (const attempt of [{ kind: "none" } as const, pending.attempt]) {
      expect(
        superboardRegisterStatus({
          kind: "registered",
          shareToken: SHARE,
          rotation: { kind: "pending", attempt },
          rotatedAt: null,
        }),
      ).toEqual({ word: "Rotating", tone: "neutral" });
    }
  });
});

describe("the Settings nav", () => {
  it("has four groups in the design's order, App first", () => {
    expect(SETTINGS_NAV.map((group) => group.name)).toEqual([
      "App",
      "Security and wallets",
      "The agent",
      "Connections",
    ]);
  });

  it("holds Preferences alone under App and every section once, in custody order", () => {
    expect(SETTINGS_NAV.map((group) => group.items.map((item) => item.id))).toEqual([
      ["preferences"],
      ["vault", "wallets", "apiKeys"],
      ["model", "vexCloud", "memory", "tuning", "localRuntime"],
      ["superboardKey", "lighterPoints"],
    ]);
    // Flattened, the sections keep the order the registry declares.
    expect(SETTINGS_NAV.flatMap((group) => group.items.map((item) => item.id)).slice(1)).toEqual(
      SETTINGS_SECTIONS.map((meta) => meta.id),
    );
  });

  it("draws every row with a line icon the catalogue has", () => {
    for (const item of SETTINGS_NAV.flatMap((group) => group.items)) {
      expect(LINE_ICON_NAMES).toContain(item.icon);
    }
  });

  it("keeps the names and hints the register had", () => {
    expect(SETTINGS_SECTIONS.map((meta) => [meta.id, meta.name, meta.hint])).toEqual([
      ["vault", "Vault", "The master password that encrypts everything on this machine"],
      ["wallets", "Wallets", "EVM and Solana wallets - add, remove, recover, back up, or export"],
      ["apiKeys", "API keys", "Jupiter, Tavily, Rettiwt, and chain endpoint overrides"],
      ["model", "Model", "The provider and model the agent thinks with"],
      ["vexCloud", "Vex Cloud", "Sign in, linked wallets, and your VEX balance"],
      ["memory", "Memory", "The embedding endpoint behind long-term recall"],
      ["tuning", "Tuning", "Context, output, and sampling limits"],
      ["localRuntime", "Local runtime", "The database and embeddings server running on this computer"],
      ["superboardKey", "Superboard key", "One code you paste into Superboard"],
      [
        "lighterPoints",
        "Lighter",
        "Robinhood Chain points, and the trading setup the agent reads: capital share and leverage per market",
      ],
    ]);
  });

  it("maps a status tone to a fill, never a hue", () => {
    expect(settingsStatusSwatch("success")).toBe("done");
    expect(settingsStatusSwatch("neutral")).toBe("idle");
    expect(settingsStatusSwatch("warning")).toBe("warning");
  });
});
