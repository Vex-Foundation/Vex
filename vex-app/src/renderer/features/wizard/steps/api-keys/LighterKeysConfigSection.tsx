import { useId, useState, type JSX, type ReactNode } from "react";
import {
  IconChevronDown,
  IconKey,
} from "../../../../components/icons/index.js";
import { cn } from "../../../../lib/utils.js";

export function LighterKeysConfigSection({
  configuredCount,
  children,
}: {
  readonly configuredCount: number;
  readonly children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const titleId = useId();

  return (
    <section
      className="border-y border-line-1"
      data-vex-lighter-keys-config
    >
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-3 py-4 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center text-ink-primary"
        >
          <IconKey size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            id={titleId}
            className="block text-sm font-semibold text-ink-primary"
          >
            Lighter Keys Config
          </span>
          <span className="mt-0.5 block text-xs leading-[18px] text-ink-secondary">
            RHC, Core, and stored wallet connections
          </span>
        </span>
        <span className="shrink-0 text-xs text-ink-tertiary">
          {configuredCount}/2 configured
        </span>
        <IconChevronDown
          size={16}
          className={cn(
            "shrink-0 text-ink-tertiary transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        id={contentId}
        role="region"
        aria-labelledby={titleId}
        hidden={!open}
        className={open ? "flex flex-col gap-4 pb-1" : "hidden"}
      >
        {children}
      </div>
    </section>
  );
}
