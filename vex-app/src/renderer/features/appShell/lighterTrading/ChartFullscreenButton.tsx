import { useEffect, useState, type JSX } from "react";
import { IconFullscreen } from "../../../components/icons/index.js";

export function ChartFullscreenButton(): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const changed = (): void => setExpanded(document.fullscreenElement?.classList.contains("lit-chart-panel") === true);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  if (!document.fullscreenEnabled) return null;
  return (
    <button
      type="button"
      className="lit-chart-fullscreen"
      aria-label={expanded ? "Restore chart to workspace" : "Expand chart"}
      title={error ? "Chart could not expand. Try again." : expanded ? "Restore workspace · Esc" : "Expand chart"}
      onClick={(event) => {
        const panel = event.currentTarget.closest<HTMLElement>(".lit-chart-panel");
        if (panel === null) return;
        setError(false);
        const operation = document.fullscreenElement === panel ? document.exitFullscreen() : panel.requestFullscreen();
        void operation.catch(() => setError(true));
      }}
    >
      <IconFullscreen size={16} />
    </button>
  );
}
