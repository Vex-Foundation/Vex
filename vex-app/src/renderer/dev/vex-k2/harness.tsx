/**
 * VEX K2 HARNESS: one `VexK2` in a host of the size the product gives her, over the ground she
 * stands on, for a visual check of the portrait, the beam and the token against the design renders
 * (`docs/design/R3-MINIMAL.md section 10`).
 *
 * DEV SCAFFOLDING, NEVER A SHIPPED SURFACE. Nothing in `main.tsx` imports this module and
 * `vite.renderer.config.ts` builds only its listed HTML inputs, so no byte of it reaches a packaged
 * build. The renderer dev server serves it at `/dev/vex-k2/index.html`.
 *
 * The URL decides everything:
 *   ?placement=stage|sidebar|welcome      where she stands (stage)
 *   ?ground=print|paper|night             what she stands on (print)
 *   ?theme=celeris|chronos                the room (celeris)
 *   ?emotion=idle|working|...             what she shows of the agent (idle); approval drops the
 *                                         bust's cut for the palm
 *   ?w=256&h=280                          the host's size; stage fills the window by default,
 *                                         sidebar is 256 x 280, welcome 284 x 284
 *   ?wake=1                               the wake from the token
 *   ?g=blow|bird|giggle|blush|hum         that gesture 1 s after she is awake
 *   ?hover=1                              the pointer on her
 *   ?still                                the still frame (reduced motion is the browser's own)
 *   ?open=1                               the open episode from the token (the sidebar's dock)
 *   ?closed=1                             she starts closed: the token alone, face-on
 *   ?seq=sleep-wake                       from `emotion`, asleep at 4 s, the re-wake at 10 s
 *   ?seq=open-close                       open at once, closed into the token at 6 s, open
 *                                         again at 9 s
 *   ?status=1                             the avatar off: the token and its ring with the word,
 *                                         every state, beside (sidebar) and under (welcome)
 * The host carries `data-vex-k2-ready` once her first frame is painted.
 */

import { StrictMode, useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { K2_EMOTIONS, type K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import type { K2Ground } from "../../components/vex/k2/k2-engine.js";
import type { K2PlacementName } from "../../components/vex/k2/k2-rig.js";
import type { GestureName } from "../../components/vex/k2/k2-time.js";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
import { StateWord } from "../../components/ui/state-word.js";
import { VexStatus } from "../../features/vex/VexStatus.js";
import { VEX_STATE_FILL, VEX_STATES, vexWordOf } from "../../features/vex/vex-state.js";
import { useUiStore } from "../../stores/uiStore.js";
import "../../styles/globals.css";

const params = new URLSearchParams(window.location.search);

function pick<T extends string>(name: string, options: readonly T[], fallback: T): T {
  const raw = params.get(name);
  return options.find((o) => o === raw) ?? fallback;
}

function size(name: string, fallback: number): number {
  const raw = Number(params.get(name) ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const placement = pick<K2PlacementName>("placement", ["stage", "sidebar", "welcome"], "stage");
const ground = pick<K2Ground>("ground", ["print", "paper", "night"], "print");
const emotion = pick<K2Emotion>("emotion", K2_EMOTIONS, "idle");
const gesture = pick<GestureName | "none">(
  "g",
  ["blow", "bird", "giggle", "blush", "hum", "none"],
  "none",
);
const chronos = params.get("theme") === "chronos";
const seq = pick<"sleep-wake" | "open-close" | "none">(
  "seq",
  ["sleep-wake", "open-close", "none"],
  "none",
);

document.documentElement.dataset["vexTheme"] = chronos ? "chronos" : "celeris";
useUiStore.setState({ theme: chronos ? "chronos" : "celeris" });

function Ground(): JSX.Element {
  if (ground === "print") {
    return (
      <img
        alt=""
        src={chronos ? "/art/plateau-night.jpg" : "/art/plateau.jpg"}
        className="absolute inset-0 size-full object-cover"
      />
    );
  }
  return <div className="absolute inset-0 bg-surface-base" />;
}

/** A sequence's emotion and closed flag over time (wall clock, a dev review only). */
function useSequence(): { readonly emotion: K2Emotion; readonly closed: boolean } {
  const [now, setNow] = useState<{ emotion: K2Emotion; closed: boolean }>({
    emotion,
    closed: params.get("closed") === "1",
  });
  useEffect(() => {
    const steps: [number, Partial<{ emotion: K2Emotion; closed: boolean }>][] =
      seq === "sleep-wake"
        ? [
            [4000, { emotion: "sleeping" }],
            [10000, { emotion }],
          ]
        : seq === "open-close"
          ? [
              [6000, { closed: true }],
              [9000, { closed: false }],
            ]
          : [];
    const ids = steps.map(([at, change]) =>
      window.setTimeout(() => setNow((cur) => ({ ...cur, ...change })), at),
    );
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, []);
  return now;
}

/** The avatar off: every state's token, ring and word, as the sidebar and the welcome show them. */
function StatusSheet(): JSX.Element {
  return (
    <div data-vex-harness-status="" className="grid grid-cols-2 gap-x-12 gap-y-4 bg-surface-base p-8">
      {VEX_STATES.map((state) => (
        <div key={state} className="contents">
          <VexStatus state={state}>
            <StateWord
              state={VEX_STATE_FILL[state]}
              word={vexWordOf(state)}
              scope="This chat:"
              size={12}
              className="text-[15px] font-medium"
            />
          </VexStatus>
          <VexStatus state={state} layout="stack">
            <StateWord
              state={VEX_STATE_FILL[state]}
              word={vexWordOf(state)}
              className="mt-2 text-[13px] text-ink-secondary"
            />
          </VexStatus>
        </div>
      ))}
    </div>
  );
}

function Harness(): JSX.Element {
  const { emotion: shown, closed } = useSequence();
  const stage = placement === "stage";
  const width = size("w", stage ? window.innerWidth : placement === "sidebar" ? 256 : 284);
  const height = size("h", stage ? window.innerHeight : placement === "sidebar" ? 280 : 284);
  return (
    <div
      data-vex-harness-k2=""
      className="fixed left-0 top-0 overflow-hidden"
      style={{ width, height }}
    >
      <Ground />
      <VexK2
        placement={placement}
        ground={ground}
        emotion={shown}
        still={params.has("still")}
        wake={params.get("wake") === "1"}
        hover={params.get("hover") === "1"}
        force={gesture === "none" ? null : gesture}
        open={params.get("open") === "1" || seq === "open-close"}
        closed={closed}
        className="absolute inset-0"
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      {params.get("status") === "1" ? <StatusSheet /> : <Harness />}
    </StrictMode>,
  );
}
