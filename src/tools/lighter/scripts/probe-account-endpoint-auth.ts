/**
 * Classifies which Lighter account endpoints actually require a read-only auth
 * token, per environment, by asking the live provider instead of inferring the
 * answer from documentation.
 *
 * Live evidence is required because Lighter's auth behaviour is not uniform:
 * during Milestone 4 the same read-only token was accepted for account trade
 * history and rejected with `401 invalid auth` on `/api/v1/tokens`. A tool
 * surface built on the docs alone would either gate public reads that keyless
 * users are entitled to, or advertise reads the read-only lane cannot reach.
 *
 * Each candidate endpoint is called twice per environment:
 *
 *   1. WITHOUT an `Authorization` header. A success here proves the endpoint is
 *      PUBLIC, and a public endpoint must never be credential-gated.
 *   2. WITH the environment's read-only token, when one is configured. This
 *      separates AUTH_REQUIRED (rejected bare, accepted with the token) from
 *      FORBIDDEN (rejected even with a valid read-only token, meaning it wants
 *      a stronger credential than the read-only lane Vex deliberately chose).
 *
 * READ-ONLY. This script never signs, never mutates, never places or cancels an
 * order, and holds no key material of its own. It reads tokens only from the
 * process environment, sends them only as an `Authorization` header to the
 * pinned Lighter base URL for that environment, and never prints, logs, or
 * writes a token value. Provider bodies are truncated before display so an
 * error payload cannot echo a credential into the terminal or a transcript.
 *
 * Run the public-only pass with no configuration:
 *
 *     pnpm run lighter:probe:auth:public
 *
 * Run the full matrix with real read-only tokens present in the environment:
 *
 *     LIGHTER_CORE_READ_ONLY_AUTH_TOKEN=... \
 *     LIGHTER_RHC_READ_ONLY_AUTH_TOKEN=... pnpm run lighter:probe:auth
 *
 * The resulting matrix is recorded in `src/tools/lighter/Lighter.md` and decides
 * the Milestone 5 tool surface.
 */

import {
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENVIRONMENTS,
  LIGHTER_ENDPOINTS,
  type LighterEnvironment,
} from "../constants.js";
import { lighterReadOnlyAuthTokenEnvKey } from "../credentials.js";
import { parseLighterReadOnlyAuthToken } from "../auth-token.js";

/** Milliseconds between requests. Public Lighter REST is rate limited. */
const REQUEST_SPACING_MS = 350;
const REQUEST_TIMEOUT_MS = 15_000;
/** Provider bodies are only ever shown truncated, never in full. */
const BODY_PREVIEW_CHARS = 160;
const MODES = ["full", "public-only"] as const;
type ProbeMode = (typeof MODES)[number];

/**
 * Account index used for the bare pass, where no token supplies one. It only
 * has to be a plausible live index: the probe is reading the ACCESS decision
 * (200 vs 401/403), not the account contents.
 */
const FALLBACK_ACCOUNT_INDEX = 1;

interface Candidate {
  readonly tool: string;
  readonly path: string;
  readonly query: (accountIndex: number) => Record<string, string>;
  readonly note?: string;
}

const CANDIDATES: readonly Candidate[] = [
  {
    tool: "lighter.account.get / lighter.positions",
    path: LIGHTER_ENDPOINT_PATHS.account,
    query: (accountIndex) => ({ by: "index", value: String(accountIndex) }),
    note: "positions arrive inline on the account payload",
  },
  {
    tool: "lighter.accounts.byAddress",
    path: "/api/v1/accountsByL1Address",
    query: () => ({ l1_address: "0x0000000000000000000000000000000000000000" }),
    note: "zero address is a probe subject only; a 4xx that is not 401/403 still proves reachability",
  },
  {
    tool: "lighter.openOrders",
    path: LIGHTER_ENDPOINT_PATHS.accountActiveOrders,
    query: (accountIndex) => ({ account_index: String(accountIndex), market_id: "0" }),
  },
  {
    tool: "lighter.orderHistory",
    path: LIGHTER_ENDPOINT_PATHS.accountInactiveOrders,
    query: (accountIndex) => ({ account_index: String(accountIndex), limit: "1" }),
  },
  {
    tool: "lighter.trades",
    path: LIGHTER_ENDPOINT_PATHS.trades,
    query: (accountIndex) => ({ account_index: String(accountIndex), limit: "1", sort_by: "timestamp" }),
  },
  {
    tool: "lighter.apiKeys.inspect (deferred)",
    path: "/api/v1/apikeys",
    query: (accountIndex) => ({ account_index: String(accountIndex), api_key_index: "255" }),
    note: "deferred out of Milestone 5; probed only to confirm its credential class",
  },
  {
    tool: "(not a tool) read-only token listing",
    path: LIGHTER_ENDPOINT_PATHS.tokens,
    query: (accountIndex) => ({ account_index: String(accountIndex) }),
    note: "known rejection with a read-only token during Milestone 4; probed with account_index as a regression check",
  },
];

type Access =
  | "PUBLIC"
  | "AUTH_REQUIRED"
  | "AUTH_REQUIRED_UNCONFIRMED"
  | "FORBIDDEN"
  | "UNREACHABLE"
  | "UNKNOWN";

interface ProbeResult {
  readonly environment: LighterEnvironment;
  readonly candidate: Candidate;
  readonly bare: Attempt;
  readonly authed: Attempt | null;
  readonly access: Access;
}

interface Attempt {
  readonly ok: boolean;
  readonly status: number | null;
  readonly preview: string;
  readonly transportError: string | null;
}

async function main(): Promise<void> {
  const mode = readMode(process.argv.slice(2));
  console.log("Lighter account endpoint auth classification");
  console.log("Live provider probe. Read-only. No mocks, fixtures, or simulated responses.\n");
  console.log(`Mode: ${mode}\n`);

  const tokens = readConfiguredTokens();
  const results: ProbeResult[] = [];

  for (const environment of LIGHTER_ENVIRONMENTS) {
    const token = tokens.get(environment) ?? null;
    const accountIndex = token?.accountIndex ?? FALLBACK_ACCOUNT_INDEX;
    console.log(
      `${environment}: ${LIGHTER_ENDPOINTS[environment].restBaseUrl}` +
        ` | token ${token ? "configured" : "absent"}` +
        ` | account index ${accountIndex}${token ? " (from credential)" : " (fallback probe subject)"}`,
    );

    for (const candidate of CANDIDATES) {
      const bare = await attempt(environment, candidate, accountIndex, null);
      const authed = mode === "full" && token
        ? await attempt(environment, candidate, accountIndex, token.value)
        : null;
      results.push({ environment, candidate, bare, authed, access: classify(bare, authed) });
    }
    console.log("");
  }

  const complete = report(results, tokens, mode);
  if (!complete) process.exitCode = 1;
}

function readMode(args: readonly string[]): ProbeMode {
  const raw = args[0] ?? "--full";
  if (raw === "--full") return "full";
  if (raw === "--public-only") return "public-only";
  throw new Error(`Unknown probe mode ${raw}. Use --full or --public-only.`);
}

function classify(bare: Attempt, authed: Attempt | null): Access {
  if (bare.transportError && (authed === null || authed.transportError)) return "UNREACHABLE";
  if (bare.ok) return "PUBLIC";
  if (!isAuthRejection(bare)) {
    // Rejected for a reason that is not about credentials — bad params, unknown
    // account, no such route. Not an auth signal either way.
    return authed?.ok ? "AUTH_REQUIRED" : "UNKNOWN";
  }
  // The bare call was refused for missing credentials. Whether the READ-ONLY
  // lane can actually reach it is a separate question, and only a live token
  // answers it.
  if (authed === null) return "AUTH_REQUIRED_UNCONFIRMED";
  if (authed.ok) return "AUTH_REQUIRED";
  return isAuthRejection(authed) ? "FORBIDDEN" : "UNKNOWN";
}

/**
 * Lighter does not signal missing credentials with HTTP status alone. Live Core
 * and RHC both answer a credential-less account request with `400` and a body
 * of `{"code":20001,"message":"invalid param : auth query param and
 * Authorization header are empty"}`, so a status-only check reads that as a
 * malformed request and silently misclassifies an auth-gated endpoint.
 */
function isAuthRejection(attempt: Attempt): boolean {
  if (attempt.status === 401 || attempt.status === 403) return true;
  if (attempt.status !== 400) return false;
  const body = attempt.preview.toLowerCase();
  return body.includes("auth") && (body.includes("empty") || body.includes("invalid auth"));
}

async function attempt(
  environment: LighterEnvironment,
  candidate: Candidate,
  accountIndex: number,
  token: string | null,
): Promise<Attempt> {
  await sleep(REQUEST_SPACING_MS);

  const url = new URL(candidate.path, LIGHTER_ENDPOINTS[environment].restBaseUrl);
  for (const [key, value] of Object.entries(candidate.query(accountIndex))) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      preview: preview(body),
      transportError: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      preview: "",
      transportError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collapses a provider body to a short single line. Provider error payloads are
 * never trusted to be free of echoed request material, so nothing longer than
 * `BODY_PREVIEW_CHARS` ever reaches the terminal.
 */
function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > BODY_PREVIEW_CHARS ? `${flat.slice(0, BODY_PREVIEW_CHARS)}…` : flat;
}

interface ConfiguredToken {
  readonly value: string;
  readonly accountIndex: number;
}

/**
 * Reads whichever read-only tokens are configured. A missing token is normal —
 * the bare pass still classifies public endpoints. An unparseable or expired
 * token is reported and skipped rather than sent, so the probe never presents a
 * dead credential's rejection as evidence about an endpoint.
 */
function readConfiguredTokens(): Map<LighterEnvironment, ConfiguredToken> {
  const tokens = new Map<LighterEnvironment, ConfiguredToken>();
  for (const environment of LIGHTER_ENVIRONMENTS) {
    const envKey = lighterReadOnlyAuthTokenEnvKey(environment);
    const raw = process.env[envKey]?.trim();
    if (!raw) {
      console.log(`${envKey} is not set. ${environment} runs the bare pass only.`);
      continue;
    }
    try {
      const metadata = parseLighterReadOnlyAuthToken(environment, raw);
      if (metadata.expired) {
        console.log(`${envKey} is expired (${metadata.expiresAt}). ${environment} runs the bare pass only.`);
        continue;
      }
      if (metadata.expiresSoon) {
        console.log(`${envKey} expires soon (${metadata.expiresAt}).`);
      }
      tokens.set(environment, { value: raw, accountIndex: metadata.accountIndex });
    } catch (error) {
      console.log(
        `${envKey} did not parse as a read-only token: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return tokens;
}

function report(
  results: readonly ProbeResult[],
  tokens: Map<LighterEnvironment, ConfiguredToken>,
  mode: ProbeMode,
): boolean {
  console.log("| Environment | Tool | Endpoint | Bare | With token | Access |");
  console.log("|---|---|---|---|---|---|");
  for (const result of results) {
    console.log(
      `| ${result.environment} | ${result.candidate.tool} | \`${result.candidate.path}\` |` +
        ` ${describe(result.bare)} | ${result.authed ? describe(result.authed) : "not run"} |` +
        ` ${result.access} |`,
    );
  }

  console.log("\nDetail:");
  for (const result of results) {
    const lines = [`${result.environment} ${result.candidate.path} -> ${result.access}`];
    if (result.candidate.note) lines.push(`  note: ${result.candidate.note}`);
    if (result.bare.preview) lines.push(`  bare: ${result.bare.preview}`);
    if (result.bare.transportError) lines.push(`  bare transport error: ${result.bare.transportError}`);
    if (result.authed?.preview) lines.push(`  authed: ${result.authed.preview}`);
    if (result.authed?.transportError) {
      lines.push(`  authed transport error: ${result.authed.transportError}`);
    }
    console.log(lines.join("\n"));
  }

  const unknown = results.filter(
    (result) => result.access === "UNKNOWN" || result.access === "AUTH_REQUIRED_UNCONFIRMED",
  );
  const missing = mode === "full"
    ? LIGHTER_ENVIRONMENTS.filter((environment) => !tokens.has(environment))
    : [];
  console.log("");
  if (mode === "public-only") {
    console.log(
      "Public-only matrix complete. This proves public classifications only; it does not prove read-only token reachability.",
    );
    return true;
  }
  if (missing.length > 0) {
    console.log(
      `INCOMPLETE MATRIX. No read-only token for: ${missing.join(", ")}.` +
        " PUBLIC classifications are final, but AUTH_REQUIRED and FORBIDDEN cannot be" +
        " separated without a live token. Do not record this run as the Milestone 5 matrix.",
    );
    return false;
  } else if (unknown.length > 0) {
    console.log(`${unknown.length} endpoint(s) classified UNKNOWN. Resolve before recording the matrix.`);
    return false;
  } else {
    console.log("Matrix complete for both environments.");
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(attempt: Attempt): string {
  if (attempt.transportError) return "transport error";
  return `${attempt.status ?? "?"}${attempt.ok ? " ok" : ""}`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
