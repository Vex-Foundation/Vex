/**
 * The composer's model menu (F06), the model key inside the options frame
 * ("{model name} · Reasoning: {effort}", docs/design/R3-MINIMAL.md section
 * 7) for a resolved agent session.
 *
 * The key reads as the model's name with the provider mark, like the
 * display-only key; pressing it opens a menu UPWARD (the composer sits low on
 * the stage) with a search field, because a catalogue holds hundreds of
 * rows. Rows are grouped by vendor (`anthropic/`, `openai/`, `google/`), each
 * with its name, context window and input and output price per 1M in mono,
 * a "Default" tag on the configured default and the selected swatch on the
 * session's model. The footer keeps today's route to Settings, where the
 * default model and the key live.
 *
 * A pick is LOCAL until the next send (`uiStore.modelPickBySession`), like
 * the effort; the send carries it and main checks it. The menu is closed and
 * disabled while a turn runs, so a pick never changes under a running turn.
 *
 * Shrink warning: a model whose window is below what the conversation
 * already holds says so on its row; the engine compacts before the next
 * reply, so nothing else changes.
 *
 * Same physics and ARIA as `SelectMenu` (combobox + listbox, focus on the
 * search field, `aria-activedescendant`), the R3 menu card (one ink rule, no
 * shadow) and no inline styles (CSP `style-src 'self'`).
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { ModelOptionDto } from "@shared/schemas/models.js";
import { providerNameSchema } from "@shared/schemas/provider.js";
import { cn } from "../../../lib/utils.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { IconChevronDown } from "../../../components/icons/index.js";
import {
  PROVIDER_DISPLAY_NAME,
  ProviderMark,
} from "../../../components/common/ProviderMark.js";
import {
  formatContextLength,
  formatUsdPerMillion,
} from "../../wizard/steps/provider/formatModelMeta.js";
import { modelDisplayName } from "./model-display-name.js";

/** The provider mark's box beside the 13 px model name. */
const MARK_PX = 16;

const KEY_CLASS =
  "inline-flex h-7 min-w-0 items-center gap-1.5 font-sans text-[13px] leading-5 text-ink-primary transition-colors duration-100 hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-ink-tertiary";

export interface ComposerModelMenuProps {
  /** The model the next turn runs on (pending pick, session model or default). */
  readonly modelId: string;
  readonly options: readonly ModelOptionDto[];
  readonly onPick: (option: ModelOptionDto) => void;
  /** A turn is running: closed and not openable. */
  readonly disabled: boolean;
  /** The conversation's current size in tokens, for the shrink warning; `null` when unknown. */
  readonly conversationTokens: number | null;
  readonly onOpenSettings: () => void;
}

/** The row's figures: "200k ctx · $3 in / $15 out per 1M". */
function rowMeta(option: ModelOptionDto): string {
  const parts: string[] = [];
  if (option.contextLength !== null) parts.push(`${formatContextLength(option.contextLength)} ctx`);
  const prices: string[] = [];
  if (option.pricingInputPerMillion !== null) {
    prices.push(`${formatUsdPerMillion(option.pricingInputPerMillion)} in`);
  }
  if (option.pricingOutputPerMillion !== null) {
    prices.push(`${formatUsdPerMillion(option.pricingOutputPerMillion)} out`);
  }
  if (prices.length > 0) parts.push(`${prices.join(" / ")} per 1M`);
  return parts.join(" · ");
}

/** The vendor prefix a row groups under (`anthropic/claude-…` -> `anthropic`). */
function vendorOf(option: ModelOptionDto): string {
  const slash = option.modelId.indexOf("/");
  return slash > 0 ? option.modelId.slice(0, slash) : option.brand;
}

function matches(option: ModelOptionDto, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    option.modelId.toLowerCase().includes(needle) ||
    option.displayName.toLowerCase().includes(needle)
  );
}

interface Group {
  readonly vendor: string;
  readonly rows: readonly ModelOptionDto[];
}

/** Default first (its own group), then vendors in first-seen order. */
function groupRows(rows: readonly ModelOptionDto[]): readonly Group[] {
  const groups = new Map<string, ModelOptionDto[]>();
  for (const row of rows) {
    const key = row.isDefault ? "" : vendorOf(row);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  return [...groups.entries()].map(([vendor, list]) => ({ vendor, rows: list }));
}

export function ComposerModelMenu({
  modelId,
  options,
  onPick,
  disabled,
  conversationTokens,
  onOpenSettings,
}: ComposerModelMenuProps): JSX.Element {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const current = options.find((option) => option.modelId === modelId) ?? null;
  const name = modelDisplayName(current?.displayName ?? modelId);
  const backend = providerNameSchema.safeParse(current?.providerId);
  const served = backend.success ? ` on ${PROVIDER_DISPLAY_NAME[backend.data]}` : "";

  const visible = useMemo(() => options.filter((option) => matches(option, query.trim())), [options, query]);
  const groups = useMemo(() => groupRows(visible), [visible]);
  // Flat order for keyboard travel, the same order the groups draw.
  const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  // A run that starts while the menu is open closes it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    searchRef.current?.focus();
    const onDocMouseDown = (event: MouseEvent): void => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const openMenu = (): void => {
    if (disabled || options.length === 0) return;
    setQuery("");
    const selected = options.findIndex((option) => option.modelId === modelId);
    setActiveIndex(selected < 0 ? 0 : selected);
    setOpen(true);
  };

  const close = (): void => {
    setOpen(false);
    keyRef.current?.focus();
  };

  const choose = (option: ModelOptionDto | undefined): void => {
    if (option === undefined) return;
    onPick(option);
    close();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = flat.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (count > 0) setActiveIndex((i) => (i + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (count > 0) setActiveIndex((i) => (i - 1 + count) % count);
        break;
      case "Enter":
        // Never submits the composer form around it.
        event.preventDefault();
        choose(flat[activeIndex]);
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const optionId = (index: number): string => `${listboxId}-option-${index}`;
  let flatIndex = -1;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={keyRef}
        type="button"
        data-vex-area="composer-model-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${modelId}${served}. Opens the model menu.`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={cn("vex-composer-options__model", KEY_CLASS)}
      >
        {backend.success ? <ProviderMark provider={backend.data} size={MARK_PX} /> : null}
        <span data-vex-model-label className="min-w-0 max-w-48 flex-1 truncate">
          {name}
        </span>
        <IconChevronDown
          size={14}
          className={cn("shrink-0 text-ink-tertiary transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          data-vex-area="composer-model-menu"
          // The R3 menu card: the field, one 1px ink rule, no shadow. Floats
          // upward over the transcript and never pushes layout.
          className="absolute bottom-full left-0 z-30 mb-1 flex w-[min(30rem,calc(100vw-2rem))] flex-col border border-rule-ink bg-surface-field text-ink-primary"
        >
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-label="Search models"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={flat.length > 0 ? optionId(activeIndex) : undefined}
            placeholder="Search models"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            className="h-9 border-0 border-b border-rule-quiet bg-transparent px-3 text-[13.5px] text-ink-primary placeholder:text-ink-tertiary focus-visible:outline-none"
          />
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Models"
            className="vex-scroll-elevated max-h-72 overflow-y-auto py-1"
          >
            {flat.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-[13px] text-ink-tertiary">
                No model matches.
              </li>
            ) : null}
            {groups.map((group) => (
              <li key={group.vendor === "" ? "default" : group.vendor} role="presentation">
                <div
                  role="presentation"
                  className="px-3 pb-0.5 pt-1.5 text-[12px] text-ink-tertiary"
                >
                  {group.vendor === "" ? "Default" : group.vendor}
                </div>
                <ul role="group" aria-label={group.vendor === "" ? "Default" : group.vendor}>
                  {group.rows.map((option) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const active = index === activeIndex;
                    const selected = option.modelId === modelId;
                    const shrinks =
                      conversationTokens !== null &&
                      option.contextLength !== null &&
                      option.contextLength < conversationTokens;
                    const meta = rowMeta(option);
                    return (
                      <li
                        key={option.modelId}
                        id={optionId(index)}
                        role="option"
                        aria-selected={selected}
                        data-vex-model-option={option.modelId}
                        onMouseEnter={() => setActiveIndex(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(option)}
                        className={cn(
                          "flex cursor-pointer flex-col gap-0.5 px-3 py-1.5",
                          active ? "bg-interactive-hover" : undefined,
                          selected && !active && "bg-interactive-active",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2 text-[13.5px] text-ink-primary">
                          <span className="min-w-0 truncate">{modelDisplayName(option.displayName)}</span>
                          {option.isDefault ? (
                            <span className="shrink-0 text-[12px] text-ink-tertiary">Default</span>
                          ) : null}
                          {selected ? (
                            <Swatch state="done" size={8} className="ml-auto shrink-0 text-accent-primary" />
                          ) : null}
                        </span>
                        {meta.length > 0 ? (
                          <span className="vex-num truncate font-mono text-[11.5px] text-ink-secondary">{meta}</span>
                        ) : null}
                        {shrinks ? (
                          <span data-vex-model-shrink className="text-[12px] text-ink-secondary">
                            This conversation is longer than this model holds. Vex compacts it before the next reply.
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="h-8 border-t border-rule-quiet px-3 text-left text-[12.5px] text-ink-secondary hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Default model and key in Settings
          </button>
        </div>
      ) : null}
    </div>
  );
}
