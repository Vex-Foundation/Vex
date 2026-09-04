/**
 * The pure parts of `scripts/probes/pg-connect-latency.mjs`, and the two
 * MIRRORS that instrument carries.
 *
 * The probe cannot import main-process TypeScript: it has to run from a bare
 * `node` on the owner's Windows machine against an installed Vex, with no
 * build step and no Electron. So it restates the CONFIG_DIR rules, the
 * `vex`/`vex`/127.0.0.1 triple, the default port, and the private
 * `CONNECT_TIMEOUT_MS` of `sessions/connection.ts`.
 *
 * A restated constant that nobody checks is how an instrument starts lying
 * about the thing it measures - the verdict thresholds are expressed against
 * the product ceiling, so a drift there moves the finish line silently. These
 * tests read the REAL owners and fail when they disagree. That is the whole
 * reason the mirror is allowed to exist.
 *
 * ## Placement
 *
 * This suite sits beside `bridge-freshness.test.ts` because vitest's `node`
 * project collects only under `src/main/**`, `src/preload/**`, `src/shared/**`
 * and `src/pty-host/**`, and that file is the established precedent for a
 * suite whose subject is a `scripts/*.mjs` module. The database directory
 * would be the topical home; it is another builder's exclusive area this
 * round.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PG_PORT as PROBE_DEFAULT_PG_PORT,
  MAX_RUNS,
  PG_DATABASE,
  PG_HOST,
  PG_USER,
  PRODUCT_CONNECT_TIMEOUT_MS,
  SLOW_CONNECT_MS,
  composePathFor,
  parseArgs,
  parsePublishedPgPort,
  percentile,
  pgPasswordPathFor,
  resolveConfigDir,
  resolvePgTarget,
  summarize,
  verdict,
} from "../../../../scripts/probes/pg-connect-latency.mjs";

import { DEFAULT_PG_PORT } from "../../../shared/local-service-ports.js";
import { resolveConfigDir as productResolveConfigDir } from "../../paths/config-dir.js";

const VEX_APP_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

describe("mirror drift", () => {
  it("restates the same default Postgres port the product ships", () => {
    expect(PROBE_DEFAULT_PG_PORT).toBe(DEFAULT_PG_PORT);
  });

  it("restates the connection triple db-config.ts hardcodes", () => {
    const source = readFileSync(
      path.join(VEX_APP_ROOT, "src", "main", "database", "db-config.ts"),
      "utf8",
    );
    expect(source).toContain(`const DEFAULT_HOST = "${PG_HOST}"`);
    expect(source).toContain(`const DEFAULT_DATABASE = "${PG_DATABASE}"`);
    expect(source).toContain(`const DEFAULT_USER = "${PG_USER}"`);
  });

  /**
   * `CONNECT_TIMEOUT_MS` is private to `sessions/connection.ts`, so the pin is
   * read out of the source text rather than imported. The regex accepts the
   * numeric separator the file uses AND a plain literal, so a reformat does not
   * fail the gate while a value change does.
   */
  it("restates CONNECT_TIMEOUT_MS from sessions/connection.ts", () => {
    const source = readFileSync(
      path.join(VEX_APP_ROOT, "src", "main", "database", "sessions", "connection.ts"),
      "utf8",
    );
    const match = /const CONNECT_TIMEOUT_MS = ([\d_]+);/.exec(source);
    const literal = match?.[1];
    expect(literal).toBeDefined();
    expect(Number(String(literal).replaceAll("_", ""))).toBe(PRODUCT_CONNECT_TIMEOUT_MS);
  });

  it("resolves the same config dir the product resolver does, per platform", () => {
    const cases = [
      { platform: "linux" as const, homedir: "/home/kuba", env: {} },
      { platform: "linux" as const, homedir: "/home/kuba", env: { XDG_CONFIG_HOME: "/xdg" } },
      { platform: "linux" as const, homedir: "/home/kuba", env: { XDG_CONFIG_HOME: "relative" } },
      { platform: "darwin" as const, homedir: "/Users/kuba", env: {} },
      { platform: "win32" as const, homedir: "C:\\Users\\kuba", env: {} },
      {
        platform: "win32" as const,
        homedir: "C:\\Users\\kuba",
        env: { APPDATA: "D:\\Roaming" },
      },
      { platform: "linux" as const, homedir: "/home/kuba", env: { VEX_CONFIG_DIR: "/tmp/vex-x" } },
      { platform: "linux" as const, homedir: "/home/kuba", env: { VEX_CONFIG_DIR: "" } },
    ];
    for (const input of cases) {
      expect(resolveConfigDir(input)).toBe(productResolveConfigDir(input));
    }
  });
});

describe("port resolution", () => {
  it("reads the published host port out of the compose the renderer emits", () => {
    const rendered = [
      "services:",
      "  db:",
      "    ports:",
      "      - target: 5432",
      '        published: "27432"',
      "        host_ip: 127.0.0.1",
      "        protocol: tcp",
      "        mode: host",
    ].join("\n");
    expect(parsePublishedPgPort(rendered)).toBe(27432);
  });

  it("reads a hand-edited short-form mapping too", () => {
    expect(parsePublishedPgPort('    ports:\n      - "127.0.0.1:55123:5432"\n')).toBe(55123);
  });

  it("returns null for a compose it does not recognise, rather than guessing", () => {
    expect(parsePublishedPgPort("services:\n  db:\n    image: postgres\n")).toBeNull();
  });

  it("never mistakes another service's published port for the database's", () => {
    const rendered = [
      "  embeddings-runtime:",
      "    ports:",
      "      - target: 8080",
      '        published: "27500"',
    ].join("\n");
    expect(parsePublishedPgPort(rendered)).toBeNull();
  });
});

describe("resolvePgTarget", () => {
  const configDir = "/tmp/vex-probe-config";
  const passwordPath = pgPasswordPathFor(configDir);
  const composePath = composePathFor(configDir);
  const env = { VEX_CONFIG_DIR: configDir };

  const deps = (files: Record<string, string>) => ({
    platform: "linux" as const,
    homedir: "/home/kuba",
    env,
    readFile: (file: string) => {
      const content = files[file];
      if (content === undefined) throw new Error(`unexpected read of ${file}`);
      return content;
    },
    fileExists: (file: string) => files[file] !== undefined,
  });

  it("prefers the compose port and records where it came from", () => {
    const target = resolvePgTarget(
      deps({
        [passwordPath]: "secret\n",
        [composePath]: '      - target: 5432\n        published: "27432"\n',
      }),
    );
    expect(target.port).toBe(27432);
    expect(target.portSource).toBe("compose");
    expect(target.host).toBe(PG_HOST);
    expect(target.database).toBe(PG_DATABASE);
    expect(target.user).toBe(PG_USER);
  });

  it("falls back to the default port when no compose has been rendered", () => {
    const target = resolvePgTarget(deps({ [passwordPath]: "secret" }));
    expect(target.port).toBe(DEFAULT_PG_PORT);
    expect(target.portSource).toBe("default");
  });

  it("lets --port win over a rendered compose", () => {
    const target = resolvePgTarget({
      ...deps({
        [passwordPath]: "secret",
        [composePath]: '      - target: 5432\n        published: "27432"\n',
      }),
      portOverride: 55123,
    });
    expect(target.port).toBe(55123);
    expect(target.portSource).toBe("--port");
  });

  it("refuses an install with no password file", () => {
    expect(() => resolvePgTarget(deps({}))).toThrow(/never rendered a compose stack/);
  });

  it("refuses an empty password file rather than attempting a doomed handshake", () => {
    expect(() => resolvePgTarget(deps({ [passwordPath]: "   \n" }))).toThrow(/is empty/);
  });

  it("trims the password file exactly as db-config.ts does", () => {
    const target = resolvePgTarget(deps({ [passwordPath]: "  s3cret\n" }));
    expect(target.password).toBe("s3cret");
  });
});

describe("statistics", () => {
  it("reports nearest-rank percentiles, so every value is a real sample", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBe(100);
    expect(percentile(samples, 1)).toBe(100);
  });

  it("does not depend on input order", () => {
    expect(percentile([90, 10, 50], 0.5)).toBe(50);
  });

  it("refuses a percentile outside (0, 1]", () => {
    expect(() => percentile([1], 0)).toThrow(/0 < p <= 1/);
    expect(() => percentile([1], 1.5)).toThrow(/0 < p <= 1/);
  });

  it("summarises an empty series as nulls rather than NaN", () => {
    expect(summarize([])).toEqual({
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
      mean: null,
    });
  });

  it("summarises min, p50, p95, max and mean", () => {
    const summary = summarize([4, 1, 3, 2]);
    expect(summary).toEqual({ count: 4, min: 1, p50: 2, p95: 4, max: 4, mean: 2.5 });
  });
});

describe("verdict", () => {
  it("calls a run confirmed when any connect reaches the product ceiling", () => {
    const decision = verdict([5, 12, PRODUCT_CONNECT_TIMEOUT_MS]);
    expect(decision.classification).toBe("confirmed");
    expect(decision.samplesAtOrOverTimeout).toBe(1);
    expect(decision.samplesAtOrOverSlow).toBe(1);
  });

  it("calls a run implicated when a connect is slow but never times out", () => {
    const decision = verdict([5, SLOW_CONNECT_MS, 1_200]);
    expect(decision.classification).toBe("implicated");
    expect(decision.samplesAtOrOverTimeout).toBe(0);
    expect(decision.samplesAtOrOverSlow).toBe(2);
  });

  it("clears connect latency only when every sample is under the slow threshold", () => {
    const decision = verdict([0.4, 0.9, SLOW_CONNECT_MS - 1]);
    expect(decision.classification).toBe("not-implicated");
    expect(decision.samplesAtOrOverSlow).toBe(0);
  });

  it("carries the thresholds it judged against into its own result", () => {
    const decision = verdict([1], { connectTimeoutMs: 500, slowMs: 100 });
    expect(decision.connectTimeoutMs).toBe(500);
    expect(decision.slowMs).toBe(100);
  });
});

describe("parseArgs", () => {
  it("defaults to a bounded, polite run", () => {
    expect(parseArgs([])).toEqual({ runs: 20, gapMs: 50, port: null, label: null, json: null });
  });

  it("accepts every supported flag", () => {
    expect(
      parseArgs(["--runs", "30", "--gap-ms", "0", "--port", "5777", "--label", "iso", "--json", "a.json"]),
    ).toEqual({ runs: 30, gapMs: 0, port: 5777, label: "iso", json: "a.json" });
  });

  it("refuses an unknown flag instead of silently measuring the default", () => {
    expect(() => parseArgs(["--run", "200"])).toThrow(/unknown flag --run/);
  });

  it("refuses a run count outside the bound", () => {
    expect(() => parseArgs(["--runs", "0"])).toThrow(/--runs expects an integer/);
    expect(() => parseArgs(["--runs", String(MAX_RUNS + 1)])).toThrow(/--runs expects an integer/);
  });

  it("refuses a flag with no value", () => {
    expect(() => parseArgs(["--json"])).toThrow(/--json expects a value/);
  });

  it("refuses a port that is not a TCP port", () => {
    expect(() => parseArgs(["--port", "70000"])).toThrow(/--port expects an integer/);
  });
});
