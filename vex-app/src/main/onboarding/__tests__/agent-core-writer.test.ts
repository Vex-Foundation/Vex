/**
 * Tests for agent-core-writer (M9 Step 5).
 *
 * Verifies the tri-state contract + effective-config validation:
 *  - Empty payload + valid existing → ok({fieldsWritten:[], cleared:[]}).
 *  - Empty payload + EXISTING broken state (manual .env edit:
 *    MAX_OUT > CONTEXT) → blocks Continue with cross-field error.
 *  - number → set in .env.
 *  - null → cleared from .env (key removed).
 *  - absent → no change to .env.
 *  - Cross-field on EFFECTIVE: existing CONTEXT=1000, submitted only
 *    maxOutputTokens=2000 → REJECTED.
 *  - Selective write: submitting AGENT_TEMPERATURE only does NOT
 *    touch other AGENT_* keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { writeAgentCoreConfig } = await import("../agent-core-writer.js");
const { readDotenvFileValue } = await import("@vex-lib/dotenv.js");

let tmpDir = "";
let envFile = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-agent-core-"));
  envFile = path.join(tmpDir, ".env");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeAgentCoreConfig", () => {
  it("empty submission with no existing env: validate-only success", async () => {
    const r = await writeAgentCoreConfig({}, { envFile });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.fieldsWritten).toEqual([]);
      expect(r.data.fieldsCleared).toEqual([]);
    }
    expect(existsSync(envFile)).toBe(false);
  });

  it("rejects empty submission when EXISTING .env has cross-field violation", async () => {
    // User manually edited .env into a broken state.
    await fs.writeFile(
      envFile,
      'AGENT_CONTEXT_LIMIT="1000"\nAGENT_MAX_OUTPUT_TOKENS="50000"\n',
      "utf8",
    );
    const r = await writeAgentCoreConfig({}, { envFile });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("validation.invalid_input");
      expect(r.error.details?.violation).toBe("max_output_exceeds_context");
    }
  });

  it("number → sets the key in .env", async () => {
    const r = await writeAgentCoreConfig({ contextLimit: 64_000 }, { envFile });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.fieldsWritten).toEqual(["AGENT_CONTEXT_LIMIT"]);
    expect(readDotenvFileValue("AGENT_CONTEXT_LIMIT", envFile)).toBe("64000");
  });

  it("null → REMOVES the key from .env", async () => {
    await fs.writeFile(envFile, 'AGENT_TEMPERATURE="0.7"\nKEEP="x"\n', "utf8");
    const r = await writeAgentCoreConfig({ temperature: null }, { envFile });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.fieldsCleared).toEqual(["AGENT_TEMPERATURE"]);
      expect(r.data.fieldsWritten).toEqual([]);
    }
    expect(readDotenvFileValue("AGENT_TEMPERATURE", envFile)).toBeNull();
    expect(readDotenvFileValue("KEEP", envFile)).toBe("x");
  });

  it("absent fields preserve existing .env values", async () => {
    await fs.writeFile(envFile, 'AGENT_TEMPERATURE="0.5"\n', "utf8");
    const r = await writeAgentCoreConfig({ contextLimit: 50_000 }, { envFile });
    expect(r.ok).toBe(true);
    expect(readDotenvFileValue("AGENT_TEMPERATURE", envFile)).toBe("0.5");
    expect(readDotenvFileValue("AGENT_CONTEXT_LIMIT", envFile)).toBe("50000");
  });

  it("rejects effective-config violation: existing context=1000, submit maxOut=2000", async () => {
    await fs.writeFile(envFile, 'AGENT_CONTEXT_LIMIT="1000"\n', "utf8");
    const r = await writeAgentCoreConfig({ maxOutputTokens: 2000 }, { envFile });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("validation.invalid_input");
      expect(r.error.details?.violation).toBe("max_output_exceeds_context");
    }
    // Nothing should have been written
    expect(readDotenvFileValue("AGENT_MAX_OUTPUT_TOKENS", envFile)).toBeNull();
  });

  it("accepts maxOutputTokens within the agent context limit", async () => {
    // AGENT max=20000 is within the agent context default (256000) → OK.
    const r = await writeAgentCoreConfig(
      { maxOutputTokens: 20_000 },
      { envFile },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.fieldsWritten).toEqual(["AGENT_MAX_OUTPUT_TOKENS"]);
  });

  it("selective write: submitting only temperature does not touch other keys", async () => {
    await fs.writeFile(
      envFile,
      'AGENT_CONTEXT_LIMIT="64000"\nAGENT_MAX_OUTPUT_TOKENS="8000"\n',
      "utf8",
    );
    const r = await writeAgentCoreConfig({ temperature: 0.5 }, { envFile });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.fieldsWritten).toEqual(["AGENT_TEMPERATURE"]);
    const raw = readFileSync(envFile, "utf8");
    expect(raw).toContain('AGENT_CONTEXT_LIMIT="64000"');
    expect(raw).toContain('AGENT_MAX_OUTPUT_TOKENS="8000"');
    expect(raw).toContain('AGENT_TEMPERATURE="0.5"');
  });

  it("literal 0 temperature is accepted and written", async () => {
    const r = await writeAgentCoreConfig({ temperature: 0 }, { envFile });
    expect(r.ok).toBe(true);
    expect(readDotenvFileValue("AGENT_TEMPERATURE", envFile)).toBe("0");
  });
});
