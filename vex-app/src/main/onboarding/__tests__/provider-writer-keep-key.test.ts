/**
 * `writeProvider` on the keep-existing-key path (delta save).
 *
 * An ABSENT `apiKey` means the operator changed only the model/routing. The
 * vault entry must then be left completely alone — no read-then-rewrite, no
 * re-encryption of a working secret — while the non-secret `.env` selection is
 * written exactly as on the first-run path. `fieldsWritten` must not claim the
 * vault key it did not touch.
 *
 * New file: `provider-writer.test.ts` owns the rotation path and
 * `provider-writer-endpoint-tag.test.ts` owns the pin lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const sessionMocks = vi.hoisted(() => ({
  writeUnlockedSecrets: vi.fn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../secrets/session.js", () => ({
  writeUnlockedSecrets: sessionMocks.writeUnlockedSecrets,
}));

const { writeProvider } = await import("../provider-writer.js");
const { readDotenvFileValue } = await import("@vex-lib/dotenv.js");

let tmpDir = "";
let envFile = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-provider-keep-"));
  envFile = path.join(tmpDir, ".env");
  sessionMocks.writeUnlockedSecrets.mockReset();
  sessionMocks.writeUnlockedSecrets.mockReturnValue({
    ok: true,
    data: undefined,
  });
  delete process.env.OPENROUTER_ENDPOINT_TAG;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.OPENROUTER_ENDPOINT_TAG;
});

describe("writeProvider without an apiKey (keep the stored key)", () => {
  it("never touches the vault", async () => {
    const result = await writeProvider(
      { provider: "openrouter", model: "openai/gpt-5.2" },
      { envFile },
    );

    expect(result.ok).toBe(true);
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });

  it("writes the non-secret selection and reports only what it wrote", async () => {
    const result = await writeProvider(
      { provider: "openrouter", model: "openai/gpt-5.2" },
      { envFile },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "AGENT_MODEL",
        "AGENT_PROVIDER",
      ]);
    }
    expect(readDotenvFileValue("AGENT_MODEL", envFile)).toBe("openai/gpt-5.2");
    expect(readDotenvFileValue("AGENT_PROVIDER", envFile)).toBe("openrouter");
    // Still no plaintext key on disk, on either path.
    expect(readDotenvFileValue("OPENROUTER_API_KEY", envFile)).toBeNull();
  });

  it("keeps the endpoint-pin lifecycle: a pin is written, Auto erases it", async () => {
    const pinned = await writeProvider(
      {
        provider: "openrouter",
        model: "openai/gpt-5.2",
        endpointTag: "azure",
      },
      { envFile },
    );

    expect(pinned.ok).toBe(true);
    if (pinned.ok) {
      expect(pinned.data.fieldsWritten).toEqual([
        "AGENT_MODEL",
        "AGENT_PROVIDER",
        "OPENROUTER_ENDPOINT_TAG",
      ]);
    }
    expect(readDotenvFileValue("OPENROUTER_ENDPOINT_TAG", envFile)).toBe(
      "azure",
    );

    process.env.OPENROUTER_ENDPOINT_TAG = "azure";
    const auto = await writeProvider(
      { provider: "openrouter", model: "openai/gpt-5.2" },
      { envFile },
    );

    expect(auto.ok).toBe(true);
    expect(readDotenvFileValue("OPENROUTER_ENDPOINT_TAG", envFile)).toBeNull();
    // Deleted from the live process too — a file-only delete would keep
    // routing to the old endpoint for the rest of the session.
    expect(process.env.OPENROUTER_ENDPOINT_TAG).toBeUndefined();
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });
});
