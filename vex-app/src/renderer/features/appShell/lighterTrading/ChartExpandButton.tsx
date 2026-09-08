import { useEffect, useRef, type JSX } from "react";
import { IconFullscreen } from "../../../components/icons/index.js";

export function ChartExpandButton({ expanded, onToggle }: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const previousExpanded = useRef(expanded);
  useEffect(() => {
    if (previousExpanded.current && !expanded) buttonRef.current?.focus();
    previousExpanded.current = expanded;
  }, [expanded]);
  return (
    <button
      type="button"
      ref={buttonRef}
      className="lit-chart-expand"
      aria-label={expanded ? "Restore chart to workspace" : "Expand chart"}
      aria-pressed={expanded}
      title={expanded ? "Restore workspace · Esc" : "Expand chart"}
      onClick={onToggle}
    >
      <IconFullscreen size={16} />
    </button>
  );
}
