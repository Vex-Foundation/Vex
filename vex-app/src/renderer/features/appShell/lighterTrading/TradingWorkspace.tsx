import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 190;

export function TradingWorkspace({
  children,
  account,
  hasSession,
}: {
  readonly children: ReactNode;
  readonly account: ReactNode;
  readonly hasSession: boolean;
}): JSX.Element {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; height: number } | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [maxHeight, setMaxHeight] = useState(420);
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number): number => Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT, value)));

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (workspace === null) return;
    const resize = (): void => {
      if (workspace.clientHeight === 0) return;
      const max = Math.max(MIN_HEIGHT, Math.floor(workspace.clientHeight * 0.55));
      setMaxHeight(max);
      setHeight((current) => Math.min(current, max));
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={workspaceRef}
      className="lit-workspace"
      data-session-active={hasSession || undefined}
      data-resizing={dragging || undefined}
      style={{ "--lit-bottom-height": `${height}px` } as CSSProperties}
    >
      {children}
      <div className="lit-bottom-dock" id="lit-account-dock">
        <div
          className="lit-account-resizer"
          role="separator"
          tabIndex={0}
          aria-label="Resize account panel"
          aria-orientation="horizontal"
          aria-controls="lit-account-dock"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={maxHeight}
          aria-valuenow={height}
          aria-valuetext={`${height} pixels high`}
          title="Drag to resize · arrow keys to adjust · double-click to reset"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragRef.current = { y: event.clientY, height };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.focus({ preventScroll: true });
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag !== null) setHeight(clamp(drag.height + drag.y - event.clientY));
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onLostPointerCapture={() => {
            dragRef.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setDragging(false);
          }}
          onDoubleClick={() => setHeight(clamp(DEFAULT_HEIGHT))}
          onKeyDown={(event) => {
            const next = event.key === "ArrowUp" ? height + 24
              : event.key === "ArrowDown" ? height - 24
              : event.key === "Home" ? MIN_HEIGHT
              : event.key === "End" ? maxHeight
              : null;
            if (next === null) return;
            event.preventDefault();
            setHeight(clamp(next));
          }}
        />
        {account}
      </div>
    </div>
  );
}
