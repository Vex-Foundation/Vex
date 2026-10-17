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
 *   ?emotion=idle|working|...             what she shows of the agent (idle)
 *   ?w=256&h=280                          the host's size; stage fills the window by default,
 *                                         sidebar is 256 x 280, welcome 284 x 284
 *   ?wake=1                               the wake from the token
 *   ?g=blow|bird|giggle                   that gesture 1 s after she is awake
 *   ?hover=1                              the pointer on her
 *   ?still                                the still frame (reduced motion is the browser's own)
 * The host carries `data-vex-k2-ready` once her first frame is painted.
 */

import { StrictMode, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { K2_EMOTIONS, type K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import type { K2Ground } from "../../components/vex/k2/k2-engine.js";
import type { K2PlacementName } from "../../components/vex/k2/k2-rig.js";
import type { GestureName } from "../../components/vex/k2/k2-time.js";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
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
const gesture = pick<GestureName | "none">("g", ["blow", "bird", "giggle", "none"], "none");
const chronos = params.get("theme") === "chronos";

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

function Harness(): JSX.Element {
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
        emotion={emotion}
        still={params.has("still")}
        wake={params.get("wake") === "1"}
        hover={params.get("hover") === "1"}
        force={gesture === "none" ? null : gesture}
        className="absolute inset-0"
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
