/** Editable OpenRouter model combobox with a bounded catalogue panel. */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  ChevronDownIcon,
  RefreshCwIcon,
  VexIcon,
} from "../../../../components/icons/index.js";
import type { ProviderModelOption } from "@shared/schemas/provider.js";
import { Input } from "../../../../components/ui/input.js";
import { cn } from "../../../../lib/utils.js";
import { formatModelMeta } from "./formatModelMeta.js";
import { ModelBrandIcon } from "./ModelBrandIcon.js";

const MAX_VISIBLE_RESULTS = 50;

function searchableText(model: ProviderModelOption): string {
  return `${model.displayName} ${model.modelId} ${model.providerId}`.toLowerCase();
}

export interface ModelPickerProps {
  readonly id: string;
  readonly value: string;
  readonly models: ReadonlyArray<ProviderModelOption>;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly disabled?: boolean;
  readonly onChange: (modelId: string) => void;
  readonly onRetry: () => void;
}

export function ModelPicker({
  id,
  value,
  models,
  loading,
  failed,
  disabled = false,
  onChange,
  onRetry,
}: ModelPickerProps): JSX.Element {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = value.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matches =
      query.length === 0
        ? models
        : models.filter((model) => searchableText(model).includes(query));
    return matches.slice(0, MAX_VISIBLE_RESULTS);
  }, [models, query]);
  const selected = useMemo(
    () => models.find((model) => model.modelId === value.trim()) ?? null,
    [models, value],
  );

  useEffect(() => setActiveIndex(0), [query, models]);
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const onDocumentMouseDown = (event: MouseEvent): void => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, [open]);

  const choose = useCallback(
    (model: ProviderModelOption): void => {
      onChange(model.modelId);
      setOpen(false);
    },
    [onChange],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      const count = filtered.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (!open) setOpen(true);
          else if (count > 0) setActiveIndex((index) => (index + 1) % count);
          break;
        case "ArrowUp":
          event.preventDefault();
          if (!open) setOpen(true);
          else if (count > 0) {
            setActiveIndex((index) => (index - 1 + count) % count);
          }
          break;
        case "Home":
          if (open && count > 0) {
            event.preventDefault();
            setActiveIndex(0);
          }
          break;
        case "End":
          if (open && count > 0) {
            event.preventDefault();
            setActiveIndex(count - 1);
          }
          break;
        case "Enter": {
          const active = filtered[activeIndex];
          if (open && active !== undefined) {
            event.preventDefault();
            choose(active);
          }
          break;
        }
        case "Escape":
          if (open) {
            event.preventDefault();
            setOpen(false);
          }
          break;
        case "Tab":
          if (open) setOpen(false);
          break;
        default:
          break;
      }
    },
    [activeIndex, choose, filtered, open],
  );

  const showPanel = open && !disabled;
  const active = filtered[activeIndex];
  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-expanded={showPanel}
          aria-controls={showPanel ? listboxId : undefined}
          aria-activedescendant={
            showPanel && active !== undefined
              ? `${listboxId}-option-${activeIndex}`
              : undefined
          }
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            loading ? "Loading tool-capable models…" : "Search models or enter an id"
          }
          value={value}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="pr-10 font-mono text-xs"
        />
        <VexIcon
          icon={ChevronDownIcon}
          size={15}
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] transition-transform",
            showPanel && "rotate-180",
          )}
        />
      </div>

      {selected !== null && !showPanel ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          <ModelBrandIcon modelId={selected.modelId} size={13} />
          <span>{selected.displayName}</span>
          {formatModelMeta(selected) ? <span>· {formatModelMeta(selected)}</span> : null}
        </p>
      ) : null}

      {showPanel ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="OpenRouter models"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground"
        >
          {loading ? (
            <p className="px-2.5 py-3 text-xs text-[var(--color-text-muted)]">
              Loading tool-capable models from OpenRouter…
            </p>
          ) : failed ? (
            <div className="flex items-center justify-between gap-3 px-2.5 py-2">
              <p className="text-xs text-[var(--color-text-secondary)]">
                Catalogue unavailable. Manual entry still works.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)]"
              >
                <VexIcon icon={RefreshCwIcon} size={12} aria-hidden />
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-2.5 py-3 text-xs text-[var(--color-text-muted)]">
              No match. Press Enter to use this model id.
            </p>
          ) : (
            filtered.map((model, index) => {
              const isActive = index === activeIndex;
              const isSelected = model.modelId === value.trim();
              return (
                <div
                  key={model.modelId}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model)}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2",
                    isActive
                      ? "bg-[var(--vex-accent-fill-12,color-mix(in_oklab,var(--color-accent-primary)_12%,transparent))] text-foreground"
                      : "text-[var(--color-text-secondary)]",
                  )}
                >
                  <ModelBrandIcon modelId={model.modelId} size={16} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{model.displayName}</span>
                    <span className="block truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                      {model.modelId}
                    </span>
                    {formatModelMeta(model) ? (
                      <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
                        {formatModelMeta(model)}
                      </span>
                    ) : null}
                  </span>
                  {isSelected ? (
                    <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--vex-accent,var(--color-accent-primary))]" />
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
