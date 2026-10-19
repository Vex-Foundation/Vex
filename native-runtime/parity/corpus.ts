/**
 * The embedding parity corpus: what the app actually sends to the embeddings
 * server, built through the production formatters.
 *
 *   - tool:     every re-embeddable protocol tool, through `pickSourceText` +
 *               `formatToolInput` (the discovery rerank write path),
 *   - query:    every authored tool-discovery query, through
 *               `formatQueryInput` (the recall path),
 *   - document: knowledge-entry shaped inputs through `formatDocumentInput`,
 *               cut from the repo's own prose and code at lengths spread up to
 *               the document budget, plus multilingual text and the
 *               UUID/timestamp-dense scaffolding memory chunks carry.
 *
 * Deterministic: the same checkout always yields the same items in the same
 * order, so two parity runs are comparable.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  formatDocumentInput,
  formatQueryInput,
  formatToolInput,
} from "@vex-agent/embeddings/client.js";
import { EMBEDDING_DOCUMENT_MAX_CHARS } from "@vex-agent/embeddings/document-size-budget.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { pickSourceText } from "@vex-agent/tools/protocols/embeddings/reembed.js";
import { isReembeddableNamespace } from "@vex-agent/tools/protocols/lifecycle.js";

export type ParityKind = "tool" | "query" | "document";

export interface ParityItem {
  readonly id: string;
  readonly kind: ParityKind;
  readonly input: string;
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const DATASETS_DIR = join(REPO_ROOT, "src", "__tests__", "eval", "datasets");

/** Formatted-input lengths the prose and code documents are cut to. */
const DOCUMENT_TARGET_CHARS = [60, 160, 320, 640, 960, 1200, EMBEDDING_DOCUMENT_MAX_CHARS] as const;

const MAX_SECTIONS_PER_SOURCE = 40;

const PROSE_SOURCES = [
  "README.md",
  "SECURITY.md",
  "VEX_STUDIO.md",
  "vex-app/docs/LOCAL_RUNTIME.md",
  "vex-app/docs/SCALING.md",
] as const;

const CODE_SOURCES = [
  "src/vex-agent/embeddings/client.ts",
  "src/vex-agent/db/migrations/001_initial.sql",
  "bridge/go.mod",
] as const;

/** Memory-shaped sentences in the languages users actually write in. */
const MULTILINGUAL: ReadonlyArray<readonly [string, string]> = [
  ["Preferencje użytkownika", "Użytkownik woli wymieniać USDC na ETH tylko wtedy, gdy opłata za gaz jest poniżej 5 gwei, i prosi o potwierdzenie przed każdą transakcją powyżej 1000 dolarów."],
  ["Preferencias del usuario", "El usuario quiere revisar su posición en Morpho cada lunes y recibir un aviso si el factor de salud baja de 1,3."],
  ["Nutzerpräferenzen", "Der Nutzer möchte keine Memecoins kaufen und bevorzugt Stablecoin-Pools mit geprüften Verträgen."],
  ["ユーザーの好み", "ユーザーはソラナ上の新しいトークンを購入する前に、流動性と保有者の分布を必ず確認したいと考えている。"],
  ["用户偏好", "用户希望每天早上收到其投资组合的摘要，并且只在价格波动超过百分之五时提醒。"],
  ["تفضيلات المستخدم", "يفضل المستخدم تحويل الأرباح إلى عملة مستقرة في نهاية كل أسبوع وعدم استخدام الرافعة المالية."],
  ["Предпочтения пользователя", "Пользователь хочет, чтобы агент никогда не подписывал транзакции без явного подтверждения в чате."],
  ["사용자 선호", "사용자는 수수료가 낮은 시간대에만 브리지를 사용하고 싶어 하며 결과를 표로 보고 싶어 한다."],
  ["Préférences", "L'utilisateur veut suivre ses positions Pendle et être prévenu sept jours avant chaque échéance."],
  ["Mixed", "Swap 0.5 ETH → USDC on Base 🚀 then bridge to Arbitrum; slippage ≤ 0.3 %, deadline 20 min. ✅"],
];

function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Cut to at most `max` characters without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** A document whose formatted input is as close to `target` as the text allows. */
function documentItem(id: string, title: string, body: string, target: number): ParityItem {
  const overhead = formatDocumentInput(title, "").length;
  const input = formatDocumentInput(title, clip(body, Math.max(1, target - overhead)));
  if (input.length > EMBEDDING_DOCUMENT_MAX_CHARS) {
    throw new Error(`${id}: ${input.length} chars exceeds the ${EMBEDDING_DOCUMENT_MAX_CHARS} budget`);
  }
  return { id, kind: "document", input };
}

function toolItems(): ParityItem[] {
  return PROTOCOL_TOOLS
    .filter((manifest) => isReembeddableNamespace(manifest.namespace))
    .map((manifest) => ({ manifest, text: pickSourceText(manifest) }))
    .filter(({ text }) => text.length > 0)
    .map(({ manifest, text }) => ({
      id: `tool:${manifest.toolId}`,
      kind: "tool" as const,
      input: formatToolInput(manifest.toolId, text),
    }));
}

function queryItems(): ParityItem[] {
  const seen = new Set<string>();
  const items: ParityItem[] = [];
  for (const file of readdirSync(DATASETS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(DATASETS_DIR, file), "utf8")) as {
      queries: ReadonlyArray<{ query: string }>;
    };
    for (const { query } of parsed.queries) {
      if (seen.has(query)) continue;
      seen.add(query);
      items.push({ id: `query:${items.length}`, kind: "query", input: formatQueryInput(query) });
    }
  }
  return items;
}

/** Paragraphs of a markdown file, each paired with its nearest heading. */
function proseSections(path: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string }> = [];
  let title = path;
  let buffer: string[] = [];
  const flush = (): void => {
    const body = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (body.length >= 200) sections.push({ title, body });
    buffer = [];
  };
  for (const line of readFileSync(join(REPO_ROOT, path), "utf8").split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) {
      flush();
      title = heading[1].trim();
    } else if (line.trim() === "" || line.startsWith("```")) {
      if (buffer.join(" ").length >= EMBEDDING_DOCUMENT_MAX_CHARS) flush();
    } else {
      buffer.push(line.trim());
    }
  }
  flush();
  return sections;
}

function documentItems(): ParityItem[] {
  const items: ParityItem[] = [];
  let n = 0;
  for (const path of PROSE_SOURCES) {
    // Evenly spaced, so one long document cannot crowd out the others.
    const sections = proseSections(path);
    const stride = Math.max(1, Math.ceil(sections.length / MAX_SECTIONS_PER_SOURCE));
    sections.filter((_, i) => i % stride === 0).forEach(({ title, body }, i) => {
      const target = DOCUMENT_TARGET_CHARS[n++ % DOCUMENT_TARGET_CHARS.length] ?? EMBEDDING_DOCUMENT_MAX_CHARS;
      items.push(documentItem(`prose:${path}#${i}`, title, body, target));
    });
  }
  for (const path of CODE_SOURCES) {
    const source = readFileSync(join(REPO_ROOT, path), "utf8");
    DOCUMENT_TARGET_CHARS.forEach((target, i) => {
      const offset = Math.floor((source.length * i) / DOCUMENT_TARGET_CHARS.length);
      items.push(documentItem(`code:${path}#${i}`, path, source.slice(offset), target));
    });
  }
  MULTILINGUAL.forEach(([title, body], i) => {
    items.push(documentItem(`lang:${i}`, title, body, EMBEDDING_DOCUMENT_MAX_CHARS));
    items.push({ id: `lang-query:${i}`, kind: "query", input: formatQueryInput(body.slice(0, 80)) });
  });
  // The scaffolding `renderBodyMd` wraps around a memory chunk: section
  // headers plus outstanding items carrying a UUID and an ISO timestamp.
  for (let i = 0; i < 12; i++) {
    const outstanding = Array.from({ length: 1 + (i % 5) }, (_, k) => {
      const at = new Date(Date.UTC(2026, i % 12, 1 + k, 9, 30 + k)).toISOString();
      return `- [${deterministicUuid(`chunk-${i}-${k}`)}] (${at}) follow up on the Base bridge transfer #${1000 + i * 7 + k}`;
    }).join("\n");
    const body = `## What happened\nSession ${i} reviewed open positions.\n## Outstanding\n${outstanding}`;
    items.push(documentItem(`chunk:${i}`, `Session ${deterministicUuid(`session-${i}`)}`, body, EMBEDDING_DOCUMENT_MAX_CHARS));
  }
  return items;
}

export function buildCorpus(): ParityItem[] {
  return [...toolItems(), ...queryItems(), ...documentItems()];
}
