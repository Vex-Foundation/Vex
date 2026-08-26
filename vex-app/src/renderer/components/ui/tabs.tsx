/**
 * shadcn-pattern Tabs primitive — owned source per skill §2 + codex
 * turn 8 answer #1. No Radix dependency. Pure CSS, pure React state,
 * full WAI-ARIA Tabs pattern: `role="tablist"`/`tab`/`tabpanel`,
 * `aria-selected`, `aria-controls`, roving tabindex, and keyboard
 * navigation (Arrow Left/Right, Home, End).
 *
 * Supports both controlled (`value` + `onValueChange`) and uncontrolled
 * (`defaultValue`) modes. Ids are unscoped by default (`tab-<value>`), which
 * requires unique values across the mounted DOM; nested or repeated tab sets
 * pass `idScope` to namespace them. Inactive panels unmount their children by
 * default; `keepMounted` keeps them in the DOM, hidden and inert, for panels
 * whose state must survive a tab switch. Both are additive: omitting them
 * reproduces the original behaviour exactly.
 */

import {
  createContext,
  forwardRef,
  useContext,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils.js";

interface TabsContextValue {
  readonly value: string;
  readonly setValue: (next: string) => void;
  /**
   * Prefix inserted into every generated id, or "" for the historical
   * unscoped ids. See {@link TabsProps.idScope}.
   */
  readonly idPrefix: string;
  /** See {@link TabsProps.keepMounted}. */
  readonly keepMounted: boolean;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (ctx === null) {
    throw new Error("Tabs.* must be used inside a <Tabs> root.");
  }
  return ctx;
}

export interface TabsProps {
  readonly defaultValue?: string;
  readonly value?: string;
  readonly onValueChange?: (value: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * Namespace for this tab set's generated ids.
   *
   * The unscoped ids (`tab-portfolio` / `tabpanel-portfolio`) require unique
   * VALUES across the mounted DOM, which nested tab sets break: two panels
   * called "overview" would claim one id and `aria-controls` would point at
   * whichever mounted first. Passing a scope makes the ids
   * `tab-<scope>-<value>`; omitting it keeps the exact historical ids, so
   * every existing consumer is unchanged.
   */
  readonly idScope?: string;
  /**
   * Keep inactive panels MOUNTED (hidden, `aria-hidden`, `inert`) instead of
   * unmounting their children.
   *
   * Default false, which is the historical behaviour: an inactive panel
   * renders no children. Opt in when a panel owns state that must survive a
   * tab switch (a scroll offset, a running query, a partly filled form);
   * leave it off when the panel is cheap and its children hold live
   * subscriptions that should stop while nobody is looking.
   */
  readonly keepMounted?: boolean;
}

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  children,
  className,
  idScope,
  keepMounted = false,
}: TabsProps): JSX.Element {
  const [internal, setInternal] = useState<string>(defaultValue ?? "");
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;
  const setValue = (next: string): void => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  };
  const idPrefix = idScope === undefined ? "" : `${idScope}-`;
  return (
    <TabsContext.Provider value={{ value: current, setValue, idPrefix, keepMounted }}>
      <div className={cn("flex flex-col", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export const TabsList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="tablist"
      // Transparent rail bounded by a hairline, never a filled muted slab.
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-line-3 bg-transparent p-1 text-ink-tertiary",
        className
      )}
      {...props}
    />
  )
);
TabsList.displayName = "TabsList";

export interface TabsTriggerProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  readonly value: string;
}

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, onKeyDown, ...props }, ref) => {
    const ctx = useTabsContext();
    const isActive = ctx.value === value;
    const localRef = useRef<HTMLButtonElement | null>(null);

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (
        event.key === "ArrowRight" ||
        event.key === "ArrowLeft" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        event.preventDefault();
        const list = localRef.current?.parentElement;
        if (!list) return;
        const triggers = Array.from(
          list.querySelectorAll<HTMLButtonElement>('[role="tab"]')
        );
        const currentIdx = localRef.current
          ? triggers.indexOf(localRef.current)
          : -1;
        if (currentIdx < 0 || triggers.length === 0) return;
        let nextIdx = currentIdx;
        if (event.key === "ArrowRight") {
          nextIdx = (currentIdx + 1) % triggers.length;
        } else if (event.key === "ArrowLeft") {
          nextIdx = (currentIdx - 1 + triggers.length) % triggers.length;
        } else if (event.key === "Home") {
          nextIdx = 0;
        } else if (event.key === "End") {
          nextIdx = triggers.length - 1;
        }
        const next = triggers[nextIdx];
        if (next) {
          const nextValue = next.dataset["tabValue"];
          if (nextValue) ctx.setValue(nextValue);
          next.focus();
        }
      }
      onKeyDown?.(event);
    };

    return (
      <button
        ref={(node) => {
          localRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref !== null) ref.current = node;
        }}
        type="button"
        role="tab"
        id={`tab-${ctx.idPrefix}${value}`}
        aria-selected={isActive}
        aria-controls={`tabpanel-${ctx.idPrefix}${value}`}
        tabIndex={isActive ? 0 : -1}
        data-tab-value={value}
        onClick={() => ctx.setValue(value)}
        onKeyDown={handleKeyDown}
        // Chrome-register triggers (13/20 max w500); the active tab is a
        // quiet interactive wash, not a shadowed slab.
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-[13px] leading-5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive
            ? "bg-interactive-active text-ink-primary"
            : "text-ink-tertiary hover:text-ink-primary",
          className
        )}
        {...props}
      />
    );
  }
);
TabsTrigger.displayName = "TabsTrigger";

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  readonly value: string;
}

export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(
  ({ value, className, children, ...props }, ref) => {
    const ctx = useTabsContext();
    const isActive = ctx.value === value;
    // KEEP-MOUNTED: the panel stays in the DOM with its state intact, and is
    // taken out of the accessibility tree and out of the tab order the same
    // way the browser would - `hidden` alone leaves it discoverable to some
    // assistive tech, so `aria-hidden` and `inert` ride with it. Focus cannot
    // land inside an inert subtree, so the panel itself drops out of the tab
    // order too while it is not the selected one.
    const dormant = ctx.keepMounted && !isActive;
    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`tabpanel-${ctx.idPrefix}${value}`}
        aria-labelledby={`tab-${ctx.idPrefix}${value}`}
        hidden={!isActive}
        aria-hidden={dormant ? true : undefined}
        inert={dormant ? true : undefined}
        tabIndex={0}
        className={cn("mt-4 focus-visible:outline-none", className)}
        {...props}
      >
        {isActive || ctx.keepMounted ? children : null}
      </div>
    );
  }
);
TabsContent.displayName = "TabsContent";
