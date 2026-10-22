/**
 * Resolves the brand icon for an OpenRouter-style model id
 * (`<provider>/<model>`). Used inside the Provider step's form (next
 * to the model input) and the skip-card (next to the persisted model
 * label) so the operator gets an immediate, visual confirmation of
 * which engine they're targeting.
 *
 * Mapping is hardcoded - small, predictable, and CSP-friendly (no
 * dynamic require/import; bundle stays static). Unknown prefixes fall
 * back to a generic `IconBrainCircuit` so the UI never goes blank.
 * Every mark reads on both papers: one-ink marks draw in `currentColor`
 * (the row's ink), colour marks keep their own colours.
 *
 * `parseModelProvider` lives in a sibling file so the parsing logic
 * has its own unit tests (`__tests__/parseModelProvider.test.ts`).
 */

import { useMemo, type JSX, type SVGProps } from "react";
import { IconBrainCircuit } from "../../../../components/icons/index.js";
import {
  Anthropic,
  Claude,
  Cohere,
  Deepseek,
  Fireworks,
  Gemini,
  Google,
  Groq,
  HuggingFace,
  Meta,
  Mistral,
  Ollama,
  Openai,
  Openrouter,
  Perplexity,
  Qwen,
  Replicate,
  Xai,
} from "@thesvg/react";

import { parseModelProvider } from "./parseModelProvider.js";

type MarkProps = SVGProps<SVGSVGElement> & { readonly "data-vex-brand-mark"?: string };
/** Draws one brand mark with the given svg props. */
type BrandMark = (props: MarkProps) => JSX.Element;

/**
 * A one-ink mark is drawn in its `currentColor` variant ("light" or "mono"
 * in the package), so it takes the row's ink token and reads in both rooms.
 * The package's default for those marks paints a white path (`#fff`) or a
 * fixed near-black one, which vanishes on the light paper or on the night
 * paper (measured in the installed `@thesvg/react` sources). Colour marks
 * keep their default.
 */
const OPENAI: BrandMark = (props) => <Openai variant="light" {...props} />;
const OPENROUTER: BrandMark = (props) => <Openrouter variant="mono" {...props} />;
/** Grok is xAI's model; xAI's mark is one ink, the package's Grok mark is white only. */
const XAI: BrandMark = (props) => <Xai {...props} />;
const CLAUDE: BrandMark = (props) => <Claude {...props} />;
const HUGGING_FACE: BrandMark = (props) => <HuggingFace {...props} />;
const META: BrandMark = (props) => <Meta {...props} />;
const MISTRAL: BrandMark = (props) => <Mistral {...props} />;

/**
 * Provider prefix (always lowercase, as returned by `parseModelProvider`)
 * → brand mark. Aliases coexist intentionally - e.g. `anthropic/claude-*`
 * should land on the Claude wordmark rather than the generic Anthropic
 * monogram, but a raw `claude/*` (rare on OpenRouter) is still covered.
 * Together AI has no mark here: the package draws it as a near-white
 * wordmark (2159 x 501) that cannot be read at 16 px on light paper, so it
 * takes the generic glyph.
 */
const MODEL_PROVIDER_ICONS: Readonly<Record<string, BrandMark>> = {
  anthropic: CLAUDE,
  claude: CLAUDE,
  cohere: (props) => <Cohere {...props} />,
  deepseek: (props) => <Deepseek {...props} />,
  fireworks: (props) => <Fireworks {...props} />,
  gemini: (props) => <Gemini {...props} />,
  google: (props) => <Google {...props} />,
  grok: XAI,
  groq: (props) => <Groq {...props} />,
  "hugging-face": HUGGING_FACE,
  huggingface: HUGGING_FACE,
  meta: META,
  "meta-llama": META,
  mistral: MISTRAL,
  mistralai: MISTRAL,
  ollama: (props) => <Ollama variant="mono" {...props} />,
  openai: OPENAI,
  openrouter: OPENROUTER,
  perplexity: (props) => <Perplexity {...props} />,
  qwen: (props) => <Qwen variant="light" {...props} />,
  replicate: (props) => <Replicate variant="mono" {...props} />,
  xai: XAI,
  "x-ai": XAI,
};

/** OpenRouter's own mark in one ink (the provider choice draws it beside its name). */
export function OpenRouterMark({ size = 16, className }: { readonly size?: number; readonly className?: string }): JSX.Element {
  return OPENROUTER({
    width: size,
    height: size,
    "aria-hidden": true,
    focusable: false,
    className,
    "data-vex-brand-mark": "openrouter",
  });
}

export interface ModelBrandIconProps {
  readonly modelId: string;
  readonly size?: number;
  readonly className?: string;
}

export function ModelBrandIcon({
  modelId,
  size = 18,
  className,
}: ModelBrandIconProps): JSX.Element {
  const provider = useMemo(() => parseModelProvider(modelId), [modelId]);
  const mark = provider !== null ? MODEL_PROVIDER_ICONS[provider] : undefined;

  if (mark !== undefined && provider !== null) {
    return mark({
      width: size,
      height: size,
      "aria-hidden": true,
      focusable: false,
      className,
      "data-vex-brand-mark": provider,
    });
  }
  return (
    <IconBrainCircuit
      size={size}
      className={className} />
  );
}
