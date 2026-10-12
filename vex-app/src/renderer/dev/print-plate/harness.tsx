/**
 * PRINT PLATE HARNESS: one `PrintPlate` where the product will put it, for a
 * visual check of the five agent states against the design renders
 * (`docs/design/V10-SPREAD.md section 6`).
 *
 * DEV SCAFFOLDING, NEVER A SHIPPED SURFACE. Nothing in `main.tsx` imports
 * this module and `vite.renderer.config.ts` builds only its listed HTML
 * inputs, so no byte of it reaches a packaged build. The renderer dev server
 * serves it at `/dev/print-plate/index.html`.
 *
 * The URL decides everything:
 *   ?state=idle|live|running|awaiting|paused   the agent state (idle)
 *   ?layout=page|stage                         the left page or the full window (page)
 *   ?width=300                                 the page width; under 120 it is the spine
 *   ?theme=celeris|chronos                     the day or the night print (celeris)
 *   ?pose=x,y,frac,cell                        stage only: where the eagle sits
 * Reduced motion is the browser's own preference (emulate it for the still
 * frame). The canvas carries `data-ready` once its first frame is painted.
 */

import { StrictMode, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { DESK_AGENT_STATES, type DeskAgentState } from "../../components/pixel/agent-state.js";
import { PrintPlate } from "../../components/pixel/PrintPlate.js";
import { STAGE_POSE, type StagePose } from "../../components/pixel/flock-engine.js";
import "../../styles/globals.css";

const params = new URLSearchParams(window.location.search);

function stateParam(): DeskAgentState {
  const raw = params.get("state");
  return DESK_AGENT_STATES.find((s) => s === raw) ?? "idle";
}

function poseParam(): StagePose {
  const parts = (params.get("pose") ?? "").split(",").map(Number);
  const [x, y, frac, cell] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return STAGE_POSE;
  return { x: x ?? STAGE_POSE.x, y: y ?? STAGE_POSE.y, frac: frac ?? STAGE_POSE.frac, cell: cell ?? STAGE_POSE.cell };
}

document.documentElement.dataset.vexTheme =
  params.get("theme") === "chronos" ? "chronos" : "celeris";

function Harness(): JSX.Element {
  const state = stateParam();
  if (params.get("layout") === "stage") {
    return <PrintPlate state={state} layout="stage" stagePose={poseParam()} className="fixed inset-0" />;
  }
  const raw = Number(params.get("width") ?? "300");
  const width = Number.isFinite(raw) && raw > 0 ? raw : 300;
  // The page sits at the window's top left corner, as the left page does.
  return (
    <div data-vex-harness-page="" className="fixed left-0 top-0 h-screen" style={{ width }}>
      <PrintPlate state={state} className="size-full" />
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
