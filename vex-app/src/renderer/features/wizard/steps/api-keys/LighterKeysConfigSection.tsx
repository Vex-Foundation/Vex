import { useId, useState, type JSX, type ReactNode } from "react";
import { IconChevronDown } from "../../../../components/icons/index.js";
import { cn } from "../../../../lib/utils.js";
import {
  ProviderStatusWord,
  type ProviderCardStatusTone,
} from "./ProviderCard.js";

/**
 * The Lighter disclosure row of the API keys list: the provider-row grammar
 * (name, what it holds, a swatch and its word at the right) as one key that
 * opens the group of Lighter settings under it.
 */
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
  const tone: ProviderCardStatusTone =
    configuredCount >= 2 ? "set" : configuredCount === 1 ? "partial" : "unset";

  return (
    <section
      // Closed, the row closes on its own quiet rule; open, the last row of
      // the group under it draws that rule.
      className={cn(!open && "border-b border-rule-quiet")}
      data-vex-lighter-keys-config
    >
      <button
        type="button"
        className={cn(
          "flex w-full flex-wrap items-baseline gap-x-2.5 gap-y-1 py-[13px] text-left",
          "focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus",
        )}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <span id={titleId} className="vex-wz-prov__n">
          Lighter Keys Config
        </span>
        <span className="vex-wz-prov__dsc">
          RHC, Core, and stored wallet connections
        </span>
        <ProviderStatusWord
          status={{ tone, label: `${configuredCount}/2 configured` }}
        />
        <IconChevronDown
          size={16}
          className={cn(
            "shrink-0 self-center text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        id={contentId}
        role="region"
        aria-labelledby={titleId}
        hidden={!open}
        className={open ? "flex flex-col" : "hidden"}
      >
        {children}
      </div>
    </section>
  );
}
