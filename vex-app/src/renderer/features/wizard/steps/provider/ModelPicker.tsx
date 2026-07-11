/** Searchable, editable OpenRouter model combobox for provider setup. */

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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { ProviderModelOption } from "@shared/schemas/provider.js";
import { Input } from "../../../../components/ui/input.js";
import { cn } from "../../../../lib/utils.js";
import { ModelBrandIcon } from "./ModelBrandIcon.js";

const MAX_VISIBLE_RESULTS = 60;

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function compactPrice(value: number | null): string | null {
  if (value === null) return null;
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(3)}`;
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

function modelMeta(model: ProviderModelOption): string {
  const parts: string[] = [];
  if (model.contextLength !== null) {
    parts.push(`${compactNumber(model.contextLength)} context`);
  }
  const input = compactPrice(model.pricingInputPerMillion);
  const output = compactPrice(model.pricingOutputPerMillion);
  if (input !== null && output !== null) {
    parts.push(`${input} in · ${output} out / 1m`);
  }
  return parts.join(" · ");
}

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

  const normalizedQuery = value.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matches =
      normalizedQuery.length === 0
        ? models
        : models.filter((model) => searchableText(model).includes(normalizedQuery));
    return matches.slice(0, MAX_VISIBLE_RESULTS);
  }, [models, normalizedQuery]);

  const selected = useMemo(
    () => models.find((model) => model.modelId === value) ?? null,
    [models, value],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onDocumentMouseDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery]);

  const choose = useCallback(
    (model: ProviderModelOption): void => {
      onChange(model.modelId);
      setOpen(false);
    },
    [onChange],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!open) setOpen(true);
        else if (filtered.length > 0) {
          setActiveIndex((index) => (index + 1) % filtered.length);
        }
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) setOpen(true);
        else if (filtered.length > 0) {
          setActiveIndex(
            (index) => (index - 1 + filtered.length) % filtered.length,
          );
        }
        return;
      }
      if (event.key === "Enter" && open && filtered[activeIndex] !== undefined) {
        event.preventDefault();
        choose(filtered[activeIndex]);
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
      }
    },
    [activeIndex, choose, filtered, open],
  );

  const showPanel = open && !disabled;

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
            showPanel && filtered[activeIndex] !== undefined
              ? `${listboxId}-option-${activeIndex}`
              : undefined
          }
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={loading ? "Loading tool-capable models…" : "Search models or enter an id"}
          value={value}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="pr-10 font-mono text-[12px]"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[var(--color-text-muted)]"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={15}
            className={cn("transition-transform", showPanel && "rotate-180")}
          />
        </span>
      </div>

      {selected !== null && !showPanel ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
          <ModelBrandIcon modelId={selected.modelId} size={13} />
          <span>{selected.displayName}</span>
          {modelMeta(selected) ? <span>· {modelMeta(selected)}</span> : null}
        </p>
      ) : null}

      {showPanel ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="OpenRouter models"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-white/[0.1] bg-[var(--color-bg-overlay)] p-1"
        >
          {loading ? (
            <p className="px-3 py-3 text-xs text-[var(--color-text-muted)]">
              Loading tool-capable models from OpenRouter…
            </p>
          ) : failed ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <p className="text-xs text-[var(--color-text-secondary)]">
                Catalogue unavailable. You can still enter a model id manually.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-onboarding-accent)] hover:underline"
              >
                <HugeiconsIcon icon={RefreshIcon} size={12} aria-hidden />
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-3 text-xs text-[var(--color-text-muted)]">
              No catalogue match. Keep typing to use a custom model id.
            </p>
          ) : (
            filtered.map((model, index) => {
              const active = index === activeIndex;
              const isSelected = model.modelId === value;
              const meta = modelMeta(model);
              return (
                <div
                  key={model.modelId}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model)}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2",
                    active
                      ? "bg-[color-mix(in_oklab,var(--vex-onboarding-accent)_12%,transparent)]"
                      : "hover:bg-white/[0.035]",
                  )}
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.025]">
                    <ModelBrandIcon modelId={model.modelId} size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--color-text-primary)]">
                      {model.displayName}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                      {model.modelId}
                    </span>
                    {meta ? (
                      <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                        {meta}
                      </span>
                    ) : null}
                  </span>
                  {isSelected ? (
                    <span
                      aria-hidden
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--vex-onboarding-accent)]"
                    />
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
