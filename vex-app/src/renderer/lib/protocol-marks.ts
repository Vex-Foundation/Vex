/**
 * Protocol-mark resolver — venue string → the small round logo beside an
 * activity row's badge.
 *
 * Mirrors `token-marks.ts`'s curated-map doctrine, one layer up: a bundled
 * asset is granted ONLY to a venue this file actually knows; everything else
 * takes a monogram. A venue we have no artwork for must NEVER borrow another
 * protocol's mark — a Relay bridge wearing the Khalani logo would be a
 * provenance lie about who moved the user's money, which is exactly the
 * failure mode the token matrix exists to prevent.
 *
 * Assets are bundled under `renderer/public/protocols/` and resolve as
 * same-origin paths. Like `TokenIcon`/`TokenMark`, this is deliberately
 * OFFLINE: no provider logo URLs ever reach the renderer, so a feed row can
 * never trigger a third-party image fetch (and cannot be used to probe the
 * network from the untrusted UI).
 *
 * The curated keys are the COMPLETE venue vocabulary the agent tools emit
 * today — `khalani`, `kyberswap`, `pendle`, `relay`, `uniswap`, `jupiter`,
 * `dexscreener`, `polymarket`, `solana`, `virtuals` (the last two are protocol
 * `toolId` namespaces surfaced by the transcript's tool cards). `polymarket`
 * and `solana` are listed with no asset on purpose: they keep an honest display
 * label while taking the monogram until artwork lands, which is a one-line
 * change here.
 */

/** Hard bound on a venue string reaching a label or a monogram. */
const MAX_LABEL_CHARS = 32;

/**
 * What a caller should render for one protocol. `local` is a bundled asset;
 * `monogram` is the explicit "known venue, no artwork" / "unrecognised venue"
 * variant — never faked by pointing at some other protocol's file.
 */
export type ProtocolMarkResolution =
  | { readonly kind: "local"; readonly src: string; readonly label: string }
  | { readonly kind: "monogram"; readonly label: string; readonly initial: string };

interface CuratedProtocol {
  /** Display label — proper casing the raw lower-case venue string loses. */
  readonly label: string;
  /** Bundled asset path, or null when we have a name but no artwork yet. */
  readonly src: string | null;
}

/**
 * Curated venue matrix, keyed on the lower-cased venue string the DTOs carry.
 * Every `src` points at a file physically present under `renderer/public/`
 * (`/protocols/*` for venue artwork, `/logo/*` for the marks the landing
 * surfaces already ship).
 */
const CURATED: Readonly<Record<string, CuratedProtocol>> = {
  dexscreener: { label: "DexScreener", src: "/protocols/dexscreener.jpg" },
  jupiter: { label: "Jupiter", src: "/protocols/jupiter.jpg" },
  khalani: { label: "Khalani", src: "/protocols/khalani.svg" },
  kyberswap: { label: "KyberSwap", src: "/protocols/kyberswap.svg" },
  pendle: { label: "Pendle", src: "/protocols/pendle.jpg" },
  relay: { label: "Relay", src: "/protocols/relay.png" },
  uniswap: { label: "Uniswap", src: "/protocols/uniswap.png" },
  // Known venue, no bundled artwork — an honest label + the monogram.
  // Polymarket was removed from the product in Phase 1 and nothing writes it
  // any more; the row stays so a HISTORICAL legacy capture still renders with
  // its real name instead of a bare monogram. It is deliberately NOT a feed
  // filter option (see `agent-scan/agent-scan-protocols.ts`).
  polymarket: { label: "Polymarket", src: null },
  // `solana` is a protocol toolId NAMESPACE (solana.swap.quote …), not a venue
  // with bundled artwork. `/protocols/jupiter.jpg` is Jupiter's mark, NOT
  // Solana's — lending it here would be exactly the provenance lie this file
  // exists to prevent, so Solana keeps its honest label and the monogram.
  solana: { label: "Solana", src: null },
  // Virtuals ships a real mark with the landing assets (`/logo/virtuals.svg`,
  // already rendered by the welcome surfaces) — provenance is our own bundle.
  virtuals: { label: "Virtuals", src: "/logo/virtuals.svg" },
};

/**
 * NOT A FILTER SOURCE. This map answers "what does this venue LOOK like?", not
 * "what venues can appear in a feed?" — it deliberately knows more venues than
 * any one surface can show (read-only market-data tools, legacy-only writers,
 * a retired product). Deriving a filter's options from it shipped exactly that
 * bug once: the Agent Scan protocol filter offered Polymarket and DexScreener,
 * neither of which can ever appear in `agent_activity`, so selecting either
 * could only ever return an empty feed. A feed's filter options must come from
 * the list of things that WRITE that feed — see
 * `features/appShell/screens/agent-scan/agent-scan-protocols.ts`.
 */

/**
 * Is this venue string one we actually KNOW? The fallback branch of
 * `resolveProtocolMark` deliberately keeps an unrecognised venue's own text
 * (a feed row's protocol comes from our own main-process capture, so naming it
 * is honest). A caller whose venue string comes from UNTRUSTED payload text —
 * the transcript's `execute_tool` `toolId` namespace — must gate on this
 * FIRST: an arbitrary syntactically-valid namespace must never be handed a
 * venue-looking monogram and title. See `ToolLedger/toolIdentity.ts`.
 */
export function isCuratedProtocol(protocol: string | null): boolean {
  if (protocol === null) return false;
  return CURATED[protocol.trim().toLowerCase()] !== undefined;
}

/** First character of a label, uppercased, for the monogram ring. */
function monogramInitial(label: string): string {
  return label.charAt(0).toUpperCase();
}

/**
 * Resolve the visual mark for one protocol/venue. `null` means there is no
 * venue to show at all — the caller renders no mark rather than an
 * anonymous placeholder ring.
 */
export function resolveProtocolMark(
  protocol: string | null,
): ProtocolMarkResolution | null {
  if (protocol === null) return null;
  const trimmed = protocol.trim();
  if (trimmed.length === 0) return null;

  const curated = CURATED[trimmed.toLowerCase()];
  if (curated !== undefined) {
    return curated.src !== null
      ? { kind: "local", src: curated.src, label: curated.label }
      : {
          kind: "monogram",
          label: curated.label,
          initial: monogramInitial(curated.label),
        };
  }

  // Unrecognised venue: keep its own (bounded) text so the row still says who
  // it dealt with, and take the monogram — never a borrowed brand mark.
  const label = trimmed.slice(0, MAX_LABEL_CHARS);
  return { kind: "monogram", label, initial: monogramInitial(label) };
}
