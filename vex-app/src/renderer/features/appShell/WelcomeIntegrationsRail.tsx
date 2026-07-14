/**
 * WELCOME INTEGRATIONS RAIL — the quiet "execution surface" line above the
 * hero-bottom row: the six integrated protocols + the chain coverage claim
 * (20+ EVM networks + Solana).
 *
 * Color law: the six protocol tiles ship with CLASHING baked backgrounds
 * (DexScreener black, Jupiter navy, Pendle near-white, Uniswap pale pink),
 * so at rest every mark is a GRAYSCALE coin at reduced opacity — one etched
 * row that belongs to the ink/cobalt scene, exactly like the BACKED BY
 * hallmark above it. Hover restores the full brand color on that one coin:
 * color stays rationed, the row rests still (no marquee — the shell's
 * animations are bound to work, and this band is furniture).
 *
 * Coin fitting: square raster tiles crop to circles (object-cover); the
 * wide KyberSwap lockup crops to its LEFT edge where the diamond mark
 * rides; the portrait Khalani mark letter-fits (object-contain).
 *
 * The chain cluster reuses ChainIcon (local base/arbitrum SVGs, monogram
 * fallback) as an overlapped coin stack — evidence for the "20+ EVM chains"
 * line, with Solana called out separately as its own family.
 */

import type { JSX } from "react";
import {
  ARBITRUM_CHAIN_ID,
  BASE_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from "@shared/chains/display.js";
import { ChainIcon } from "../../components/common/ChainIcon.js";
import { cn } from "../../lib/utils.js";

interface ProtocolMark {
  readonly name: string;
  readonly src: string;
  /** Artwork fit inside the coin — see the header's coin-fitting note. */
  readonly fit?: "contain" | "cover-left";
}

const PROTOCOLS: readonly ProtocolMark[] = [
  { name: "Uniswap", src: "/protocols/uniswap.png" },
  { name: "Jupiter", src: "/protocols/jupiter.jpg" },
  { name: "KyberSwap", src: "/protocols/kyberswap.svg", fit: "cover-left" },
  { name: "Pendle", src: "/protocols/pendle.jpg" },
  { name: "DexScreener", src: "/protocols/dexscreener.jpg" },
  { name: "Khalani", src: "/protocols/khalani.svg", fit: "contain" },
  { name: "Hyperliquid", src: "/protocols/hl.png" },
  // Integrated agent tool (src/tools/virtuals) — ALSO the backer hallmark
  // below; both roles are true, so it appears in both lines.
  { name: "Virtuals", src: "/logo/virtuals.svg", fit: "contain" },
];

/** EVM coin stack — the promoted networks first, then the majors. */
const EVM_STACK: readonly number[] = [
  ETHEREUM_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  BASE_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
  137, // Polygon
  10, // Optimism
  56, // BNB Chain
];

function ProtocolChip({ mark }: { readonly mark: ProtocolMark }): JSX.Element {
  return (
    <span className="group flex items-center gap-1.5" title={mark.name}>
      <span className="h-5 w-5 shrink-0 overflow-hidden rounded-full border border-white/[0.08] bg-white/[0.04]">
        <img
          src={mark.src}
          alt=""
          aria-hidden
          draggable={false}
          className={cn(
            "h-full w-full grayscale opacity-75 transition-[filter,opacity] duration-200 group-hover:opacity-100 group-hover:grayscale-0",
            mark.fit === "contain" ? "object-contain p-0.5" : "object-cover",
            mark.fit === "cover-left" && "object-left",
          )}
        />
      </span>
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--vex-text-3)] transition-colors group-hover:text-[var(--vex-text-2)]">
        {mark.name}
      </span>
    </span>
  );
}

/** One coin of the chain stack — a solid ink plinth so overlapped neighbours
 * never bleed through the mark. */
function ChainCoin({ chainId }: { readonly chainId: number }): JSX.Element {
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white/[0.1] bg-[var(--vex-surface-1)]">
      <ChainIcon chainId={chainId} size={11} />
    </span>
  );
}

export function WelcomeIntegrationsRail(): JSX.Element {
  return (
    <div
      data-vex-area="welcome-integrations"
      // The parent band is click-transparent; the rail restores pointer
      // events on itself so the hover color reward works.
      className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
    >
      <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-[var(--vex-text-3)]">
        Executes through
      </span>
      <span className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        {PROTOCOLS.map((mark) => (
          <ProtocolChip key={mark.name} mark={mark} />
        ))}
      </span>

      <span aria-hidden className="hidden h-3 w-px bg-white/[0.1] sm:block" />

      <span className="flex items-center gap-2.5">
        <span className="flex items-center -space-x-1.5">
          {EVM_STACK.map((id) => (
            <ChainCoin key={id} chainId={id} />
          ))}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
          20+ EVM chains
        </span>
        <span aria-hidden className="h-3 w-px bg-white/[0.1]" />
        <span className="flex items-center gap-1.5">
          <ChainCoin chainId={SOLANA_CHAIN_ID} />
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
            Solana
          </span>
        </span>
      </span>
    </div>
  );
}
