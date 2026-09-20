import { useEffect, type JSX } from "react";
import { IconArrowUpRight } from "../../../components/icons/index.js";
import {
  useLighterTradingAccount,
  useLighterTradingMarkets,
  useLighterTradingSnapshot,
} from "../../../lib/api/lighter-trading.js";
import { useSessionsList } from "../../../lib/api/sessions.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { SessionPanel } from "../SessionPanel.js";
import {
  deskChartScopeKey,
  deskQuickPrompts,
  deskScopeLabel,
  deskScopeTag,
  deskStarterPrompts,
  type DeskContextScope,
} from "./desk-context.js";
import { useDeskScopeStore } from "./desk-scope.js";
import { marketSectionFor } from "./market-classification.js";
import { publishDeskSend } from "./desk-send-intent.js";
import { latestDeskSession } from "./desk-session.js";

/**
 * The BOOK-column rail in Lighter mode: the active desk session, or the
 * starter prompts that open one scoped to the market on the desk.
 */
export function LighterChatRail(): JSX.Element {
  const activeSessionId = useUiStore((state) => state.activeSessionId);
  const setActiveSessionId = useUiStore((state) => state.setActiveSessionId);
  const openCreateSession = useUiStore((state) => state.openCreateSession);
  const sessionsQuery = useSessionsList();
  // The desk resumes its latest conversation rather than opening on the
  // starters every time. Only an EMPTY selection is filled in: a session that
  // was just created is active before the list has refetched, and resetting
  // it against the stale list would drop the operator out of it.
  const latestSession = sessionsQuery.data?.ok === true ? latestDeskSession(sessionsQuery.data.data) : null;
  useEffect(() => {
    if (activeSessionId === null && latestSession !== null) setActiveSessionId(latestSession.id);
  }, [activeSessionId, latestSession, setActiveSessionId]);
  const { environment, marketId, resolution } = useLighterAnalysisStore((state) => state.desk);
  const marketsQuery = useLighterTradingMarkets(environment, true);
  const marketList = marketsQuery.data?.ok === true ? marketsQuery.data.data : null;
  const market = marketList?.markets.find((row) => row.marketId === marketId) ?? null;
  // The chart's indicators and drawings ride along so the agent reads the
  // chart the trader marked, not a bare symbol.
  const savedChart = useLighterAnalysisStore((state) =>
    market === null ? undefined : state.charts[deskChartScopeKey(environment, market.marketId)],
  );
  // The values already on the desk travel with the scope, so a plain question
  // is answered from them instead of from a round of provider reads.
  //
  // The desk's own snapshot is read first and the market list second. The list
  // joins its statistics from a SEPARATE all-market detail call that is
  // allowed to fail (see `readLighterTradingMarketList`), and when it does,
  // every market in the list comes back with null statistics: a desk showing
  // a price in its market bar was handing the agent nothing at all. The
  // snapshot also carries the day's range, which the list does not.
  //
  // This is the same query key the desk already uses, so it shares that cache
  // rather than issuing a second read, and it is held to the same condition.
  const snapshotQuery = useLighterTradingSnapshot(
    environment,
    marketId,
    resolution,
    market !== null && marketSectionFor(environment, market) !== "stocks",
  );
  const snapshot = snapshotQuery.data?.ok === true ? snapshotQuery.data.data : null;
  const valuesRetrievedAt = snapshot?.retrievedAt ?? marketList?.retrievedAt ?? null;
  const live = market === null || valuesRetrievedAt === null
    ? undefined
    : {
      lastTradePrice: snapshot?.detail.lastTradePrice ?? market.statistics?.lastTradePrice ?? null,
      priceChange24h: snapshot?.detail.daily.priceChange ?? market.statistics?.priceChange24h ?? null,
      dayHigh: snapshot?.detail.daily.priceHigh ?? null,
      dayLow: snapshot?.detail.daily.priceLow ?? null,
      quoteVolume24h: snapshot?.detail.daily.quoteTokenVolume ?? market.activity24h.quoteVolume,
      // REST reports perp open interest in base size; the list already guards
      // that, so it stays the one source for it.
      openInterestBase: market.statistics?.openInterestBase ?? null,
      retrievedAt: valuesRetrievedAt,
    };
  const scope: DeskContextScope | null = market === null
    ? null
    : {
      environment,
      market,
      resolution,
      ...(savedChart === undefined ? {} : { chart: { preferences: savedChart.preferences, drawings: savedChart.drawings } }),
      ...(live === undefined ? {} : { live }),
    };

  // Typed messages carry the desk's scope (see `composer-submit.ts`); the tag
  // lives only while this rail is mounted.
  const setDeskScopeTag = useDeskScopeStore((state) => state.setDeskScopeTag);
  const tag = scope === null ? null : deskScopeTag(scope);
  useEffect(() => {
    setDeskScopeTag(tag);
    return () => setDeskScopeTag(null);
  }, [tag, setDeskScopeTag]);

  if (activeSessionId !== null) {
    return (
      <div className="lit-chat-shell">
        {scope === null ? null : <DeskScopeStrip scope={scope} sessionId={activeSessionId} />}
        <SessionPanel surface="embedded" />
      </div>
    );
  }

  const symbol = market?.symbol ?? "Lighter";
  // The same scope the tag and quick prompts use: the starters are the chart
  // prompts, so they cannot be the one path that drops the chart and its values.
  const prompts = scope === null ? [] : deskStarterPrompts(scope);
  return (
    <div className="lit-chat-empty">
      <div className="lit-chat-empty-content">
        <div className="lit-chat-empty-lead">
          <div className="lit-chat-empty-mark" aria-hidden="true">
            <img src="./protocols/lighter.svg" alt="" width="44" height="44" />
          </div>
          <div className="lit-chat-empty-copy">
            <h4>Your {symbol} trading desk</h4>
            <p>Read the chart, explore a setup, or review a trade with Vex.</p>
          </div>
        </div>
        {prompts.length === 0 ? null : (
          <div className="lit-chat-starters" role="group" aria-label="Trading desk prompts">
            {prompts.map((prompt) => (
              <button
                type="button"
                key={prompt.code}
                onClick={() => openCreateSession(prompt.message)}
              >
                <span className="lit-chat-starter-code" aria-hidden="true">{prompt.code}</span>
                <span className="lit-chat-starter-copy">
                  <b>{prompt.label}</b>
                  <small>{prompt.detail}</small>
                </span>
                <span className="lit-chat-starter-arrow" aria-hidden="true">
                  <IconArrowUpRight size={17} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="lit-chat-start-dock">
        <button type="button" onClick={() => openCreateSession()}>
          Open the {symbol} desk
        </button>
        <small>Read-only until you separately review and approve a trade.</small>
      </div>
    </div>
  );
}

/**
 * The scope chip and the one-tap prompts for it. The prompts follow the
 * account: flat on this market reads or plans, in a position manages it.
 */
function DeskScopeStrip({ scope, sessionId }: {
  readonly scope: DeskContextScope;
  readonly sessionId: string;
}): JSX.Element {
  const accountQuery = useLighterTradingAccount(scope.environment, true);
  const position =
    accountQuery.data?.ok === true
      ? accountQuery.data.data.positions.find((row) => row.marketId === scope.market.marketId) ?? null
      : null;
  const prompts = deskQuickPrompts(scope, position);
  return (
    <div className="lit-desk-scope" data-vex-area="desk-scope">
      <span className="lit-desk-scope-chip" title="Every message you type here carries this scope">
        {deskScopeLabel(scope)}
        {position === null ? null : <i>{position.side}</i>}
      </span>
      <div className="lit-desk-quick" role="group" aria-label="Quick prompts">
        {prompts.map((prompt) => (
          <button type="button" key={prompt.label} onClick={() => publishDeskSend(sessionId, prompt.message)}>
            {prompt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
