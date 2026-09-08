import { describe, expect, it } from "vitest";
import { redact, redactArgs } from "../redact.js";

/**
 * Reproduce the production incident: a bundled CJS dependency installed an
 * `Error.prepareStackTrace` hook that throws (bare `__filename` in an ESM
 * chunk) and never restored the previous one, so EVERY later `.stack` read in
 * the main process throws. Runs `body` inside that poisoned window and always
 * restores the hook.
 */
function withPoisonedPrepareStackTrace(body: () => void): void {
  const original = Error.prepareStackTrace;
  Error.prepareStackTrace = () => {
    throw new ReferenceError("__filename is not defined");
  };
  try {
    body();
  } finally {
    Error.prepareStackTrace = original;
  }
}

describe("redact", () => {
  it.each([
    ["seeded", 5],
    ["tokens", 4],
    ["wallets", 4],
    ["droppedAddresses", 0],
    ["walletsWithMoneyInFlight", 0],
    ["tokenCount", 12],
    ["seedCount", 2],
  ])("preserves the numeric count %s", (key, value) => {
    expect(redact({ [key]: value })).toEqual({ [key]: value });
  });

  it.each(["password", "seed", "private_key", "api-key", "token", "authorization"])(
    "still redacts numeric credentials under %s", (key) => {
      expect(redact({ [key]: 123456 })).toEqual({ [key]: "[REDACTED]" });
    },
  );

  it("scrubs sensitive value shapes even under count-like keys", () => {
    const address = `0x${"a".repeat(40)}`;
    const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk";
    expect(redact({ seeded: address, tokens: [base58], wallets: { personal: "hidden" } })).toEqual({
      seeded: "[REDACTED]", tokens: "[REDACTED]", wallets: "[REDACTED]",
    });
    expect(redact({ reason: "timeout https://rpc.example/credential?key=hidden" })).toEqual({
      reason: "timeout [REDACTED]",
    });
  });

  it("redacts sensitive object keys regardless of value", () => {
    const input = {
      password: "hunter2",
      mnemonic: "abandon abandon abandon",
      privateKey: "0x" + "f".repeat(64),
      secret: { nested: "still hidden" },
      ok: "kept",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.mnemonic).toBe("[REDACTED]");
    expect(out.privateKey).toBe("[REDACTED]");
    expect(out.secret).toBe("[REDACTED]");
    expect(out.ok).toBe("kept");
  });

  it("scrubs inline secret patterns from string values", () => {
    const evmKey = "0x" + "a".repeat(64);
    const evmAddr = "0x" + "b".repeat(40);
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJ";
    const text = `key=${evmKey} addr=${evmAddr} jwt=${jwt}`;
    const out = redact({ message: text }) as { message: string };
    expect(out.message).not.toContain(evmKey);
    expect(out.message).not.toContain(evmAddr);
    expect(out.message).not.toContain(jwt);
    expect(out.message).toContain("[REDACTED]");
  });

  it("unwraps Errors to {name, message, stack} with scrubbed components", () => {
    const evmKey = "0x" + "a".repeat(64);
    const e = new Error(`leaked ${evmKey}`);
    const out = redact(e) as { name: string; message: string; stack?: string };
    expect(out.name).toBe("Error");
    expect(out.message).not.toContain(evmKey);
    expect(out.message).toContain("[REDACTED]");
  });

  it("survives a poisoned Error.prepareStackTrace instead of throwing", () => {
    withPoisonedPrepareStackTrace(() => {
      const err = new Error("handled failure");
      let out: unknown;
      expect(() => {
        out = redact(err);
      }).not.toThrow();
      const shaped = out as { name: string; message: string; stack?: string };
      expect(shaped.name).toBe("Error");
      expect(shaped.message).toBe("handled failure");
      expect(shaped.stack).toBe("<stack unavailable>");
    });
  });

  it("keeps the log.error path safe when .stack reads throw", () => {
    withPoisonedPrepareStackTrace(() => {
      const err = new Error("db connect failed");
      let out: unknown[] = [];
      expect(() => {
        out = redactArgs(["[startup]", err]);
      }).not.toThrow();
      expect(out[0]).toBe("[startup]");
      const shaped = out[1] as { name: string; message: string };
      expect(shaped.name).toBe("Error");
      expect(shaped.message).toBe("db connect failed");
    });
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", a };
    a.b = b;
    const out = redact(a) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect((out.b as Record<string, unknown>).name).toBe("b");
  });

  it("truncates very long strings", () => {
    const big = "x".repeat(10_000);
    const out = redact({ blob: big }) as { blob: string };
    expect(out.blob.length).toBeLessThan(big.length);
    expect(out.blob).toContain("[truncated");
  });

  it("preserves non-sensitive values verbatim", () => {
    const out = redact({
      n: 42,
      b: true,
      s: "hello",
      arr: [1, 2, 3],
      nested: { ok: "yes" },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      n: 42,
      b: true,
      s: "hello",
      arr: [1, 2, 3],
      nested: { ok: "yes" },
    });
  });
});
