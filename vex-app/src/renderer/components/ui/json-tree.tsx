/**
 * Read-only collapsible JSON inspector tree (chat tool ledger's payload
 * viewer). Renders parsed JSON as keyboard-accessible rows — expander per
 * container, inline preview while collapsed, `.vex-code-*` token classes for
 * values — plus one "copy raw" key that writes the pretty-printed source.
 * React nodes only; payload text never becomes HTML.
 */

import { useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { IconCheck, IconCopy } from "../icons/index.js";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";
import { cn } from "../../lib/utils.js";

const OBJECT_PREVIEW_LIMIT = 4;
const ARRAY_PREVIEW_LIMIT = 5;
const PREVIEW_DEPTH_LIMIT = 2;

function isContainer(value: unknown): value is object | readonly unknown[] {
  return typeof value === "object" && value !== null;
}

function entriesOf(
  value: object | readonly unknown[],
): readonly (readonly [string, unknown])[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item] as const);
  }
  return Object.keys(value).map(
    (key) => [key, (value as Record<string, unknown>)[key]] as const,
  );
}

function bracketsOf(value: object | readonly unknown[]): readonly [string, string] {
  return Array.isArray(value) ? ["[", "]"] : ["{", "}"];
}

function PrimitiveValue({ value }: { readonly value: unknown }): JSX.Element {
  if (value === null) return <span className="vex-code-keyword">null</span>;
  switch (typeof value) {
    case "string":
      return <span className="vex-code-string">{JSON.stringify(value)}</span>;
    case "number":
      return <span className="vex-code-number">{String(value)}</span>;
    case "boolean":
      return <span className="vex-code-keyword">{String(value)}</span>;
    default:
      // JSON.parse output can carry none of these, but a caller-supplied
      // object might; render descriptively rather than crash.
      return <span className="text-[var(--vex-text-3)]">{String(value)}</span>;
  }
}

function Preview({
  value,
  depth,
}: {
  readonly value: unknown;
  readonly depth: number;
}): JSX.Element {
  if (!isContainer(value)) return <PrimitiveValue value={value} />;
  const array = Array.isArray(value);
  const entries = entriesOf(value);
  const limit = array ? ARRAY_PREVIEW_LIMIT : OBJECT_PREVIEW_LIMIT;
  const visible = entries.filter((_, i) => i < limit);
  const [open, close] = bracketsOf(value);
  return (
    <>
      <span className="text-[var(--vex-text-3)]">{open}</span>
      {depth >= PREVIEW_DEPTH_LIMIT ? (
        <span className="text-[var(--vex-text-3)]">…</span>
      ) : (
        visible.map(([key, item], index) => (
          <span key={key}>
            {index > 0 ? <span className="text-[var(--vex-text-3)]">, </span> : null}
            {!array ? (
              <>
                <span className="vex-code-property">{key}</span>
                <span className="text-[var(--vex-text-3)]">: </span>
              </>
            ) : null}
            <Preview value={item} depth={depth + 1} />
          </span>
        ))
      )}
      {depth < PREVIEW_DEPTH_LIMIT && entries.length > limit ? (
        <span className="text-[var(--vex-text-3)]">, …</span>
      ) : null}
      <span className="text-[var(--vex-text-3)]">{close}</span>
    </>
  );
}

/** Roving focus across the tree's expanders with ArrowUp/ArrowDown. */
function moveExpanderFocus(current: HTMLElement, direction: -1 | 1): void {
  const tree = current.closest<HTMLElement>('[role="tree"]');
  if (tree === null) return;
  const expanders = Array.from(
    tree.querySelectorAll<HTMLElement>("[data-vex-json-expander]"),
  );
  const index = expanders.indexOf(current);
  if (index < 0 || expanders.length === 0) return;
  const next = expanders[(index + direction + expanders.length) % expanders.length];
  next?.focus();
}

function JsonTreeNode({
  field,
  value,
  lastElement,
  initialExpanded,
}: {
  readonly field?: string;
  readonly value: unknown;
  readonly lastElement: boolean;
  readonly initialExpanded: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(initialExpanded);
  const container = isContainer(value);
  const entries = container ? entriesOf(value) : [];
  const expandable = entries.length > 0;

  const onExpanderKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      setExpanded(event.key === "ArrowRight");
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      moveExpanderFocus(event.currentTarget, event.key === "ArrowUp" ? -1 : 1);
    }
  };

  const fieldNode: ReactNode =
    field === undefined ? null : (
      <span
        className={cn("vex-code-property", expandable && "cursor-pointer")}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
      >
        {field === "" ? '""' : field}
        <span className="text-[var(--vex-text-3)]">: </span>
      </span>
    );

  if (!container || !expandable) {
    const [open, close] = container ? bracketsOf(value) : ["", ""];
    return (
      <div role="treeitem" className="pl-4">
        {fieldNode}
        {container ? (
          <span className="text-[var(--vex-text-3)]">{`${open}${close}`}</span>
        ) : (
          <PrimitiveValue value={value} />
        )}
        {!lastElement ? <span className="text-[var(--vex-text-3)]">,</span> : null}
      </div>
    );
  }

  const [open, close] = bracketsOf(value);
  return (
    <div role="treeitem" aria-expanded={expanded} className="pl-4">
      <button
        type="button"
        data-vex-json-expander=""
        aria-label={expanded ? "Collapse JSON node" : "Expand JSON node"}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={onExpanderKeyDown}
        className="-ml-3.5 mr-0.5 inline-flex w-3 select-none justify-center text-[var(--vex-text-3)] focus-visible:outline-none focus-visible:text-[var(--vex-accent)]"
      >
        {expanded ? "▾" : "▸"}
      </button>
      {fieldNode}
      {expanded ? (
        <>
          <span className="text-[var(--vex-text-3)]">{open}</span>
          <div role="group">
            {entries.map(([key, item], index) => (
              <JsonTreeNode
                key={key}
                field={Array.isArray(value) ? undefined : key}
                value={item}
                lastElement={index === entries.length - 1}
                initialExpanded={false}
              />
            ))}
          </div>
          <span className="text-[var(--vex-text-3)]">{close}</span>
        </>
      ) : (
        <Preview value={value} depth={0} />
      )}
      {!lastElement ? <span className="text-[var(--vex-text-3)]">,</span> : null}
    </div>
  );
}

export function JsonTree({
  data,
  label = "JSON",
  className,
}: {
  /** Parsed JSON object or array. */
  readonly data: object | readonly unknown[];
  /** Accessible label for the tree. */
  readonly label?: string;
  readonly className?: string;
}): JSX.Element {
  const { copied, onCopy } = useCopyFeedback(JSON.stringify(data, null, 2));
  return (
    <div
      data-vex-json-tree=""
      className={cn(
        "group/json relative font-mono text-[11px] leading-relaxed text-[var(--vex-text-2)]",
        className,
      )}
    >
      <button
        type="button"
        aria-label={copied ? "JSON copied" : "Copy raw JSON"}
        onClick={onCopy}
        className="absolute right-0 top-0 inline-flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--vex-text-3)] opacity-0 transition-opacity duration-100 hover:bg-interactive-hover focus-visible:opacity-100 focus-visible:outline-none group-hover/json:opacity-100"
      >
        {copied ? <IconCheck size={12} aria-hidden /> : <IconCopy size={12} aria-hidden />}
      </button>
      <div role="tree" aria-label={label} className="-ml-4">
        <JsonTreeNode value={data} lastElement initialExpanded />
      </div>
    </div>
  );
}
