import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIGHTER_CAPABILITY_POSITIVE_TTL_MS,
  LIGHTER_CAPABILITY_REFRESH_MS,
  type ServerCapabilityAnswer,
} from "../../../vex-agent/sync/agentscan-report/lighter-capability.js";
import {
  readShareTokenRotationAvailability,
  resetShareTokenRotationAvailability,
  SHARE_TOKEN_ROTATION_CAPABILITY,
} from "../../../vex-agent/agentscan/share-token-rotation-capability.js";

const BASE_URL = "https://agentscan.example";
const INGEST = "I".repeat(43);

beforeEach(() => {
  resetShareTokenRotationAvailability();
});

function read(
  answer: ServerCapabilityAnswer,
  overrides: { baseUrl?: string; ingestToken?: string | null; nowMs?: number } = {},
): ReturnType<typeof readShareTokenRotationAvailability> {
  const fetchCapabilities = vi.fn(async () => answer);
  return readShareTokenRotationAvailability({
    baseUrl: overrides.baseUrl ?? BASE_URL,
    ingestToken: overrides.ingestToken ?? INGEST,
    nowMs: overrides.nowMs ?? 1_000_000,
    fetchCapabilities,
  }).then((availability) => {
    expect(fetchCapabilities).toHaveBeenCalledExactlyOnceWith({ ingestToken: overrides.ingestToken ?? INGEST });
    return availability;
  });
}

describe("readShareTokenRotationAvailability", () => {
  it("advertises the rotation capability literal", () => {
    expect(SHARE_TOKEN_ROTATION_CAPABILITY).toBe("share_token_rotation_v1");
  });

  it("maps a list containing the literal to available", async () => {
    await expect(read({ kind: "list", capabilities: ["lighter_v1", SHARE_TOKEN_ROTATION_CAPABILITY] }))
      .resolves.toEqual({ kind: "available" });
  });

  it("maps a list without the literal and an absent route to unavailable server", async () => {
    await expect(read({ kind: "list", capabilities: ["lighter_v1"] }))
      .resolves.toEqual({ kind: "unavailable", reason: "server" });
    resetShareTokenRotationAvailability();
    await expect(read({ kind: "absent" }))
      .resolves.toEqual({ kind: "unavailable", reason: "server" });
  });

  it("maps every unreachable reason to unknown with that reason", async () => {
    for (const reason of ["transport", "refused", "no_ingest_token"] as const) {
      resetShareTokenRotationAvailability();
      await expect(read({ kind: "unreachable", reason }))
        .resolves.toEqual({ kind: "unknown", reason });
    }
  });

  it("serves a positive answer from cache within 6 hours and refreshes after", async () => {
    const fetchCapabilities = vi.fn(async (): Promise<ServerCapabilityAnswer> => ({
      kind: "list",
      capabilities: [SHARE_TOKEN_ROTATION_CAPABILITY],
    }));
    const input = { baseUrl: BASE_URL, ingestToken: INGEST, fetchCapabilities };
    await expect(readShareTokenRotationAvailability({ ...input, nowMs: 0 }))
      .resolves.toEqual({ kind: "available" });
    await expect(
      readShareTokenRotationAvailability({ ...input, nowMs: LIGHTER_CAPABILITY_POSITIVE_TTL_MS - 1 }),
    ).resolves.toEqual({ kind: "available" });
    expect(fetchCapabilities).toHaveBeenCalledTimes(1);
    await expect(
      readShareTokenRotationAvailability({ ...input, nowMs: LIGHTER_CAPABILITY_POSITIVE_TTL_MS }),
    ).resolves.toEqual({ kind: "available" });
    expect(fetchCapabilities).toHaveBeenCalledTimes(2);
  });

  it("serves a negative or unknown answer from cache within 10 minutes and refreshes after", async () => {
    for (const answer of [
      { kind: "absent" },
      { kind: "unreachable", reason: "transport" },
    ] as const satisfies ReadonlyArray<ServerCapabilityAnswer>) {
      resetShareTokenRotationAvailability();
      const fetchCapabilities = vi.fn(async (): Promise<ServerCapabilityAnswer> => answer);
      const input = { baseUrl: BASE_URL, ingestToken: INGEST, fetchCapabilities };
      await readShareTokenRotationAvailability({ ...input, nowMs: 0 });
      await readShareTokenRotationAvailability({ ...input, nowMs: LIGHTER_CAPABILITY_REFRESH_MS - 1 });
      expect(fetchCapabilities).toHaveBeenCalledTimes(1);
      await readShareTokenRotationAvailability({ ...input, nowMs: LIGHTER_CAPABILITY_REFRESH_MS });
      expect(fetchCapabilities).toHaveBeenCalledTimes(2);
    }
  });

  it("does not share a cache entry between distinct base URLs", async () => {
    const fetchCapabilities = vi.fn(async (): Promise<ServerCapabilityAnswer> => ({
      kind: "list",
      capabilities: [SHARE_TOKEN_ROTATION_CAPABILITY],
    }));
    await readShareTokenRotationAvailability({
      baseUrl: "https://one.example",
      ingestToken: INGEST,
      nowMs: 0,
      fetchCapabilities,
    });
    await readShareTokenRotationAvailability({
      baseUrl: "https://two.example",
      ingestToken: INGEST,
      nowMs: 0,
      fetchCapabilities,
    });
    expect(fetchCapabilities).toHaveBeenCalledTimes(2);
  });
});
