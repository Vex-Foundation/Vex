/**
 * Types for `pg-connect-latency.mjs`, mirroring the precedent set by
 * `scripts/bridge-freshness.d.mts`: the script itself stays plain ESM so it
 * runs from a bare `node` on the owner's machine, and the declarations exist
 * so the suite under `src/main/studio/__tests__/` type-checks against it.
 */

export const DEFAULT_PG_PORT: number;
export const PG_HOST: string;
export const PG_DATABASE: string;
export const PG_USER: string;
export const PRODUCT_CONNECT_TIMEOUT_MS: number;
export const SLOW_CONNECT_MS: number;
export const MIN_RUNS: number;
export const MAX_RUNS: number;
export const PG_PASSWORD_RELATIVE_PATH: string;
export const COMPOSE_RELATIVE_PATH: string;

export interface ConfigDirInput {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
}

export function resolveConfigDir(input: ConfigDirInput): string;
export function pgPasswordPathFor(configDir: string): string;
export function composePathFor(configDir: string): string;
export function parsePublishedPgPort(composeYaml: string): number | null;

/** Where the port came from, so an artifact can name its own target. */
export type PgPortSource = "compose" | "default" | "--port";

export interface PgTarget {
  readonly configDir: string;
  readonly composePath: string;
  readonly passwordPath: string;
  readonly host: string;
  readonly port: number;
  readonly portSource: PgPortSource;
  readonly database: string;
  readonly user: string;
  /** Never printed and never written to an artifact. */
  readonly password: string;
}

export interface ResolvePgTargetOptions {
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly portOverride?: number | null;
  readonly readFile?: (file: string) => string;
  readonly fileExists?: (file: string) => boolean;
}

export function resolvePgTarget(options?: ResolvePgTargetOptions): PgTarget;

export function percentile(samples: readonly number[], p: number): number | null;

export interface LatencySummary {
  readonly count: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

export function summarize(samples: readonly number[]): LatencySummary;

export type VerdictClassification = "confirmed" | "implicated" | "not-implicated";

export interface Verdict {
  readonly classification: VerdictClassification;
  readonly slowMs: number;
  readonly connectTimeoutMs: number;
  readonly samplesAtOrOverSlow: number;
  readonly samplesAtOrOverTimeout: number;
  readonly total: number;
}

export function verdict(
  connectSamples: readonly number[],
  thresholds?: { readonly connectTimeoutMs?: number; readonly slowMs?: number },
): Verdict;

export interface ProbeOptions {
  readonly runs: number;
  readonly gapMs: number;
  readonly port: number | null;
  readonly label: string | null;
  readonly json: string | null;
}

export function parseArgs(argv: readonly string[]): ProbeOptions;

export interface LatencySample {
  readonly attempt: number;
  readonly connectMs: number;
  readonly queryMs: number | null;
  readonly endMs: number | null;
  readonly serverVersion: string | null;
}

export interface ProbeEnvironment {
  readonly timestamp: string;
  readonly platform: string;
  readonly osType: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly dockerVersion: string;
  readonly serverVersion: string;
}

export function renderReport(input: {
  readonly target: PgTarget & { readonly label: string | null };
  readonly samples: readonly LatencySample[];
  readonly summaries: Readonly<Record<string, LatencySummary>>;
  readonly decision: Verdict;
  readonly environment: ProbeEnvironment;
}): string;

export function measureOnce(
  Client: new (config: Record<string, unknown>) => {
    connect(): Promise<void>;
    query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
  },
  target: PgTarget,
  input: { readonly attempt: number; readonly collectServerVersion?: boolean },
): Promise<LatencySample>;

export function run(
  argv: readonly string[],
  deps: {
    readonly Client: unknown;
    readonly log?: (line: string) => void;
    readonly error?: (line: string) => void;
  },
): Promise<number>;
