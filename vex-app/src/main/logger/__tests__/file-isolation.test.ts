import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type logElectron from "electron-log/main.js";

import { log } from "../index.js";

const electronLog: typeof logElectron = createRequire(import.meta.url)("electron-log/main.js");

describe("unit-test file logging", () => {
  it("writes the real redacted output only inside its temporary log directory", () => {
    const secret = "synthetic-log-secret";
    log.error("unit-log-isolation", { token: secret });

    const filePath = electronLog.transports.file.getFile().toString();
    expect(path.dirname(filePath).startsWith(path.join(tmpdir(), "vex-unit-logs-"))).toBe(true);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("unit-log-isolation");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain(secret);
  });
});
