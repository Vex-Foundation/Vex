/**
 * EmbeddingStep form fields — the 4 EMBEDDING_* inputs (Base URL, Model,
 * Dim, Provider tag). Extracted VERBATIM from `EmbeddingStep.tsx`
 * (god-file split); zero behavior change.
 *
 * DIM carries a numeric range hint; the `min`/`max` come from the shared
 * embedding constants. `form` + `setForm` are threaded from the parent so
 * the controlled-input semantics (and the `{ ...form, ... }` spread on each
 * change) stay identical to the inlined version.
 *
 * The Base URL placeholder is the bundled server's address where it has a
 * fixed one. The native runtime's server takes a port chosen at launch, and
 * Vex points itself at it, so there the placeholder only shows the shape of
 * an endpoint of your own.
 */

import type { Dispatch, JSX, SetStateAction } from "react";
import {
  buildEmbeddingBaseUrl,
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ALIAS,
  EMBEDDING_PROVIDER,
} from "@shared/embedding-defaults.js";
import {
  MAX_EMBEDDING_DIM,
  MIN_EMBEDDING_DIM,
} from "@vex-lib/embedding-constants.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import type { FormState } from "./form.js";

export interface EmbeddingFieldsProps {
  readonly form: FormState;
  readonly setForm: Dispatch<SetStateAction<FormState>>;
  /** Main runs the native runtime, whose embeddings port is chosen at launch. */
  readonly nativeRuntime?: boolean;
}

/** An endpoint of the user's own, by shape only. */
export const OWN_ENDPOINT_PLACEHOLDER = "https://embeddings.example.com/v1";

export function EmbeddingFields({
  form,
  setForm,
  nativeRuntime = false,
}: EmbeddingFieldsProps): JSX.Element {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-embed-baseurl">Base URL</Label>
        <Input
          id="vex-embed-baseurl"
          type="url"
          placeholder={nativeRuntime ? OWN_ENDPOINT_PLACEHOLDER : buildEmbeddingBaseUrl()}
          autoComplete="off"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          autoFocus
          className="h-11"
        />
        <p className="text-xs text-ink-tertiary">
          A non-local URL sends memory content to that endpoint.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-embed-model">Model</Label>
        <Input
          id="vex-embed-model"
          type="text"
          placeholder={EMBEDDING_MODEL_ALIAS}
          autoComplete="off"
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          className="h-11"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="vex-embed-dim">Dim</Label>
          <Input
            id="vex-embed-dim"
            type="number"
            inputMode="numeric"
            min={MIN_EMBEDDING_DIM}
            max={MAX_EMBEDDING_DIM}
            placeholder={String(EMBEDDING_DIM)}
            value={form.dim}
            onChange={(e) => setForm({ ...form, dim: e.target.value })}
            className="h-11"
          />
          <p className="text-xs text-ink-tertiary">
            {MIN_EMBEDDING_DIM}–{MAX_EMBEDDING_DIM}. Common: 384, 768, 1024,
            1536. Locks once memories exist - changing it later would
            strand them.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="vex-embed-provider">Provider tag</Label>
          <Input
            id="vex-embed-provider"
            type="text"
            placeholder={EMBEDDING_PROVIDER}
            autoComplete="off"
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value })}
            className="h-11"
          />
        </div>
      </div>
    </>
  );
}
