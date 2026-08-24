import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_TOKENS_DISCOVERY } from "../../embeddings/kyberswap/tokens.js";

export const TOKENS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "kyberswap.tokens.check",
    publicName: "kyberswap__token_safety_check",
    namespace: "kyberswap",
    lifecycle: "active",
    description:
      "Audit ONE EVM token contract for honeypot behaviour and a fee-on-transfer tax, using KyberSwap's token "
      + "safety service. Use this when the user asks whether a coin is a scam or safe to trade, suspects a "
      + "fee-on-transfer or sell tax, or wants an unfamiliar or newly launched token checked before buying it. "
      + "`tokenAddress` is a contract address on the named chain, so resolve a symbol with TokenFind first. "
      + "RETURNS `chain`, `chainId`, `tokenAddress`, `isHoneypot`, `isFOT`, and `tax`, the provider's "
      + "fee-on-transfer figure. Read `tax` carefully: a missing provider value defaults to 0, so a 0 means "
      + "nothing was reported rather than proof that no tax exists. The verdict is a provider opinion about ONE "
      + "contract at one moment, not a guarantee: it does not prove the pair is liquid, the price is fair, or the "
      + "token will still behave this way after a contract owner changes it. Calling this is not required before a "
      + "swap; `kyberswap__swap_quote` already reports the same audit for both legs in its `safety` field, and "
      + "`kyberswap__swap_execute` refuses on a confirmed honeypot on its own. Answers with one verdict per call; "
      + "there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or alias." },
      {
        key: "tokenAddress",
        type: "string",
        required: true,
        description:
          "Token contract address to inspect (0x… on the named chain). Resolve it with TokenFind first — a symbol is not accepted. The former key `address` is retired and is rejected by name.",
      },
    ],
    exampleParams: { chain: "ethereum", tokenAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    discovery: KYBERSWAP_TOKENS_DISCOVERY["kyberswap.tokens.check"],
  },
];
