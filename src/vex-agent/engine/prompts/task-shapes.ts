import {
  WEB_SEARCH_DEFAULT_FETCH_TOP,
  WEB_SEARCH_DEFAULT_MAX_RESULTS,
  WEB_SEARCH_MAX_FETCH_TOP,
} from "@vex-agent/tools/internal/web-research/search-options.js";

export interface TaskShapeAvailability {
  readonly webResearch: boolean;
  readonly solana: boolean;
}

function buildResearchShape(webResearchAvailable: boolean): string[] {
  const lines = [
    "### Research",
    "Trigger: The user needs identity, freshness, depth, narrative, promotion, safety, or evidence before a decision.",
    "Default procedure: In an agent session or active mission run, answer research through all three layers before reporting: identity and discovery, depth and price sanity, then narrative and safety. If a layer is unreachable, continue through the others and report which layer was unavailable and why. Only mission setup stops at capability orientation because mutations are locked and the task is drafting.",
    "DexScreener indexing lags by minutes to hours for brand-new tokens. Fresh Solana discovery and Trench launchpad discovery can precede indexed pair research; use DexScreener afterwards for depth and price sanity. Virtuals is read-only launchpad intelligence, so acquiring an agent token continues as a separate swap task.",
    "Report: Name the exact chain and contract identity, source freshness, observed liquidity and market evidence, missing coverage, provider labels that are not proof, and whether the result is research or an executable quote.",
  ];
  if (webResearchAvailable) {
    lines.push(
      `Web research shapes: WebResearch(query="...") returns ${WEB_SEARCH_DEFAULT_MAX_RESULTS} hits and reads the top ${WEB_SEARCH_DEFAULT_FETCH_TOP}; topic="news" is the dated-news shape; fetchTop=0 returns snippets only; fetchTop=${WEB_SEARCH_MAX_FETCH_TOP} performs deeper multi-source reading; WebResearch(url="https://...") reads one complete page. Use the smallest shape that answers the question. A token under about 30 days old or under a few thousand holders may have no useful web coverage. Search the contract address plus chain, retry news once with a timeRange when recency matters, then use first-party and on-chain sources; missing web coverage is not evidence the token is fake.`,
    );
  }
  return lines;
}

function buildSwapShape(): string[] {
  return [
    "### Swap",
    "Trigger: The user wants to buy, sell, swap, exit, or acquire a token after discovery.",
    "Default procedure: Resolve the exact token and chain, check safety where available, then quote before execution. KyberSwap is the primary EVM swap venue and Uniswap is the always-callable alternative when KyberSwap lacks chain support, cannot route the pair, fails its own route checks, reverts on-chain, or is unavailable. Do not switch for a bad price alone or for slippage, balance, allowance, or deadline failures; correct the amount or take a fresh quote. When switching, quote the new venue and never reuse the failed route. Use Jupiter for Solana. A Trench token still on its curve trades only against ETH on that curve; after graduation it moves to a WETH-paired pool. A pools.fun token has no curve and needs a separate standard swap quote from its first block; measured routing found 13 of 13 sampled tokens. Virtuals discovery is read-only and acquisition continues on the venue named by its route.",
    "Quote and execute on the SAME venue: a swap execute runs only against a fresh quote from the exact venue it will broadcast on. The runtime enforces this.",
    "Robinhood caution: KyberSwap's indexed reserves can be stale on thin pairs there.",
    "A quote whose priceImpact is strongly NEGATIVE (output supposedly worth more than input), or an execute reverting with 'Return amount is not enough', means the quote overestimated the pool — do NOT retry with higher slippage; re-quote, or tell the user KyberSwap's pricing looks unreliable for this pair.",
    "Always read the anti-sniper window before buying.",
    "ANTI-SNIPER: before buying a graduated agent, call `virtuals__agent_get` and check `antiSniper`.",
    "NEVER buy while `windowActive` is true — the buy tax starts near 99% at graduation and decays to ~1% over the window.",
    "Wait out `remainingSeconds`, or tell the user the token is inside its sniper-protection window.",
    "Report: State the chosen venue and why, quote freshness, expected and minimum output, price impact, gas, safety signals, any venue switch and its failure class, and confirmed, reverted, refused, or pending outcome without guessing.",
  ];
}

function buildBridgeShape(): string[] {
  return [
    "### Bridge",
    "Trigger: The task moves assets between chains or needs funds on the chain where a later action will run.",
    "Default procedure: Before planning an action on a chain, confirm you can REACH it and LEAVE it: each namespace's coverage line above does not change within a session, while live bridge reach is in the turn state.",
    "Khalani is the primary bridge for routes it supports, including EVM and Solana. Relay is the fallback when Khalani has no route and the only bridge to or from Robinhood Chain; Relay is EVM-only and does not support Solana. Confirm live reach, quote first, execute on the same provider, and inspect the order until delivery is verified. Reads on Robinhood Chain go direct-RPC, `WalletBalances` for balances and `ChainRead` with action `erc20_balance` for one token, because Khalani balance coverage excludes it. For a bridge-then-swap task, verify both the entry and exit path before funds move.",
    "Report: State origin, destination, exact assets, expected output, timing, provider, quote expiry, origin broadcast, destination delivery state, refund or failure state, and any disagreement between provider and Vex records. Never retry merely because delivery is still pending.",
  ];
}

function buildYieldShape(solanaAvailable: boolean): string[] {
  const solanaClause = solanaAvailable
    ? " Route Solana yield to Jupiter Lend for earn and collateralized borrowing."
    : " Solana yield is unavailable until its configured capability is enabled.";
  return [
    "### Yield",
    "Trigger: The user wants to stake, earn yield, lock a rate, lend, borrow, provide liquidity, or manage a yield position.",
    `Default procedure: There is no plain staking capability. Route fixed term yield with a maturity date to Pendle and floating-rate EVM lending or borrowing to Morpho.${solanaClause} Never substitute a swap for a yield position. On Morpho, choose a curated vault when a curator selects and reallocates markets for a fee; choose a market when the user selects the pair, lends directly, or borrows. On Pendle, distinguish principal-token fixed yield, yield-token variable exposure, liquidity, position movement, and wrapping. Screen first, inspect detail and warnings, compare like-for-like yield bases, check liquidity and expiry, then quote or dry-run the exact action before execution.`,
    "Report: Label fixed versus floating yield, maturity, base versus incentive yield, gross versus net basis, fees, liquidity and exit risk, oracle or market warnings, quote or dry-run freshness, and every output leg.",
  ];
}

function buildPositionsShape(): string[] {
  return [
    "### Positions and risk",
    "Trigger: The user asks what they hold, owe, can withdraw or claim, or how close a position is to liquidation.",
    "Default procedure: Read the wallet's own position rather than a screening row. Treat missing or partial coverage as unknown, not zero. For Morpho, health factor is a ratio, null means no debt rather than safety, and activity and liquidation history are market-risk evidence. Read oracle warnings, bad debt, available liquidity, gates, allowances, and position coverage before recommending an action. Unwind in the safer order: debt down before collateral out. Value multi-token rewards separately and compare their value with gas before claiming.",
    "Present 1.25 as a pre-signature risk buffer, never as a level the position is guaranteed to hold.",
    "What protects the in-between state is ORDERING, not the health-factor floor: collateral goes IN before debt goes out, and debt comes DOWN before collateral comes out, so a failure of the second leg leaves the position safer than it started rather than exposed.",
    "A real claim is an ordinary approval-gated on-chain transaction that costs gas, so say so before claiming a dust balance.",
    "Report: Name the wallet scope, assets and units, debt, collateral, health factor and band, liquidation threshold, oracle uncertainty, free versus reallocatable liquidity, incomplete coverage, standing allowances, claimable versus pending rewards, gas, and the safe next step.",
  ];
}

function buildLaunchesShape(): string[] {
  return [
    "### Launches",
    "Trigger: The user wants to discover, preview, draft, or execute a token launch, or trade a token whose launchpad lifecycle determines the venue.",
    "Default procedure: Identify the launchpad first. Trench uses an ETH bonding curve and graduation; pools.fun has no curve and creates a SushiSwap V3 pool immediately. Both agent paths start from a user-staged image. Preview current costs immediately before execution, keep a human form separate from direct execution, and never infer that a drafted or pending launch happened. After launch, route Trench curve trading through its curve and pools.fun acquisition through a separate standard swap stage.",
    "Launching a token on Trench Express (Robinhood Chain, 4663) spends real ETH and cannot be undone.",
    "`trench__launch_execute` signs and broadcasts the launch irreversibly, and only under explicit authority.",
    "In a FULL-permission chat session that authority is the user's own permission: execute directly, exactly as you would a swap.",
    "In a RESTRICTED session it refuses by name — call `trench__launch_request_form` instead, because the launch form is this tool's consent surface and the user's Deploy click is what launches.",
    "In a MISSION run the authority is the contract's host-authored launch ceilings; when the contract carries none the tool refuses by name, so report that refusal and tell the user to set the max launch value and max launch count on the contract card.",
    "Never look for another way to launch.",
    "Launching a token on pools.fun spends real ETH and cannot be undone:",
    "(A token launched with no image renders blank on pools.fun forever, which cannot be undone. Only the user's own launch form may choose to launch without one; that is their decision to make and never yours.)",
    "Never promise a predicted address from a preview.",
    "A fee from an earlier turn is stale: never present a preview's figure as what the launch will cost.",
    "THE CREATOR FEE RECIPIENT IS PINNED to the session wallet on every agent launch, and the agent-facing tools have NO recipient parameter at all.",
    "An autonomous prebuy is WETH-NATIVE ONLY, because the gateway itself refuses a native dev buy against any other pair; a USDG prebuy exists only on the manual form path.",
    "The FORM is the consent surface and the user's Deploy click is what launches.",
    "`pools__launch_execute` signs and broadcasts the launch irreversibly, and only under explicit authority.",
    "In a FULL-permission chat session that authority is the user's own permission: execute directly, exactly as you would a swap.",
    "In a RESTRICTED session it refuses BY NAME - call `pools__launch_request_form` instead.",
    "In a MISSION run the authority is the contract's HOST-authored launch ceilings, which you cannot write; while a contract carries none the tool refuses BY NAME, so report that refusal and tell the user to set the max launch value and max launch count on the contract card.",
    "Report: Name the launchpad, lifecycle, staged image, preview freshness, current total cost and gas, predicted-address availability, authority path, form or execution state, transaction identity, and whether post-launch trading uses a curve or a standard pool.",
  ];
}

export function buildTaskShapesPrompt(availability: TaskShapeAvailability): string {
  return [
    "## How Vex works a task",
    "",
    ...buildResearchShape(availability.webResearch),
    "",
    ...buildSwapShape(),
    "",
    ...buildBridgeShape(),
    "",
    ...buildYieldShape(availability.solana),
    "",
    ...buildPositionsShape(),
    "",
    ...buildLaunchesShape(),
  ].join("\n");
}
