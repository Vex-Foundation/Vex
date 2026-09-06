/**
 * WHETHER A CHAIN'S `pending` BLOCK TAG ACTUALLY SUBTRACTS ANYTHING, per chain.
 *
 * WHY THIS TABLE EXISTS. Contract C2.4 makes `pending` the authorization tag
 * for a spendability read, because it is the only tag that subtracts the
 * wallet's own in-flight transactions. That is a statement about the ENDPOINT,
 * not about the JSON-RPC method: every endpoint Vex swaps against ACCEPTS the
 * tag, and FOURTEEN of the eighteen answer it with a block already mined or
 * expose no pending block at all. On those, a `pending` balance IS a `latest`
 * balance, so passing the tag satisfies nothing and a reader that believed
 * otherwise would be authorizing a spend against money an unconfirmed
 * transaction has already taken.
 *
 * The same shape as `./l1-data-fee.ts`, and for the same reason: every row was
 * MEASURED, and a chain with no row is a refusal rather than an assumption.
 * Inferring "this endpoint maintains a distinct pending state" from the tag
 * being accepted is exactly the inference that file's header rejects for the
 * L1 fee.
 *
 * THE THREE STATES:
 *
 *   - `distinct`: the endpoint assembles a real, unmined pending block. A
 *     `pending` balance there already nets out this wallet's unconfirmed
 *     spending and the read stands on its own.
 *   - `head_alias`: the endpoint answered `pending` with a block that is
 *     already mined. The tag is accepted and means `latest`.
 *   - `absent`: the endpoint exposes no pending block at all (`null`). Same
 *     consequence as `head_alias`, different fact, so it is a different row -
 *     collapsing them would hide which endpoints could gain a pending state by
 *     configuration and which have none to gain.
 *
 * WHAT A CALLER MUST DO WITH A NON-`distinct` ROW. Nothing in `src/tools` can
 * answer it: the compensation is a query against Vex's OWN durable record of
 * what it has broadcast and not yet resolved, which lives on the agent side
 * (`vex-agent/tools/protocols/quote-authority/pending-debit-compensation.ts`).
 * This module states the FACT; that module owns the POLICY.
 *
 * PROVENANCE OF EVERY ROW, and why it is NOT the block-number delta.
 *
 * WP2-E0 measured this on 2026-08-31 by comparing the NUMBER of the block
 * returned at `pending` with the number returned at `latest`. That proxy is
 * RACY, and re-measuring on 2026-09-01 proved it: two sequential JSON-RPC calls
 * are two moments, so on a fast chain the head simply advances in between and a
 * pure alias reports a positive delta. The same Arbitrum endpoint that E0
 * recorded as `equal` answered `+4` on the re-measure, from nothing but call
 * latency.
 *
 * The rows below come from an IDENTITY test instead, which no amount of block
 * production can perturb:
 *
 *   1. `eth_getBlockByNumber("pending")` returning `null` - no pending block
 *     exists at all: `absent`.
 *   2. the pending block returning an UNSEALED hash (JSON `null`, or the
 *     all-zero hash some clients use for the same thing) - a block that has not
 *     been mined is a block being assembled: `distinct`.
 *   3. otherwise the pending block is SEALED, so its identity is asked for
 *     directly: `eth_getBlockByNumber(pending.number)`. When the canonical
 *     block at that height IS the same hash, `pending` handed back a mined
 *     block - it is `latest` under another name: `head_alias`.
 *   4. a sealed pending block whose hash is not the canonical one at its height
 *     is INCONCLUSIVE, and inconclusive is recorded as `head_alias`. Not
 *     proven distinct is not distinct on a money path.
 *
 * The re-measure and E0 AGREE on every chain E0 could decide with its proxy in
 * the negative direction (Arbitrum, Optimism, Sonic, Monad aliasing; BSC,
 * HyperEVM, MegaETH absent) and on Ethereum, Polygon, Linea and Base being
 * real. They DISAGREE wherever E0's proxy read latency as a pending state:
 * Mantle, Plasma, Avalanche and Robinhood are aliases, and Unichain, Ronin and
 * Berachain are inconclusive. Twelve of eighteen endpoints therefore give the
 * tag no meaning, not seven.
 *
 * Endpoints are the repository's own configured RPCs
 * (`tools/kyberswap/evm/config.ts` `DEFAULT_RPC`; `evm-chains/registry.ts` for
 * 4663), because the capability is a property of the ENDPOINT Vex actually
 * calls, not of the chain in the abstract. The full probe output is archived in
 * `vex-agent/tools/tool-surface-spec/balance-reads/wp2-signing-pin-note-2026-08-31.md`
 * section F-EVM.
 */

/** What an endpoint's `pending` tag was measured to mean. */
export type PendingBlockState = "distinct" | "head_alias" | "absent";

export interface PendingBlockCapability {
  readonly chainId: number;
  readonly slug: string;
  readonly state: PendingBlockState;
  /** What was measured, when, and what it showed. Never a convention. */
  readonly evidence: string;
}

const MEASURED = "measured live 2026-09-01";

const UNSEALED = `${MEASURED}: eth_getBlockByNumber at pending returned an UNSEALED block `
  + "(hash null or all-zero), so the endpoint assembles a real pending block.";
const NO_PENDING_BLOCK = `${MEASURED}: eth_getBlockByNumber at pending returned null, so the `
  + "endpoint exposes no pending block at all.";
const CANONICAL = `${MEASURED}: the pending block came back SEALED and its hash IS the canonical `
  + "block at that height, so pending is the head under another name.";
const INCONCLUSIVE = `${MEASURED}: the pending block came back SEALED and its hash was not the `
  + "canonical block at that height; the endpoint could not be shown to maintain a distinct "
  + "pending state, and not proven distinct is treated as not distinct.";

/**
 * Every EVM chain a Vex swap venue serves - the same set, in the same order, as
 * `l1-data-fee.ts`'s table, because both are answers about the same endpoints
 * and a chain present in one and missing from the other would be a silent gap.
 *
 * A chain added to either venue MUST get a row here, measured the same way, or
 * every spendability read on it refuses.
 */
const CAPABILITIES: readonly PendingBlockCapability[] = [
  { chainId: 1, slug: "ethereum", state: "distinct", evidence: UNSEALED },
  { chainId: 10, slug: "optimism", state: "head_alias", evidence: CANONICAL },
  { chainId: 56, slug: "bsc", state: "absent", evidence: NO_PENDING_BLOCK },
  { chainId: 130, slug: "unichain", state: "head_alias", evidence: INCONCLUSIVE },
  { chainId: 137, slug: "polygon", state: "distinct", evidence: UNSEALED },
  { chainId: 143, slug: "monad", state: "head_alias", evidence: CANONICAL },
  { chainId: 146, slug: "sonic", state: "head_alias", evidence: CANONICAL },
  { chainId: 999, slug: "hyperevm", state: "absent", evidence: NO_PENDING_BLOCK },
  { chainId: 2020, slug: "ronin", state: "head_alias", evidence: INCONCLUSIVE },
  { chainId: 4326, slug: "megaeth", state: "absent", evidence: NO_PENDING_BLOCK },
  { chainId: 4663, slug: "robinhood", state: "head_alias", evidence: CANONICAL },
  { chainId: 5000, slug: "mantle", state: "head_alias", evidence: CANONICAL },
  { chainId: 8453, slug: "base", state: "distinct", evidence: UNSEALED },
  { chainId: 9745, slug: "plasma", state: "head_alias", evidence: CANONICAL },
  { chainId: 42161, slug: "arbitrum", state: "head_alias", evidence: CANONICAL },
  { chainId: 43114, slug: "avalanche", state: "head_alias", evidence: CANONICAL },
  { chainId: 59144, slug: "linea", state: "distinct", evidence: UNSEALED },
  { chainId: 80094, slug: "berachain", state: "head_alias", evidence: INCONCLUSIVE },
];

const BY_CHAIN_ID: ReadonlyMap<number, PendingBlockCapability> = new Map(
  CAPABILITIES.map((capability) => [capability.chainId, capability]),
);

/** The measured row for a chain, or `undefined` when Vex has never measured it. */
export function getPendingBlockCapability(chainId: number): PendingBlockCapability | undefined {
  return BY_CHAIN_ID.get(chainId);
}

/** Every measured row, for the venue-coverage test and for operator reporting. */
export function listPendingBlockCapabilities(): readonly PendingBlockCapability[] {
  return CAPABILITIES;
}
