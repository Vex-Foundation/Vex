import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";
import type logElectron from "electron-log/main.js";

// Configure the real CommonJS sink without caching a Vite import that would
// prevent an individual suite from supplying its own logger mock.
const electronLog: typeof logElectron = createRequire(import.meta.url)("electron-log/main.js");
const logDirectory = mkdtempSync(path.join(tmpdir(), "vex-unit-logs-"));
electronLog.transports.file.resolvePathFn = () => path.join(logDirectory, "main.log");

afterAll(() => {
  rmSync(logDirectory, { recursive: true, force: true });
});
