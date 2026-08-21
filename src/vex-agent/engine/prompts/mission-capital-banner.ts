/**
 * `# Mission Capital` turn-state banner - the one place a mission run reads what
 * its wallets were worth when the run started, what they are worth now, and the
 * change between the two.
 *
 * WHY IT EXISTS. On 2026-08-10 a live mission recomputed "deployed capital vs
 * target" by hand every turn, disagreed with itself across turns, and counted
 * coins the wallet already held as progress. The frozen figure now exists
 * (`engine/mission/baseline.ts`); this banner is how the agent actually sees it,
 * every turn, without reconstructing it from prose.
 *
 * TURN-STATE, NOT STATIC. The "now" half is volatile by definition, so the whole
 * section lives in `turnLayers` and never in the cached static prefix. The
 * frozen half rides along with it: a stale static baseline paired with a fresh
 * turn-state "now" would be the worst possible pairing, and the turn layer is
 * never cached, so splitting them would save nothing.
 *
 * FROZEN SCOPE. The "now" read is measured over `baseline.scope.addresses`
 * VERBATIM - never over the session's current wallet selection. Comparing a
 * different wallet set against the frozen start would silently change the
 * denominator mid-run and turn a wallet swap into a fabricated gain.
 *
 * FAIL-SOFT, BUT NEVER SILENT. A failed or slow "now" read does not drop the
 * banner: the start half still renders and the missing half is named out loud,
 * because an agent that knows its start value is better off than one with no
 * section at all. Only an unusable baseline yields "" (omit).
 *
 * NUMERIC AND TEXT TRUST BOUNDARY. This text lands in the SYSTEM PROMPT. Every
 * USD figure is bounds-checked before formatting, every raw amount must be
 * digits, and `assetSymbol` - the one model-written string in the baseline - is
 * charset-checked and replaced with a neutral phrase when it is not a plain
 * symbol. Nothing upstream-shaped passes through verbatim.
 */

import { getPortfolioValuation, type PortfolioValuation } from "@vex-agent/db/repos/balances.js";
import { formatRawAmount } from "@vex-agent/tools/protocols/amount-display.js";

import type { MissionBaseline, MissionBaselineReason } from "../mission/baseline.js";

/** Portfolio totals beyond this are not a portfolio; they are a corrupt row. */
const MAX_USD_AMOUNT = 1e15;
/** `contract-hash` bounds an accepted amount at 80 chars; the display agrees. */
const MAX_AMOUNT_RAW_CHARS = 80;
const AMOUNT_RAW_PATTERN = /^\d+$/;
/** The same bounded charset the declaration is normalized to before it is hashed. */
const ASSET_SYMBOL_PATTERN = /^[A-Za-z0-9_.$-]{1,32}$/;
/** Timestamps are rendered verbatim, so they must look like timestamps. */
const TIMESTAMP_PATTERN = /^[0-9T:.\-+Z ]{4,40}$/;

const NEUTRAL_ASSET_NAME = "the declared asset";

/**
 * Plain-words phrasing for a reason that can leave a run with NO baseline. The
 * qualifying reasons (`stale_projection`, `no_usd_prices`,
 * `deployed_capital_decimals_mismatch`) render as caveat lines beside a figure
 * instead, so they are not in this map.
 */
const ABSENT_REASON_PHRASING: Partial<Record<MissionBaselineReason, string>> = {
  no_allowed_wallets: "the mission contract listed no wallet this runtime could value",
  wallets_not_in_inventory: "none of the mission's allowed wallets matched a wallet installed here",
  no_projection_rows: "the balance projections held no rows for the mission wallets when the run started",
  no_usd_prices: "no token held by the mission wallets had a USD price when the run started",
  valuation_failed: "the balance projection read failed when the run started",
  valuation_timed_out: "the balance projection read did not finish inside its time budget when the run started",
};

const FALLBACK_REASON_PHRASING = "the balance projection read did not produce a usable figure when the run started";

export interface MissionCapitalBannerInput {
  readonly baseline: MissionBaseline | null;
  /** Measured over `baseline.scope.addresses`. `null` means the read did not return. */
  readonly now: PortfolioValuation | null;
}

// ── Pure renderer ───────────────────────────────────────────────────

/** Render the section. Returns "" (omit) when there is no baseline to speak of. */
export function renderMissionCapitalBanner(input: MissionCapitalBannerInput): string {
  const { baseline } = input;
  if (baseline === null) return "";
  if (baseline.portfolio === null) return renderAbsent(baseline);
  return renderRecorded(baseline, baseline.portfolio, input.now);
}

function renderAbsent(baseline: MissionBaseline): string {
  return [
    "# Mission Capital",
    "",
    `No start baseline was recorded for this run. Reason: ${phraseAbsentReason(baseline.reasons)}.`,
    "",
    "Change since start cannot be computed, and you must not invent a start value. Say plainly that the start value is unknown, and measure what you can from `WalletBalances` (live balances now) and `AgentScan view=\"transactions\"` (what actually executed).",
  ].join("\n");
}

function phraseAbsentReason(reasons: readonly MissionBaselineReason[]): string {
  for (const reason of reasons) {
    const phrasing = ABSENT_REASON_PHRASING[reason];
    if (phrasing !== undefined) return phrasing;
  }
  return FALLBACK_REASON_PHRASING;
}

function renderRecorded(
  baseline: MissionBaseline,
  start: PortfolioValuation,
  now: PortfolioValuation | null,
): string {
  const lines: string[] = [
    "# Mission Capital",
    "",
    "Start baseline, frozen when this run started. Source: local balance projections (refreshed by the balance sync, not a live RPC read). Every USD figure is an ESTIMATE.",
  ];

  const startUsd = boundedUsd(start.totalUsdEstimate);
  const nowUsd = now === null ? null : boundedUsd(now.totalUsdEstimate);

  if (startUsd !== null) {
    const pricedAt = safeTimestamp(start.newestSyncedAt);
    const walletCount = baseline.scope.addresses.length;
    lines.push(
      `- Portfolio at start: ${formatUsd(startUsd)} across ${walletCount} wallet(s)`
      + `${pricedAt === null ? "" : `, priced ${pricedAt}`}.`,
    );
  }
  if (nowUsd !== null) lines.push(`- Portfolio now: ${formatUsd(nowUsd)}.`);
  if (startUsd !== null && nowUsd !== null) {
    lines.push(`- Change since start: ${formatSignedUsd(nowUsd - startUsd)}.`);
  }

  pushDeployedCapitalLines(lines, baseline);
  pushCaveatLines(lines, baseline, start, now);

  lines.push("");
  lines.push(
    "These are the numbers to use. Do not recompute them from the transcript, and do not count a balance that existed before the run as progress. `AgentScan view=\"mission_baseline\"` returns the same figures with more detail. For live per-token balances call `WalletBalances`; for what actually executed call `AgentScan view=\"transactions\"`.",
  );
  return lines.join("\n");
}

function pushDeployedCapitalLines(lines: string[], baseline: MissionBaseline): void {
  const declared = baseline.deployedCapitalAtStart;
  if (declared === null) return;
  if (!isSafeAmountRaw(declared.declaredAmountRaw)) return;
  if (!isSafeDecimals(declared.declaredDecimals)) return;
  if (!Number.isSafeInteger(declared.chainId) || declared.chainId < 1) return;

  const symbol = safeAssetSymbol(declared.assetSymbol);
  const declaredHuman = formatRawAmount(declared.declaredAmountRaw, declared.declaredDecimals);
  const rawClause = `raw ${declared.declaredAmountRaw} at ${declared.declaredDecimals} decimals`;
  lines.push(
    declaredHuman === null
      ? `- Declared deployed capital: ${symbol}, ${rawClause}, on chain ${declared.chainId}.`
      : `- Declared deployed capital: ${declaredHuman} ${symbol} (${rawClause}) on chain ${declared.chainId}.`,
  );

  const { heldAmountRaw, heldDecimals } = declared;
  if (heldAmountRaw === null || heldDecimals === null) return;
  if (!isSafeAmountRaw(heldAmountRaw) || !isSafeDecimals(heldDecimals)) return;
  const heldHuman = formatRawAmount(heldAmountRaw, heldDecimals);
  const heldRawClause = `raw ${heldAmountRaw} at ${heldDecimals} decimals`;
  lines.push(
    heldHuman === null
      ? `- ${symbol} held at start: ${heldRawClause}.`
      : `- ${symbol} held at start: ${heldHuman} (${heldRawClause}).`,
  );
}

function pushCaveatLines(
  lines: string[],
  baseline: MissionBaseline,
  start: PortfolioValuation,
  now: PortfolioValuation | null,
): void {
  const startUnpriced = boundedCount(start.unpricedRowCount);
  if (startUnpriced > 0) {
    lines.push(
      `- ${startUnpriced} ${startUnpriced === 1 ? "token had" : "tokens had"} no USD price at start and`
      + ` ${startUnpriced === 1 ? "is" : "are"} NOT counted in the start figure.`,
    );
  }
  const nowUnpriced = now === null ? 0 : boundedCount(now.unpricedRowCount);
  if (nowUnpriced > 0) {
    lines.push(
      `- ${nowUnpriced} ${nowUnpriced === 1 ? "token has" : "tokens have"} no USD price now and`
      + ` ${nowUnpriced === 1 ? "is" : "are"} NOT counted in "Portfolio now".`,
    );
  }
  if (baseline.reasons.includes("stale_projection")) {
    lines.push(
      "- Freshness caveat: the projections behind the start figure were last refreshed more than 15 minutes before the run started, so it may miss recent movement.",
    );
  }
  if (baseline.reasons.includes("deployed_capital_decimals_mismatch")) {
    lines.push(
      "- The decimals declared for the deployed-capital asset did not match the decimals recorded for it, so the held amount is left out rather than rescaled.",
    );
  }
  if (now === null) {
    lines.push(
      "- Portfolio now is unavailable this turn: the balance projection read did not return. Change since start cannot be shown.",
    );
  }
}

// ── Async loader (fail-soft) ────────────────────────────────────────

/**
 * Hard budget for the "now" read. A slow projection read must not hold a turn:
 * past the budget the banner renders its frozen half and says the current value
 * is unavailable, which is strictly more useful than omitting the section.
 */
const NOW_READ_BUDGET_MS = 1_500;

/**
 * SERVER-side bound for the "now" read, just inside the caller budget above.
 * The budget race abandons the WAIT only: without this, an abandoned read keeps
 * running and keeps holding one of the pool's connections, every turn.
 */
const NOW_READ_STATEMENT_TIMEOUT_MS = 1_200;

export interface MissionCapitalBannerDeps {
  /** Reads the CURRENT value of the baseline's frozen wallet set. */
  readNow: (addresses: string[]) => Promise<PortfolioValuation>;
}

/**
 * Build the section for this turn. NEVER THROWS: any failure yields "" (omit),
 * and a failing "now" read degrades to the start half plus a named gap.
 */
export async function buildMissionCapitalBanner(
  baseline: MissionBaseline | null,
  deps: MissionCapitalBannerDeps = {
    readNow: (addresses) => getPortfolioValuation(addresses, NOW_READ_STATEMENT_TIMEOUT_MS),
  },
): Promise<string> {
  try {
    if (baseline === null) return "";
    // An absent baseline has no start figure to compare against, so a "now"
    // read would only produce a number with nothing to mean.
    if (baseline.portfolio === null) return renderMissionCapitalBanner({ baseline, now: null });
    const now = await readNowWithBudget(deps, baseline.scope.addresses);
    return renderMissionCapitalBanner({ baseline, now });
  } catch {
    return "";
  }
}

/** Resolve to `null` when the read fails or exceeds the budget. Never rejects. */
async function readNowWithBudget(
  deps: MissionCapitalBannerDeps,
  addresses: readonly string[],
): Promise<PortfolioValuation | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NOW_READ_BUDGET_MS);
    // Do not keep the process alive for a prompt-banner timer.
    timer.unref?.();
  });
  try {
    return await Promise.race([deps.readNow([...addresses]), timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── Bounds and formatting (validated values ONLY) ───────────────────

function boundedUsd(value: number): number | null {
  return Number.isFinite(value) && Math.abs(value) < MAX_USD_AMOUNT ? value : null;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isSafeAmountRaw(raw: string): boolean {
  return raw.length > 0 && raw.length <= MAX_AMOUNT_RAW_CHARS && AMOUNT_RAW_PATTERN.test(raw);
}

function isSafeDecimals(decimals: number): boolean {
  return Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36;
}

/** A symbol that is not a plain symbol is model-written text; it is not echoed. */
function safeAssetSymbol(symbol: string): string {
  return ASSET_SYMBOL_PATTERN.test(symbol) ? symbol : NEUTRAL_ASSET_NAME;
}

function safeTimestamp(value: string | null): string | null {
  if (value === null) return null;
  return TIMESTAMP_PATTERN.test(value) ? value : null;
}

function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatSignedUsd(value: number): string {
  // A rounded-to-zero change must not print a misleading sign.
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "$0.00";
  return `${rounded > 0 ? "+" : ""}${formatUsd(rounded)}`;
}
