/**
 * shadcn-pattern Tabs primitive — owned source per skill §2 + codex
 * turn 8 answer #1. No Radix dependency. Pure CSS, pure React state,
 * full WAI-ARIA Tabs pattern: `role="tablist"`/`tab`/`tabpanel`,
 * `aria-selected`, `aria-controls`, roving tabindex, and keyboard
 * navigation (Arrow Left/Right, Home, End).
 *
 * Supports both controlled (`value` + `onValueChange`) and uncontrolled
 * (`defaultValue`) modes. Single-page usage is assumed — the
 * `id={`tab-${value}`}` pairing requires unique values across the
 * mounted DOM. Future Phase 2 panels with nested tabs should adopt a
 * scoped id helper.
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
}

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  children,
  className,
}: TabsProps): JSX.Element {
  const [internal, setInternal] = useState<string>(defaultValue ?? "");
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;
  const setValue = (next: string): void => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value: current, setValue }}>
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
        id={`tab-${value}`}
        aria-selected={isActive}
        aria-controls={`tabpanel-${value}`}
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
    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`tabpanel-${value}`}
        aria-labelledby={`tab-${value}`}
        hidden={!isActive}
        tabIndex={0}
        className={cn("mt-4 focus-visible:outline-none", className)}
        {...props}
      >
        {isActive ? children : null}
      </div>
    );
  }
);
TabsContent.displayName = "TabsContent";
