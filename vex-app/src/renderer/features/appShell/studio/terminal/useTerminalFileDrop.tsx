import { useEffect, useState, type DragEvent, type JSX } from "react";

export function useTerminalFileDrop(visible: boolean, insertFiles: (files: readonly File[]) => void): {
  readonly handlers: {
    readonly onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
    readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void;
    readonly onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
    readonly onDrop: (event: DragEvent<HTMLDivElement>) => void;
  };
  readonly overlay: JSX.Element | null;
} {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!visible) setActive(false);
    const clear = (): void => setActive(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
    };
  }, [visible]);
  const over = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.types).includes("Files");
    event.dataTransfer.dropEffect = files && visible ? "copy" : "none";
    setActive(files && visible);
  };
  return {
    handlers: {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setActive(false);
      },
      onDrop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        setActive(false);
        if (visible) insertFiles(Array.from(event.dataTransfer.files));
      },
    },
    overlay: active ? (
      <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border border-accent-primary bg-surface-2 text-ink-primary" role="status">
        <span className="text-sm font-medium">Drop files to insert their paths</span>
        <span className="text-xs text-ink-secondary">Up to 32 files. Press Enter yourself to run.</span>
      </div>
    ) : null,
  };
}
