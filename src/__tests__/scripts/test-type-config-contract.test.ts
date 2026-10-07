import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const config: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "tsconfig.test.json"), "utf8"));
const productionConfig = readFileSync(path.join(repositoryRoot, "tsconfig.json"), "utf8");
const historicalBaseline: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "scripts/test-type-baseline.json"), "utf8"));
const reviewed = {
  extends: "./tsconfig.json",
  compilerOptions: {
    noEmit: true, declaration: false, declarationMap: false, rootDir: ".",
    paths: {
      "@tools/*": ["tools/*"], "@utils/*": ["utils/*"], "@config/*": ["config/*"],
      "@vex-agent/*": ["vex-agent/*"], "@shared/*": ["../vex-app/src/shared/*"], "@vex-lib/*": ["lib/*"],
    },
  },
  include: ["src/**/*"],
  exclude: ["node_modules", "dist"],
};

type Guard = "assertReviewedTestTypeConfig" | "assertHistoricalCompilerProtection" | "assertZeroTestTypeDiagnostics";
function runGuard(guard: Guard, args: readonly unknown[]) {
  return execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { readFileSync } from "node:fs"; import { ${guard} } from "./scripts/test-type-config-contract.mjs"; ${guard}(...JSON.parse(readFileSync(0, "utf8")));`],
    { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe", input: JSON.stringify(args) });
}
function withOptions(options: Record<string, unknown>) {
  return { ...reviewed, compilerOptions: { ...reviewed.compilerOptions, ...options } };
}

describe("reviewed test compiler topology", () => {
  it("accepts the actual repaired config and unchanged inherited production protection", () => {
    expect(() => runGuard("assertReviewedTestTypeConfig", [config])).not.toThrow();
    expect(() => runGuard("assertHistoricalCompilerProtection", [historicalBaseline, productionConfig, ts.version])).not.toThrow();
  });

  it.each([
    { strict: false }, { strictNullChecks: false }, { noImplicitAny: false }, { noCheck: true },
    { skipLibCheck: true }, { noEmit: false }, { declaration: true }, { declarationMap: true },
    { rootDir: "src" }, { types: [] }, { moduleResolution: "Bundler" },
  ])("rejects compiler override %j", options => {
    expect(() => runGuard("assertReviewedTestTypeConfig", [withOptions(options)])).toThrow("reviewed strict non-emitting topology");
  });

  it.each([
    { include: ["src/tools/**/*"] }, { exclude: ["node_modules", "dist", "src/__tests__"] },
    { files: [] }, { references: [] }, { extends: "./tsconfig.less-strict.json" },
  ])("rejects source-scope or inheritance changes %j", override => {
    expect(() => runGuard("assertReviewedTestTypeConfig", [{ ...reviewed, ...override }])).toThrow("reviewed strict non-emitting topology");
  });

  it.each(["@tools/*", "@utils/*", "@config/*", "@vex-agent/*", "@shared/*", "@vex-lib/*"])("rejects redirection of %s", alias => {
    const redirected = withOptions({ paths: { ...reviewed.compilerOptions.paths, [alias]: ["__tests__/stubs/*"] } });
    expect(() => runGuard("assertReviewedTestTypeConfig", [redirected])).toThrow("reviewed strict non-emitting topology");
  });

  it("rejects omission of aliases and unreviewed extra aliases", () => {
    expect(() => runGuard("assertReviewedTestTypeConfig", [withOptions({ paths: {} })])).toThrow();
    expect(() => runGuard("assertReviewedTestTypeConfig", [withOptions({ paths: { ...reviewed.compilerOptions.paths, "*": ["__tests__/stubs/*"] } })])).toThrow();
  });
});

describe("immutable production compiler protections", () => {
  it("accepts historical metadata larger than the Linux single-argument limit", () => {
    const metadata = { schemaVersion: 1, diagnostics: { "fixture.ts": ["historical diagnostic".repeat(16_384)] },
      tscVersion: ts.version, extendsConfigSha256: createHash("sha256").update(productionConfig).digest("hex") };
    const args = [metadata, productionConfig, ts.version];
    expect(Buffer.byteLength(JSON.stringify(args), "utf8")).toBeGreaterThan(128 * 1024);
    expect(() => runGuard("assertHistoricalCompilerProtection", args)).not.toThrow();
    expect(() => runGuard("assertHistoricalCompilerProtection", [metadata, productionConfig, "0.0.0"]))
      .toThrow("TypeScript version changed");
  });

  it("rejects a changed compiler version", () => {
    expect(() => runGuard("assertHistoricalCompilerProtection", [historicalBaseline, productionConfig, "0.0.0"])).toThrow("TypeScript version changed");
  });

  it("rejects production strictness weakening against its original hash", () => {
    const weakened = productionConfig.replace('"strict": true', '"strict": false');
    expect(weakened).not.toBe(productionConfig);
    expect(() => runGuard("assertHistoricalCompilerProtection", [historicalBaseline, weakened, ts.version])).toThrow("production TypeScript config changed");
  });

  it("rejects malformed historical metadata", () => {
    const metadata = { schemaVersion: 1, diagnostics: null, tscVersion: ts.version,
      extendsConfigSha256: createHash("sha256").update(productionConfig).digest("hex") };
    expect(() => runGuard("assertHistoricalCompilerProtection", [metadata, productionConfig, ts.version])).toThrow("unsupported shape");
  });
});

describe("zero-debt diagnostics", () => {
  it("accepts an empty compiler result", () => {
    expect(() => runGuard("assertZeroTestTypeDiagnostics", [[]])).not.toThrow();
  });

  it("rejects every compiler diagnostic without consulting historical allowances", () => {
    expect(() => runGuard("assertZeroTestTypeDiagnostics", [["TS2345: invalid fixture", "TS2741: missing required field"]]))
      .toThrow("failed with 2 diagnostic(s); historical baseline and allowlist entries cannot admit errors");
  });

  it("rejects a recoverable no-input configuration instead of declaring an empty program successful", () => {
    const emptyRepository = mkdtempSync(path.join(tmpdir(), "vex-test-types-no-input-"));
    try {
      mkdirSync(path.join(emptyRepository, "scripts"));
      for (const file of ["tsconfig.json", "tsconfig.test.json", "scripts/test-type-baseline.json",
        "scripts/check-test-type-baseline.mjs", "scripts/test-type-config-contract.mjs"]) {
        writeFileSync(path.join(emptyRepository, file), readFileSync(path.join(repositoryRoot, file)));
      }
      symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(emptyRepository, "node_modules"), "dir");
      expect(() => execFileSync(process.execPath, [path.join(emptyRepository, "scripts/check-test-type-baseline.mjs")],
        { cwd: emptyRepository, encoding: "utf8", stdio: "pipe" })).toThrow("TS18003");
    } finally {
      rmSync(emptyRepository, { recursive: true, force: true });
    }
  });
});
