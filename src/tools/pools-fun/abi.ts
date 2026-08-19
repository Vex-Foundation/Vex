/**
 * Verified pools.fun contract fragments.
 *
 * Provenance: extracted from the Blockscout-verified sources and ABI bundled in
 * `agents_dm/pools-fun-probe/contracts/` (PartyFactory verified 2026-08-11,
 * PartyLocker and PartyToken read from their verified sources). Nothing here is
 * hand-written from memory - an unverified fragment must never enter a path that
 * reads or signs money.
 *
 * Only the fragments the read tools actually call are listed, plus
 * `TokenLaunched`, which is the launch path's settlement anchor and is carried
 * here so the launch phase inherits a verified event rather than transcribing
 * one later (the same reason `trench-express/constants.ts` carries the Diamond
 * address ahead of its trading phase).
 */

/**
 * `PartyLocker` reads. The locker holds every pools.fun LP NFT permanently and
 * is the CANONICAL answer to "which pool is this token's pool" - tokens accrue
 * secondary arbitrage pools on other DEXes that indexers also list.
 *
 * A `platform=sushi` token is registered with the older SushiLaunchpad, not this
 * locker, so these calls return zeroes for it. Zeroes are not data: the caller
 * must say "not registered with this locker" rather than emit an all-zero pool.
 */
export const PARTY_LOCKER_ABI = [
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "getPoolInfo",
    outputs: [
      { internalType: "address", name: "pairedAsset", type: "address" },
      { internalType: "address", name: "pool", type: "address" },
      { internalType: "address", name: "creator", type: "address" },
      { internalType: "address", name: "feeRecipient", type: "address" },
      { internalType: "uint256[]", name: "tokenIds", type: "uint256[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "getPoolSplits",
    outputs: [
      { internalType: "uint16", name: "pc", type: "uint16" },
      { internalType: "uint16", name: "pp", type: "uint16" },
      { internalType: "uint16", name: "pb", type: "uint16" },
      { internalType: "uint16", name: "pcm", type: "uint16" },
      { internalType: "uint16", name: "tc", type: "uint16" },
      { internalType: "uint16", name: "tprot", type: "uint16" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * `PartyLocker` creator-fee claims.
 *
 * `collectAndClaim(token)` is the ONE call the claim tool uses: it collects the
 * pool's accrued fees into the locker and pays the caller's share out, in ONE
 * transaction, returning BOTH legs. `eth_call`-simulating it as the session
 * wallet is the only honest way to answer "what would I get", which is why the
 * preview simulates rather than reads.
 *
 * `claimableToken` / `claimablePaired` are mappings keyed (token, account) and
 * they show fees ALREADY COLLECTED into the locker and not yet paid out. They
 * are NOT a claimable total: measured live, both read 0 while the simulation
 * returned a real paired amount, because nothing had been collected yet. They
 * are surfaced only under an "already collected" label.
 *
 * `NothingToClaim` / `NotClaimable` are the named reverts a simulation can
 * produce, and both are real answers rather than failures: the agent is told
 * there is nothing to claim, not that the call broke.
 *
 * Source: the Blockscout-verified `PartyLocker` ABI, fetched 2026-08-18. The
 * probe's FINDINGS listed this surface as UNPROBED; it was verified on-chain
 * before these fragments were written, because an invented money-path fragment
 * is exactly what the trench precedent refused to ship.
 */
export const PARTY_LOCKER_CLAIM_ABI = [
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "collectAndClaim",
    outputs: [
      { internalType: "uint256", name: "tokenAmt", type: "uint256" },
      { internalType: "uint256", name: "pairedAmt", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "claimableToken",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "claimablePaired",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [], name: "NothingToClaim", type: "error" },
  { inputs: [], name: "NotClaimable", type: "error" },
] as const;

/**
 * `PartyLocker.Claimed` - the settlement anchor for a claim.
 *
 * `account` is INDEXED and is the wallet that was paid, so a claim is
 * attributable without inference: exactly one `Claimed` from the pinned locker
 * with `account == session wallet` and `token == the claimed token`, or the
 * decoder declines.
 */
export const PARTY_LOCKER_CLAIMED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: true, internalType: "address", name: "account", type: "address" },
      { indexed: false, internalType: "uint256", name: "tokenAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "pairedAmount", type: "uint256" },
    ],
    name: "Claimed",
    type: "event",
  },
] as const;

/**
 * `PartyToken` reads: the ERC-20 `decimals` (the financial-grade number the API
 * cannot give - it sends `decimals: null` on every pools.fun row) and the
 * `metadataUri` the launcher stamped on the token.
 */
export const PARTY_TOKEN_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "metadataUri",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * `PoolsFunLaunchGateway` - the launch path Vex uses, and the surface the
 * calldata verifier interrogates before anything is signed.
 *
 * Every read here answers one of the verifier's 13 points, which is why they
 * are grouped rather than scattered: `VERSION` and `factory` prove the contract
 * at the pinned address is the gateway we think it is; `paused` proves it will
 * not refuse; `deploymentFeeWei` with its MIN/MAX bounds proves the fee the
 * provider quoted is the fee the contract will demand AND that it sits inside
 * the bounds the contract itself enforces (the fee is dynamic - it moved 4x in
 * 24 hours, so a value carried from a preview is a revert waiting to happen);
 * `computeTokenAddress` proves the token address the user approves is the one
 * this exact tuple produces.
 *
 * Source: the verified gateway ABI captured at
 * `agents_dm/pools-fun-live/gateway-abi.json` (Blockscout, 2026-08-18).
 */
export const POOLS_GATEWAY_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "string", name: "name", type: "string" },
          { internalType: "string", name: "symbol", type: "string" },
          { internalType: "string", name: "metadataUri", type: "string" },
          { internalType: "bytes32", name: "userSalt", type: "bytes32" },
          { internalType: "address", name: "pairedAsset", type: "address" },
          { internalType: "int24", name: "expectedStartTick", type: "int24" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "address", name: "feeRecipient", type: "address" },
          { internalType: "uint256", name: "nativeDevBuyAmount", type: "uint256" },
          { internalType: "uint256", name: "erc20DevBuyAmountIn", type: "uint256" },
          { internalType: "uint256", name: "devBuyMinOut", type: "uint256" },
          { internalType: "uint256", name: "expectedFeeWei", type: "uint256" },
        ],
        internalType: "struct PoolsFunLaunchGateway.LaunchParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "launch",
    outputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "address", name: "pool", type: "address" },
      { internalType: "uint256", name: "devBuyOut", type: "uint256" },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "launcher", type: "address" },
      { internalType: "bytes32", name: "userSalt", type: "bytes32" },
      { internalType: "string", name: "name", type: "string" },
      { internalType: "string", name: "symbol", type: "string" },
      { internalType: "string", name: "metadataUri", type: "string" },
    ],
    name: "computeTokenAddress",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "launcherOf",
    outputs: [{ internalType: "address", name: "launcher", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [], name: "VERSION", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "factory", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  // The gateway's own WETH, taken from `factory.weth()` in its constructor
  // (verified source line 91). It is READ rather than pinned as a constant
  // because it is the address the launch path itself uses: the gateway reverts
  // `NativeDevBuyRequiresWeth` unless `pairedAsset == weth` (line 140), so a
  // native prebuy is only valid against THIS address, not against whichever one
  // a token list calls "WETH".
  { inputs: [], name: "weth", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "paused", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "deploymentFeeWei", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "MIN_DEPLOYMENT_FEE_WEI", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "MAX_DEPLOYMENT_FEE_WEI", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

/**
 * `PoolsFunLaunchGateway.GatewayLaunch` - the gateway's own launch event, and
 * the half of the dual-event settlement that carries OUR identity.
 *
 * This is why the gateway path is decodable at all. `PartyFactory.TokenLaunched`
 * names the GATEWAY as creator on this path, so it cannot attribute a launch to
 * a user; `GatewayLaunch.launcher` is the session wallet, indexed. A settled
 * launch must produce exactly one of each, cross-checked field by field.
 */
export const POOLS_GATEWAY_LAUNCH_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: true, internalType: "address", name: "pool", type: "address" },
      { indexed: true, internalType: "address", name: "launcher", type: "address" },
      { indexed: false, internalType: "address", name: "pairedAsset", type: "address" },
      { indexed: false, internalType: "address", name: "feeRecipient", type: "address" },
      { indexed: false, internalType: "bytes32", name: "userSalt", type: "bytes32" },
      { indexed: false, internalType: "uint256", name: "feePaidWei", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "devBuyOut", type: "uint256" },
    ],
    name: "GatewayLaunch",
    type: "event",
  },
] as const;

/**
 * `PartyFactory` reads the verifier needs: whether the pair is allowlisted at
 * the anchored block, and what start tick the factory would use.
 *
 * `startTickFor` returns the tick AND a `live` flag saying whether it came from
 * the price feed or the fallback. Both are checked: a tuple pinned to a live
 * tick that the factory would now serve from fallback is a different launch.
 */
export const POOLS_FACTORY_READ_ABI = [
  {
    inputs: [{ internalType: "address", name: "asset", type: "address" }],
    name: "allowedPairedAsset",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "pairedAsset", type: "address" }],
    name: "startTickFor",
    outputs: [
      { internalType: "int24", name: "tick", type: "int24" },
      { internalType: "bool", name: "live", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * `PartyFactory.TokenLaunched` - emitted once per launch, carrying the token,
 * its pool, the paired asset, the creator, the start tick, the metadata URI and
 * the dev-buy fill. Note `creator` is INDEXED and, on the gateway launch path,
 * is the gateway rather than the human launcher; a decoder that attributes a
 * launch from this field alone would credit the wrong address.
 */
export const PARTY_FACTORY_TOKEN_LAUNCHED_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: true, internalType: "address", name: "pool", type: "address" },
      { indexed: false, internalType: "address", name: "pairedAsset", type: "address" },
      { indexed: true, internalType: "address", name: "creator", type: "address" },
      { indexed: false, internalType: "address", name: "deployer", type: "address" },
      { indexed: false, internalType: "address", name: "feeRecipient", type: "address" },
      { indexed: false, internalType: "int24", name: "startTick", type: "int24" },
      { indexed: false, internalType: "string", name: "metadataUri", type: "string" },
      { indexed: false, internalType: "uint256", name: "devBuyAmountOut", type: "uint256" },
    ],
    name: "TokenLaunched",
    type: "event",
  },
] as const;
