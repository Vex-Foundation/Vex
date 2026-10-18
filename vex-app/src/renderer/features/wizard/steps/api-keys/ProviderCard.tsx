/**
 * ProviderCard: the per-provider row of the API keys step
 * (docs/design/R3-MINIMAL.md section 10.3, the `.vex-wz-prov` row of
 * `global-css/wizard.css`).
 *
 * One row under a quiet rule, type only (no brand tile):
 *   - the head line: the provider name (an h3), what Vex uses the key for,
 *     and at the right the status as a swatch plus its word
 *   - optional longer how-to or caveat copy (`detail`)
 *   - optional "Get key" link (target="_blank", rel="noopener noreferrer")
 *   - body slot (children): the actual input or auto-setup section
 *
 * Status is a fill AND a word (`StateWord`): set is the solid fill, partial
 * the target, unset the empty outline. The word is the caller's own label.
 *
 * Kept generic on purpose: the providers differ in copy and link wiring but
 * the row is identical, so this primitive avoids a repeat inside the
 * provider-card bodies (rule 18, "stop duplication early").
 */

import type { JSX, ReactNode } from "react";
import { StateWord } from "../../../../components/ui/state-word.js";
import type { SwatchState } from "../../../../components/ui/swatch.js";

export type ProviderCardSlug =
  | "jupiter"
  | "tavily"
  | "rettiwt"
  | "relay"
  | "lighter-core-trading"
  | "lighter-rhc-trading";

export type ProviderCardStatusTone = "set" | "partial" | "unset";

export interface ProviderCardStatus {
  readonly tone: ProviderCardStatusTone;
  readonly label: string;
}

export interface ProviderCardGetKey {
  readonly url: string;
  readonly label: string;
}

export interface ProviderCardProps {
  readonly slug: ProviderCardSlug;
  readonly name: string;
  readonly status: ProviderCardStatus;
  /** One quiet sentence: what Vex uses this key for. */
  readonly description: ReactNode;
  /** Optional longer how-to / caveat copy under the head line. */
  readonly detail?: ReactNode;
  readonly getKey?: ProviderCardGetKey;
  readonly children: ReactNode;
}

/** The status tone as the swatch fill: set is done, partial awaiting. */
const TONE_SWATCH: Readonly<Record<ProviderCardStatusTone, SwatchState>> = {
  set: "done",
  partial: "awaiting",
  unset: "idle",
};

/** The row's status at the right of the head line: a swatch and its word. */
export function ProviderStatusWord({
  status,
}: {
  readonly status: ProviderCardStatus;
}): JSX.Element {
  return (
    <StateWord
      className="vex-wz-prov__st"
      state={TONE_SWATCH[status.tone]}
      word={status.label}
      data-set={status.tone === "set" ? "" : undefined}
    />
  );
}

function GetKeyLink({ getKey }: { getKey: ProviderCardGetKey }): JSX.Element {
  return (
    <a
      href={getKey.url}
      target="_blank"
      rel="noopener noreferrer"
      className="vex-wz-link self-start"
    >
      {getKey.label}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export function ProviderCard({
  slug,
  name,
  status,
  description,
  detail,
  getKey,
  children,
}: ProviderCardProps): JSX.Element {
  return (
    <section
      data-vex-apikeys-card={slug}
      aria-labelledby={`vex-apikeys-card-${slug}-name`}
      className="vex-wz-prov"
    >
      <div className="vex-wz-prov__h">
        <h3 id={`vex-apikeys-card-${slug}-name`} className="vex-wz-prov__n">
          {name}
        </h3>
        <p className="vex-wz-prov__dsc">{description}</p>
        <ProviderStatusWord status={status} />
      </div>
      {detail ? <p className="vex-wz-prov__detail">{detail}</p> : null}
      {getKey ? <GetKeyLink getKey={getKey} /> : null}
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}
