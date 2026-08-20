/**
 * Resolves the brand icon for an OpenRouter-style model id
 * (`<provider>/<model>`). Used inside the Provider step's form (next
 * to the model input) and the skip-card (next to the persisted model
 * label) so the operator gets an immediate, visual confirmation of
 * which engine they're targeting.
 *
 * Mapping is hardcoded — small, predictable, and CSP-friendly (no
 * dynamic require/import; bundle stays static). Unknown prefixes fall
 * back to a generic `IconBrainCircuit` so the UI never goes blank.
 *
 * `parseModelProvider` lives in a sibling file so the parsing logic
 * has its own unit tests (`__tests__/parseModelProvider.test.ts`).
 */

import { useMemo, type ComponentType, type SVGProps } from "react";
import { IconBrainCircuit } from "../../../../components/icons/index.js";
import {
  Anthropic,
  Claude,
  Cohere,
  Deepseek,
  Fireworks,
  Gemini,
  Google,
  Grok,
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
  TogetherAi,
  Xai,
} from "@thesvg/react";

import { parseModelProvider } from "./parseModelProvider.js";

type SvgIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Provider prefix (always lowercase, as returned by `parseModelProvider`)
 * → brand icon. Aliases coexist intentionally — e.g. `anthropic/claude-*`
 * should land on the Claude wordmark rather than the generic Anthropic
 * monogram, but a raw `claude/*` (rare on OpenRouter) is still covered.
 */
const MODEL_PROVIDER_ICONS: Readonly<Record<string, SvgIcon>> = {
  anthropic: Claude,
  claude: Claude,
  cohere: Cohere,
  deepseek: Deepseek,
  fireworks: Fireworks,
  gemini: Gemini,
  google: Google,
  grok: Grok,
  groq: Groq,
  "hugging-face": HuggingFace,
  huggingface: HuggingFace,
  meta: Meta,
  "meta-llama": Meta,
  mistral: Mistral,
  mistralai: Mistral,
  ollama: Ollama,
  openai: Openai,
  openrouter: Openrouter,
  perplexity: Perplexity,
  qwen: Qwen,
  replicate: Replicate,
  "together-ai": TogetherAi,
  togetherai: TogetherAi,
  together: TogetherAi,
  xai: Xai,
  "x-ai": Xai,
};

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
  const BrandIcon = provider !== null ? MODEL_PROVIDER_ICONS[provider] : undefined;

  if (BrandIcon) {
    return (
      <BrandIcon
        width={size}
        height={size}
        aria-hidden
        focusable={false}
        className={className}
      />
    );
  }
  return (
    <IconBrainCircuit
      size={size}
      className={className} />
  );
}
