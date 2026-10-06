/** Reviewed non-emitting test topology, with inherited production checks pinned. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export function assertReviewedTestTypeConfig(config) {
  const reviewed = {
    extends: "./tsconfig.json",
    compilerOptions: {
      noEmit: true,
      declaration: false,
      declarationMap: false,
      rootDir: ".",
      paths: {
        "@tools/*": ["tools/*"],
        "@utils/*": ["utils/*"],
        "@config/*": ["config/*"],
        "@vex-agent/*": ["vex-agent/*"],
        "@shared/*": ["../vex-app/src/shared/*"],
        "@vex-lib/*": ["lib/*"],
      },
    },
    include: ["src/**/*"],
    exclude: ["node_modules", "dist"],
  };
  if (!isDeepStrictEqual(config, reviewed)) {
    throw new Error("test TypeScript config differs from the reviewed strict non-emitting topology; source scope, inherited checks and aliases must remain unchanged");
  }
}

export function assertHistoricalCompilerProtection(baseline, productionConfig, compilerVersion) {
  if (baseline?.schemaVersion !== 1 || typeof baseline.diagnostics !== "object" || baseline.diagnostics === null) {
    throw new Error("test type baseline has an unsupported shape");
  }
  if (baseline.tscVersion !== compilerVersion) {
    throw new Error(`TypeScript version changed: baseline ${baseline.tscVersion}, installed ${compilerVersion}; explicit toolchain review is required`);
  }
  const productionHash = createHash("sha256").update(productionConfig).digest("hex");
  if (baseline.extendsConfigSha256 !== productionHash) {
    throw new Error("production TypeScript config changed since the historical baseline; inherited strict checks require explicit review");
  }
}

export function assertTestTypeConfigContract(repositoryRoot, compilerVersion) {
  const config = JSON.parse(readFileSync(path.join(repositoryRoot, "tsconfig.test.json"), "utf8"));
  assertReviewedTestTypeConfig(config);
  const baseline = JSON.parse(readFileSync(path.join(repositoryRoot, "scripts/test-type-baseline.json"), "utf8"));
  const productionConfig = readFileSync(path.join(repositoryRoot, "tsconfig.json"));
  assertHistoricalCompilerProtection(baseline, productionConfig, compilerVersion);
}

export function assertZeroTestTypeDiagnostics(diagnostics) {
  if (diagnostics.length > 0) {
    throw new Error(`strict test TypeScript check failed with ${diagnostics.length} diagnostic(s); historical baseline and allowlist entries cannot admit errors\n${diagnostics.join("\n")}`);
  }
}
